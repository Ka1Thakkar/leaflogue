import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import {
  syncOperationId,
  type ResolvedSyncChange,
  type SyncChangePage,
  type SyncCursor,
  type SyncedChange,
  type SyncedChangeOutcome,
} from "@leaflogue/contracts";
import { CONVEX_THREAD_CONTRACT_VERSION } from "./convex";
import { readBoundedConvexResponse, validateConvexDeploymentUrl } from "./convex-http";
import type { SyncBootstrapSource, SyncChangeSource, SyncPullPage, SyncSubmission, SyncTransport } from "./sync";

const DEFAULT_TIMEOUT_MS = 20_000;
/** Four state documents per pull stay below two MiB; leave headroom for encoding. */
const MAX_SYNC_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * Where and how to reach a deployment. The sync key is the operator-chosen
 * `LEAFLOGUE_SYNC_KEY`; it is sent only in function arguments over HTTPS and
 * never reaches the renderer.
 */
export interface ConvexSyncOptions {
  readonly deploymentUrl: string;
  readonly syncKey: string;
  /** The deployment's accepted contract; defaults to the newest this desktop speaks. */
  readonly mutationContractVersion?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export interface ConvexSyncSession {
  readonly libraryId: string;
  readonly deviceId: string;
}

export interface ConvexMigrationProgress {
  readonly updated: number;
  readonly detached: number;
}

export type ConvexMigrationPreparation =
  | ({ readonly status: "ready" } & ConvexMigrationProgress)
  | ({ readonly status: "incomplete" } & ConvexMigrationProgress)
  | ({
    readonly status: "review-required";
    readonly reviewNoteId: string;
    readonly reviewReason: "oversized" | "too-many";
  } & ConvexMigrationProgress);

type ConvexCursor = { readonly generation: number; readonly afterSequence: number };
type SessionArgs = { readonly libraryId: string; readonly syncKey: string };
const pushReference = makeFunctionReference<"mutation", SessionArgs & { deviceId: string; change: Record<string, unknown> }, SyncedChangeOutcome>(
  "syncRuntime:pushSyncedChange",
);
const bootstrapReference = makeFunctionReference<"query", SessionArgs, ConvexCursor>("syncRuntime:bootstrapCursor");
const validateReference = makeFunctionReference<"query", SessionArgs & { cursor: ConvexCursor }, boolean>(
  "syncRuntime:validateCursor",
);
const pullReference = makeFunctionReference<"query", SessionArgs & { cursor: ConvexCursor; limit: number }, {
  page: SyncChangePage;
  changes: Array<SyncedChange | null>;
}>("syncRuntime:pull");
const ensureLibraryReference = makeFunctionReference<"mutation", { syncKey: string }, { libraryId: string }>("syncRuntime:ensureLibrary");
type MigrationStep = {
  readonly status: "complete" | "progress" | "review-required";
  readonly migration?: "highlight-tag-books" | "daily-candidates" | "attached-notes" | "daily-projection" | "highlight-projection";
  readonly updated: number;
  readonly detached: number;
  readonly reviewNoteId?: string;
  readonly reviewReason?: "oversized" | "too-many";
};
const migrationReference = makeFunctionReference<"mutation", SessionArgs & { confirmDetachNoteId?: string }, MigrationStep>(
  "syncRuntime:runMigrationStep",
);
const DEFAULT_MAX_MIGRATION_STEPS = 100;

/** The deployment's one library, created on first use. */
export async function ensureConvexLibrary(options: ConvexSyncOptions, signal?: AbortSignal): Promise<string> {
  const result = await new ConvexConnection(options).call(signal, (client) => client.mutation(ensureLibraryReference, {
    syncKey: options.syncKey,
  }));
  if (typeof result?.libraryId !== "string" || !/^[0-9a-f-]{36}$/iu.test(result.libraryId)) {
    throw codedError("Convex returned an invalid library", "LEAFLOGUE_PROVIDER_PROTOCOL");
  }
  return result.libraryId;
}

/**
 * Drain a bounded number of idempotent deployment migrations before sync.
 * Review-required attached notes are never detached unless the caller repeats
 * the operation with that exact note ID.
 */
export async function prepareConvexLibrary(
  options: ConvexSyncOptions,
  libraryId: string,
  preparation: { readonly confirmDetachNoteId?: string; readonly maxSteps?: number } = {},
  signal?: AbortSignal,
): Promise<ConvexMigrationPreparation> {
  const maxSteps = preparation.maxSteps ?? DEFAULT_MAX_MIGRATION_STEPS;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 1_000) {
    throw new Error("Convex migration step bound is invalid");
  }
  if (preparation.confirmDetachNoteId !== undefined &&
      (preparation.confirmDetachNoteId.length < 1 || preparation.confirmDetachNoteId.length > 512)) {
    throw new Error("Convex migration confirmation is invalid");
  }
  const connection = new ConvexConnection(options);
  let updated = 0;
  let detached = 0;
  for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
    if (signal?.aborted) throw codedError("Convex migration was cancelled", "LEAFLOGUE_SYNC_CANCELLED");
    const result = validateMigrationStep(await connection.call(signal, (client) => client.mutation(migrationReference, {
      libraryId,
      syncKey: options.syncKey,
      ...(preparation.confirmDetachNoteId !== undefined && stepIndex === 0
        ? { confirmDetachNoteId: preparation.confirmDetachNoteId }
        : {}),
    })));
    updated = addMigrationTotal(updated, result.updated);
    detached = addMigrationTotal(detached, result.detached);
    if (result.status === "complete") return { status: "ready", updated, detached };
    if (result.status === "review-required") {
      return {
        status: "review-required", updated, detached,
        reviewNoteId: result.reviewNoteId!, reviewReason: result.reviewReason!,
      };
    }
  }
  return { status: "incomplete", updated, detached };
}

