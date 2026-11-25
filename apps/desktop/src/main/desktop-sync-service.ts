import type { NoteId, SyncProgress, SyncRunOptions, SyncRunResult } from "@leaflogue/contracts";
import {
  PostgresSyncTransport,
  assertCurrentPostgresSchema,
  ensurePostgresSyncLibrary,
  type ConvexMigrationPreparation,
  type PostgresClient,
  type RemoteConfig,
  type SyncBootstrapSource,
  type SyncChangeSource,
  type SyncTransport,
} from "@leaflogue/remote";
import type { LocalLibrary } from "@leaflogue/storage";
import { createSyncRunner, describeSyncProblem, runUntilSettled, type SyncRunner } from "./sync-runner";

const EMPTY_COUNTS = { bootstrapped: 0, pushed: 0, superseded: 0, pulled: 0 } as const;

export interface DesktopSyncService {
  readonly isRunning: boolean;
  run(options?: SyncRunOptions): Promise<SyncRunResult>;
  shutdown(): Promise<void>;
}

export function createDesktopSyncService(options: {
  readonly getLibrary: () => LocalLibrary | undefined;
  readonly readConfig: () => RemoteConfig | undefined;
  readonly createPostgresClient: (connectionString: string) => PostgresClient;
  readonly onProgress?: (progress: SyncProgress) => void;
  /** Key-authorized Convex transport for this device; its failures carry sync problem codes. */
  readonly createConvexTransport?: (
    config: Extract<RemoteConfig, { provider: "convex" }>,
    deviceId: string,
    options: SyncRunOptions,
    signal: AbortSignal,
  ) => Promise<{
    readonly transport: SyncTransport & SyncChangeSource & SyncBootstrapSource;
    readonly migration: ConvexMigrationPreparation;
  }>;
}): DesktopSyncService {
  let inFlight: Promise<SyncRunResult> | undefined;
  let runner: SyncRunner | undefined;
  let activeClient: PostgresClient | undefined;
  let activePreparation: AbortController | undefined;
  let shuttingDown = false;

  const report = (progress: SyncProgress) => { try { options.onProgress?.(progress); } catch { /* Status observers cannot stop sync. */ } };
  const fail = (problem: SyncRunResult & { status: "failed" }): SyncRunResult => problem;
  const pass = async (runOptions: SyncRunOptions): Promise<SyncRunResult> => {
    const library = options.getLibrary();
    if (!library) return fail({ ...EMPTY_COUNTS, status: "failed", problem: {
      phase: "connect", kind: "stopped", message: "The local library is unavailable.",
    } });
    report({ ...EMPTY_COUNTS, phase: "connect", remaining: library.countPendingSyncChanges() });
    let config: RemoteConfig | undefined;
    try {
      config = options.readConfig();
    } catch {
      return fail({ ...EMPTY_COUNTS, status: "failed", problem: {
        phase: "connect", kind: "configuration", message: "Leaflogue could not read the sync configuration.",
      } });
    }
    if (config?.provider === "convex") return runConvex(library, config, runOptions);
    if (!config || config.provider !== "postgres") return fail({ ...EMPTY_COUNTS, status: "failed", problem: {
      phase: "connect", kind: "configuration", message: "Configure a sync provider before synchronizing.",
    } });

    const rawClient = options.createPostgresClient(config.connectionString);
    let closed = false;
    const closeClient = async () => {
      if (closed) return;
      closed = true;
      await rawClient.end();
    };
    const client: PostgresClient = {
      connect: () => rawClient.connect(),
      query: (text, values) => rawClient.query(text, values),
      end: closeClient,
    };
    activeClient = client;
    try {
      await client.connect();
      if (shuttingDown) return { ...EMPTY_COUNTS, status: "cancelled" };
      report({ ...EMPTY_COUNTS, phase: "prepare", remaining: library.countPendingSyncChanges() });
      await assertCurrentPostgresSchema(client);
      if (shuttingDown) return { ...EMPTY_COUNTS, status: "cancelled" };
      const libraryId = await ensurePostgresSyncLibrary(client, library.getSyncState().deviceId);
      if (shuttingDown) return { ...EMPTY_COUNTS, status: "cancelled" };
      const transport = new PostgresSyncTransport(client, libraryId);
      runner = createSyncRunner({ ledger: library, transport, onProgress: report });
      const result = await runUntilSettled(runner);
      return result;
    } catch (error) {
      return { ...EMPTY_COUNTS, status: shuttingDown ? "cancelled" : "failed",
        ...(shuttingDown ? {} : { problem: describeSyncProblem("connect", error) }) } as SyncRunResult;
    } finally {
      runner = undefined;
      await client.end().catch(() => undefined);
      if (activeClient === client) activeClient = undefined;
    }
  };

  const runConvex = async (
    library: LocalLibrary,
    config: Extract<RemoteConfig, { provider: "convex" }>,
    runOptions: SyncRunOptions,
  ): Promise<SyncRunResult> => {
    if (!options.createConvexTransport) return fail({ ...EMPTY_COUNTS, status: "failed", problem: {
      phase: "connect", kind: "configuration", message: "Convex synchronization is unavailable in this build.",
    } });
    report({ ...EMPTY_COUNTS, phase: "prepare", remaining: library.countPendingSyncChanges() });
    let prepared: Awaited<ReturnType<NonNullable<typeof options.createConvexTransport>>>;
    const preparation = new AbortController();
    activePreparation = preparation;
    try {
      prepared = await options.createConvexTransport(
        config,
        library.getSyncState().deviceId,
        runOptions,
        preparation.signal,
      );
    } catch (error) {
      if (shuttingDown) return { ...EMPTY_COUNTS, status: "cancelled" };
      return { ...EMPTY_COUNTS, status: "failed", problem: describeSyncProblem("connect", error) };
    } finally {
      if (activePreparation === preparation) activePreparation = undefined;
    }
    if (shuttingDown) return { ...EMPTY_COUNTS, status: "cancelled" };
    if (prepared.migration.status === "incomplete") {
      return { ...EMPTY_COUNTS, status: "migration-incomplete", migration: prepared.migration };
    }
    if (prepared.migration.status === "review-required") {
      return { ...EMPTY_COUNTS, status: "migration-review-required", migration: {
        updated: prepared.migration.updated,
        detached: prepared.migration.detached,
        reviewNoteId: prepared.migration.reviewNoteId as NoteId,
        reviewReason: prepared.migration.reviewReason,
      } };
    }
    runner = createSyncRunner({ ledger: library, transport: prepared.transport, onProgress: report });
    try {
      const result = await runUntilSettled(runner);
      return prepared.migration.updated > 0 || prepared.migration.detached > 0
        ? { ...result, migration: prepared.migration }
        : result;
    } finally {
      runner = undefined;
    }
  };

  return {
    get isRunning() { return inFlight !== undefined; },
    run(runOptions = {}) {
      if (shuttingDown) return Promise.resolve({ ...EMPTY_COUNTS, status: "cancelled" });
      inFlight ??= pass(runOptions).finally(() => { inFlight = undefined; });
      return inFlight;
    },
    async shutdown() {
      shuttingDown = true;
      if (runner) await runner.shutdown();
      else if (activePreparation) activePreparation.abort();
      else await activeClient?.end().catch(() => undefined);
      await inFlight;
    },
  };
}