/**
 * Sync transport for a Convex deployment. Every call carries the deployment's
 * sync key; pushes also name this device, whose ID each change must match.
 *
 * Re-delivery is harmless for the same reason as PostgreSQL: a repeated change
 * presents the writer claim it already holds and is `superseded`.
 */
export class ConvexSyncTransport implements SyncTransport, SyncChangeSource, SyncBootstrapSource {
  readonly #connection: ConvexConnection;
  readonly #session: SessionArgs;
  readonly #deviceId: string;
  readonly #threadsSupported: boolean;

  constructor(options: ConvexSyncOptions & { readonly session: ConvexSyncSession }) {
    this.#connection = new ConvexConnection(options);
    this.#session = { libraryId: options.session.libraryId, syncKey: options.syncKey };
    this.#deviceId = options.session.deviceId;
    this.#threadsSupported = (options.mutationContractVersion ?? CONVEX_THREAD_CONTRACT_VERSION) >= CONVEX_THREAD_CONTRACT_VERSION;
  }

  async cancel(): Promise<void> {
    this.#connection.cancel();
  }

  /** Apply in order, one provider transaction each; stop at the first failure and report what landed. */
  async submit(changes: readonly ResolvedSyncChange[], signal?: AbortSignal): Promise<SyncSubmission> {
    const operationIds: string[] = [];
    for (const { change, entries } of changes) {
      if (signal?.aborted) break;
      // An older adjacent backend cannot store threads or a passage's thread
      // membership. Hold those changes (unacknowledged) rather than send a
      // passage without its threads and lose them.
      if (!this.#threadsSupported && (change.entityType === "thread" ||
          (change.entityType === "highlight" && change.operation === "upsert") ||
          change.entityType === "daily-selection" ||
          (change.entityType === "book" && change.operation === "upsert" && (change.statusEvents?.length ?? 0) > 0))) {
        return { operationIds, failure: codedError("Update the Convex deployment to sync threads, passages, reading history, and daily picks", "LEAFLOGUE_CONVEX_UPGRADE_REQUIRED") };
      }
      try {
        const payload = convexSyncedChange(change);
        // A contract-22 backend has no history field; only an empty one reaches here.
        if (!this.#threadsSupported) delete payload.statusEvents;
        const outcome = await this.#connection.call(signal, (client) => client.mutation(pushReference, {
          ...this.#session, deviceId: this.#deviceId, change: payload,
        }));
        if (outcome !== "applied" && outcome !== "superseded") {
          throw codedError("Convex returned an invalid sync outcome", "LEAFLOGUE_PROVIDER_PROTOCOL");
        }
      } catch (failure) {
        return { operationIds, failure };
      }
      operationIds.push(...entries.map(syncOperationId));
    }
    return { operationIds };
  }

  async bootstrapCursor(signal?: AbortSignal): Promise<SyncCursor> {
    return this.#connection.call(signal, (client) => client.query(bootstrapReference, { ...this.#session }));
  }

  async validateCursor(cursor: SyncCursor, signal?: AbortSignal): Promise<boolean> {
    const valid = await this.#connection.call(signal, (client) => client.query(validateReference, {
      ...this.#session, cursor: convexCursor(cursor),
    }));
    return valid === true;
  }

  /** `null` slots mean the provider cannot express that change; the caller stops before it. */
  async pull(cursor: SyncCursor, limit: number, signal?: AbortSignal): Promise<SyncPullPage> {
    const result = await this.#connection.call(signal, (client) => client.query(pullReference, {
      ...this.#session, cursor: convexCursor(cursor), limit,
    }));
    if (!result || typeof result !== "object" || !Array.isArray(result.changes)) {
      throw codedError("Convex returned an invalid sync page", "LEAFLOGUE_PROVIDER_PROTOCOL");
    }
    // An older backend's passages carry no thread membership; leaving it
    // absent tells the local library to keep the links it already has.
    return { page: result.page, changes: result.changes.map((change) => change ?? undefined) };
  }
}

/**
 * One HTTP client per transport. The bounded fetch refuses redirects and origin
 * changes, and each call combines its own timeout, the caller's signal, and
 * transport cancellation.
 */
class ConvexConnection {
  readonly #client: ConvexHttpClient;
  readonly #cancelled = new AbortController();
  #callSignal: AbortSignal | undefined;

  constructor(options: ConvexSyncOptions) {
    const url = validateConvexDeploymentUrl(options.deploymentUrl);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new Error("Convex timeout is invalid");
    const request = options.fetch ?? globalThis.fetch;
    const origin = new URL(url).origin;
    this.#client = new ConvexHttpClient(url, {
      skipConvexDeploymentUrlCheck: true,
      logger: false,
      fetch: async (input, init) => {
        const signals = [AbortSignal.timeout(timeoutMs), this.#cancelled.signal];
        if (this.#callSignal) signals.push(this.#callSignal);
        const response = await request(input, { ...init, redirect: "error", signal: AbortSignal.any(signals) });
        return readBoundedConvexResponse(response, origin, MAX_SYNC_RESPONSE_BYTES);
      },
    });
  }

  cancel(): void {
    this.#cancelled.abort();
  }

  /** Calls are sequential by construction: the runner awaits each before the next. */
  async call<T>(signal: AbortSignal | undefined, operation: (client: ConvexHttpClient) => Promise<T>): Promise<T> {
    if (this.#cancelled.signal.aborted) throw codedError("Convex transport was cancelled", "LEAFLOGUE_SYNC_CANCELLED");
    this.#callSignal = signal;
    try {
      return await operation(this.#client);
    } catch (error) {
      throw classifyConvexFailure(error);
    } finally {
      this.#callSignal = undefined;
    }
  }
}

/**
 * Keep only the provider's stable code. Convex error text can quote reading
 * data or deployment internals, so the thrown error carries a fixed message.
 */
function classifyConvexFailure(error: unknown): Error {
  if (error instanceof Error && "code" in error && typeof error.code === "string" && error.code.startsWith("LEAFLOGUE_")) {
    return error;
  }
  if (error instanceof ConvexError && typeof error.data === "object" && error.data !== null &&
      typeof (error.data as { code?: unknown }).code === "string") {
    const code = (error.data as { code: string }).code;
    if (/^LEAFLOGUE_[A-Z_]{1,60}$/u.test(code)) return codedError("The Convex deployment refused the sync call", code);
  }
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return codedError("The Convex call did not finish", "ETIMEDOUT");
  }
  if (error instanceof TypeError) return codedError("Leaflogue could not reach the Convex deployment", "ECONNREFUSED");
  return codedError("The Convex deployment failed the sync call", "LEAFLOGUE_PROVIDER_FAILED");
}

function codedError(message: string, code: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}

function validateMigrationStep(value: MigrationStep): MigrationStep {
  if (!value || typeof value !== "object") {
    throw codedError("Convex returned invalid migration progress", "LEAFLOGUE_PROVIDER_PROTOCOL");
  }
  if (value.status === "complete" && hasExactKeys(value, ["status", "updated", "detached"]) &&
      value.updated === 0 && value.detached === 0) return value;
  if (value.status === "progress" && hasExactKeys(value, ["status", "migration", "updated", "detached"]) &&
      isValidMigrationCount(value.updated) && isValidMigrationCount(value.detached) &&
      validProgressCounts(value.migration, value.updated, value.detached)) return value;
  if (value.status === "review-required" && value.migration === "attached-notes" &&
      hasExactKeys(value, ["status", "migration", "updated", "detached", "reviewNoteId", "reviewReason"]) &&
      value.updated === 0 && value.detached === 0 &&
      typeof value.reviewNoteId === "string" && value.reviewNoteId.length > 0 && value.reviewNoteId.length <= 512 &&
      (value.reviewReason === "oversized" || value.reviewReason === "too-many")) return value;
  throw codedError("Convex returned invalid migration progress", "LEAFLOGUE_PROVIDER_PROTOCOL");
}

function validProgressCounts(migration: MigrationStep["migration"], updated: number, detached: number): boolean {
  if (migration === "highlight-tag-books" || migration === "daily-candidates" || migration === "daily-projection") {
    return updated <= 50 && detached === 0;
  }
  if (migration === "attached-notes") return updated === 1 && (detached === 0 || detached === 1);
  if (migration === "highlight-projection") return updated <= 1 && detached === 0;
  return false;
}

function isValidMigrationCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function addMigrationTotal(total: number, increment: number): number {
  const next = total + increment;
  if (!Number.isSafeInteger(next)) {
    throw codedError("Convex returned invalid migration progress", "LEAFLOGUE_PROVIDER_PROTOCOL");
  }
  return next;
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && keys.every((key, index) => actual[index] === [...keys].sort()[index]);
}

function convexCursor(cursor: SyncCursor): ConvexCursor {
  return { generation: cursor.generation, afterSequence: cursor.afterSequence };
}

/**
 * Project a local change onto the exact provider validator shape. Convex
 * validators reject unknown fields, and local snapshots may carry more than
 * the wire contract (for example a passage's attached notes).
 */
export function convexSyncedChange(change: SyncedChange): Record<string, unknown> {
  const claim = { entityType: change.entityType, operation: change.operation, deviceId: change.deviceId, deviceRevision: change.deviceRevision };
  if (change.operation === "tombstone") {
    return change.entityType === "highlight" || change.entityType === "note"
      ? { ...claim, entityId: change.entityId, bookId: change.bookId }
      : { ...claim, entityId: change.entityId };
  }
  if (change.entityType === "book") {
    const book = change.book;
    return { ...claim, collectionIds: [...change.collectionIds], tagIds: [...change.tagIds],
      statusEvents: (change.statusEvents ?? []).map((event) => defined({
        id: event.id, bookId: event.bookId, status: event.status, source: event.source, changedAt: event.changedAt,
        completedOn: event.completedOn, bookRevision: event.bookRevision,
      })), book: defined({
      id: book.id, title: book.title, authors: [...book.authors], description: book.description,
      publisher: book.publisher, series: book.series, seriesNumber: book.seriesNumber, language: book.language,
      isbn13: book.isbn13, coverUrl: book.coverUrl, status: book.status, completedOn: book.completedOn,
      archived: book.archived, createdAt: book.createdAt, updatedAt: book.updatedAt, revision: book.revision,
      highlightCount: book.highlightCount,
    }) };
  }
  if (change.entityType === "highlight") {
    const highlight = change.highlight;
    // A local snapshot always carries membership; an empty list would erase it.
    if (change.threadIds === undefined) throw codedError("A passage snapshot has no thread membership", "LEAFLOGUE_PROVIDER_PROTOCOL");
    return { ...claim, tagIds: [...change.tagIds], threadIds: [...change.threadIds], highlight: defined({
      id: highlight.id, bookId: highlight.bookId, text: highlight.text, sourceLocation: highlight.sourceLocation,
      sourceCreatedAt: highlight.sourceCreatedAt, createdAt: highlight.createdAt, updatedAt: highlight.updatedAt,
      revision: highlight.revision,
    }) };
  }
  if (change.entityType === "note") {
    const note = change.note;
    return { ...claim, note: defined({
      id: note.id, bookId: note.bookId, highlightId: note.highlightId, markdown: note.markdown, origin: note.origin,
      createdAt: note.createdAt, updatedAt: note.updatedAt, revision: note.revision,
    }) };
  }
  if (change.entityType === "collection") {
    const collection = change.collection;
    return { ...claim, collection: defined({
      id: collection.id, name: collection.name, description: collection.description, bookCount: collection.bookCount,
      createdAt: collection.createdAt, updatedAt: collection.updatedAt, revision: collection.revision,
    }) };
  }
  if (change.entityType === "thread") {
    const thread = change.thread;
    return { ...claim, thread: defined({
      id: thread.id, name: thread.name, description: thread.description, passageCount: thread.passageCount,
      createdAt: thread.createdAt, updatedAt: thread.updatedAt, revision: thread.revision,
    }) };
  }
  if (change.entityType === "daily-selection") {
    const pick = change.dailySelection;
    return { ...claim, dailySelection: defined({
      id: pick.id, localDay: pick.localDay, timezone: pick.timezone, highlightId: pick.highlightId,
      candidateDigest: pick.candidateDigest, recentHighlightIds: [...pick.recentHighlightIds],
      selectedAt: pick.selectedAt, updatedAt: pick.updatedAt, revision: pick.revision, createdAt: pick.createdAt,
    }) };
  }
  const tag = change.tag;
  return { ...claim, tag: defined({
    id: tag.id, name: tag.name, color: tag.color, bookCount: tag.bookCount, highlightCount: tag.highlightCount,
    createdAt: tag.createdAt, updatedAt: tag.updatedAt, revision: tag.revision,
  }) };
}

function defined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
}
