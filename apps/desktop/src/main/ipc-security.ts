import { MAX_HIGHLIGHT_PAGE, MAX_HIGHLIGHT_SEARCH_LENGTH } from "@leaflogue/contracts";
import type { AiSettingsInput, CommitImport, HighlightQuery, DeleteThread, EnsureDailyHighlight, NewThread, NoteId, ReadingStatusEvent, ReadingStatusHistoryPage, ResolveImportConflict, ResolveSyncConflict, SetBookCompletionDate, SetBookReadingStatus, SetHighlightThreadMembership, SyncRunOptions, UpdateThread } from "@leaflogue/contracts";

const MAX_DESKTOP_STATUS_EVENTS = 100;

interface IpcEventLike {
  readonly senderFrame?: { readonly url: string } | null;
}

interface IpcRegistrar {
  handle(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => unknown): void;
}

export function registerTrustedHandler(
  registrar: IpcRegistrar,
  channel: string,
  isPackaged: () => boolean,
  handler: (...args: unknown[]) => unknown,
): void {
  registrar.handle(channel, (event, ...args) => {
    assertTrustedSenderUrl(event.senderFrame?.url, isPackaged());
    return handler(...args);
  });
}

export function assertTrustedSenderUrl(senderUrl: string | undefined, packaged: boolean): void {
  if (!senderUrl) throw new Error("Untrusted application request");
  let url: URL;
  try {
    url = new URL(senderUrl);
  } catch {
    throw new Error("Untrusted application request");
  }
  const trustedPackaged = url.protocol === "leaflogue:" && url.hostname === "app";
  const trustedDevelopment =
    !packaged &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
    (url.protocol === "http:" || url.protocol === "https:");
  if (!trustedPackaged && !trustedDevelopment) throw new Error("Untrusted application request");
}

export function validateCommitImport(value: unknown): CommitImport {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Import review is invalid");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.token !== "string" || !isUuid(input.token) ||
      typeof input.sourceId !== "string" || !isUuid(input.sourceId)) {
    throw new Error("Import review is invalid");
  }
  if (input.newSourceName !== undefined &&
      (typeof input.newSourceName !== "string" || !input.newSourceName.trim() || input.newSourceName.length > 200)) {
    throw new Error("Import source name is invalid");
  }
  return {
    token: input.token,
    sourceId: input.sourceId,
    ...(typeof input.newSourceName === "string" ? { newSourceName: input.newSourceName.trim() } : {}),
  };
}

export function validateConflictResolution(value: unknown): ResolveImportConflict {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Import conflict resolution is invalid");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.id !== "string" || !isUuid(input.id) ||
      (input.resolution !== "keep-local" && input.resolution !== "use-incoming")) {
    throw new Error("Import conflict resolution is invalid");
  }
  return { id: input.id as ResolveImportConflict["id"], resolution: input.resolution };
}

export function validateSyncConflictResolution(value: unknown): ResolveSyncConflict {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Sync conflict resolution is invalid");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.id !== "string" || !isUuid(input.id) ||
      (input.resolution !== "restore" && input.resolution !== "discard") ||
      typeof input.expectedRevision !== "number" || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new Error("Sync conflict resolution is invalid");
  }
  return { id: input.id as ResolveSyncConflict["id"], resolution: input.resolution, expectedRevision: input.expectedRevision };
}

export function validateSyncRunOptions(value: unknown): SyncRunOptions {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Sync options are invalid");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "confirmDetachNoteId") ||
      (input.confirmDetachNoteId !== undefined &&
        (typeof input.confirmDetachNoteId !== "string" || input.confirmDetachNoteId.length < 1 ||
          input.confirmDetachNoteId.length > 512))) {
    throw new Error("Sync options are invalid");
  }
  return typeof input.confirmDetachNoteId === "string"
    ? { confirmDetachNoteId: input.confirmDetachNoteId as NoteId }
    : {};
}

export function validateSetBookReadingStatus(value: unknown): SetBookReadingStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Reading status is invalid");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.id !== "string" || !isUuid(input.id) ||
      (input.status !== "unread" && input.status !== "reading" && input.status !== "finished" && input.status !== "paused") ||
      typeof input.expectedRevision !== "number" || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new Error("Reading status is invalid");
  }
  return {
    id: input.id as SetBookReadingStatus["id"],
    status: input.status,
    expectedRevision: input.expectedRevision,
  };
}

export function validateSetBookCompletionDate(value: unknown): SetBookCompletionDate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Completion date is invalid");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.id !== "string" || !isUuid(input.id) ||
      (input.completedOn !== undefined && (typeof input.completedOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(input.completedOn))) ||
      typeof input.expectedRevision !== "number" || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new Error("Completion date is invalid");
  }
  return {
    id: input.id as SetBookCompletionDate["id"],
    ...(typeof input.completedOn === "string" ? { completedOn: input.completedOn } : {}),
    expectedRevision: input.expectedRevision,
  };
}

/** Only credential-free https links written in notes may leave the app. */
export function validateExternalUrl(value: unknown): URL {
  if (typeof value !== "string" || !value || value.length > 2_048) throw new Error("Link is invalid");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Link is invalid");
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) throw new Error("Only https links can be opened");
  return url;
}

export function validateHighlightQuery(value: unknown): HighlightQuery {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Highlight query is invalid");
  }
  const input = value as Record<string, unknown>;
  const allowedKeys = new Set(["bookId", "search", "source", "notes", "tagId", "dateKind", "dateFrom", "dateBefore", "sort", "offset", "limit"]);
  const optionalUuid = (key: string) => input[key] === undefined || (typeof input[key] === "string" && isUuid(input[key]));
  const optionalChoice = (key: string, choices: readonly string[]) =>
    input[key] === undefined || (typeof input[key] === "string" && choices.includes(input[key]));
  const optionalInteger = (key: string, minimum: number, maximum: number) => input[key] === undefined ||
    (typeof input[key] === "number" && Number.isSafeInteger(input[key]) && input[key] >= minimum && input[key] <= maximum);
  if (Object.keys(input).some((key) => !allowedKeys.has(key)) ||
      !optionalUuid("bookId") || !optionalUuid("tagId") ||
      (input.search !== undefined && (typeof input.search !== "string" || input.search.length > MAX_HIGHLIGHT_SEARCH_LENGTH)) ||
      !optionalChoice("source", ["imported", "manual"]) ||
      !optionalChoice("notes", ["with", "without"]) ||
      !optionalChoice("dateKind", ["created", "imported"]) ||
      !optionalChoice("sort", ["oldest", "newest", "updated", "relevance"]) ||
      !optionalInteger("dateFrom", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER) ||
      !optionalInteger("dateBefore", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER) ||
      !optionalInteger("offset", 0, 1_000_000) ||
      !optionalInteger("limit", 1, MAX_HIGHLIGHT_PAGE) ||
      (input.sort === "relevance" && (typeof input.search !== "string" || !input.search.trim()))) {
    throw new Error("Highlight query is invalid");
  }
  return Object.fromEntries(Object.entries(input).filter(([, entry]) => entry !== undefined)) as HighlightQuery;
}

export function readingStatusHistoryPage(events: readonly ReadingStatusEvent[]): ReadingStatusHistoryPage {
  return {
    events: events.slice(0, MAX_DESKTOP_STATUS_EVENTS),
    hasMore: events.length > MAX_DESKTOP_STATUS_EVENTS,
  };
}

export function validateThreadCreate(value: unknown): NewThread {
  const input = threadRecord(value);
  return threadFields(input);
}

export function validateThreadUpdate(value: unknown): UpdateThread {
  const input = threadRecord(value);
  return { id: threadId(input.id), ...threadFields(input), expectedRevision: threadRevision(input.expectedRevision) };
}

export function validateThreadDelete(value: unknown): DeleteThread {
  const input = threadRecord(value);
  return { id: threadId(input.id), expectedRevision: threadRevision(input.expectedRevision) };
}

export function validateThreadMembership(value: unknown): SetHighlightThreadMembership {
  const input = threadRecord(value);
  if (!Array.isArray(input.threadIds) || input.threadIds.length > 20) throw new Error("Thread membership is invalid");
  return {
    bookId: threadId(input.bookId),
    highlightId: threadId(input.highlightId),
    threadIds: input.threadIds.map(threadId),
    expectedHighlightRevision: threadRevision(input.expectedHighlightRevision),
  };
}

export function validateDailyRequest(value: unknown): EnsureDailyHighlight {
  const input = threadRecord(value);
  if (typeof input.timezone !== "string" || !input.timezone.trim() ||
      new TextEncoder().encode(input.timezone.trim()).length > 100 ||
      (input.another !== undefined && typeof input.another !== "boolean")) {
    throw new Error("Daily highlight request is invalid");
  }
  return { timezone: input.timezone.trim(), ...(typeof input.another === "boolean" ? { another: input.another } : {}) };
}

export function validateAiSettings(value: unknown): AiSettingsInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("AI settings are invalid");
  }
  const input = value as Record<string, unknown>;
  const allowedKeys = new Set(["enabled", "selectedProvider", "selectedModel", "apiKey", "clearSavedApiKey"]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key)) ||
      typeof input.enabled !== "boolean" ||
      typeof input.selectedProvider !== "string" || !input.selectedProvider || input.selectedProvider.length > 64 ||
      typeof input.selectedModel !== "string" || !input.selectedModel || input.selectedModel.length > 200 ||
      (input.apiKey !== undefined && (typeof input.apiKey !== "string" || !input.apiKey.trim() || input.apiKey.length > 8_192)) ||
      (input.clearSavedApiKey !== undefined && typeof input.clearSavedApiKey !== "boolean") ||
      (input.apiKey !== undefined && input.clearSavedApiKey === true)) {
    throw new Error("AI settings are invalid");
  }
  return {
    enabled: input.enabled,
    selectedProvider: input.selectedProvider,
    selectedModel: input.selectedModel,
    ...(typeof input.apiKey === "string" ? { apiKey: input.apiKey } : {}),
    ...(typeof input.clearSavedApiKey === "boolean" ? { clearSavedApiKey: input.clearSavedApiKey } : {}),
  };
}

/**
 * The renderer may keep an explanation as an AI note; it may not claim a note
 * was imported, which would promise an imported original that does not exist.
 */
export function validateNoteOrigin(value: unknown): "reader" | "ai" {
  if (value !== "reader" && value !== "ai") throw new Error("Note origin is invalid");
  return value;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function threadRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Thread request is invalid");
  return value as Record<string, unknown>;
}
function threadId(value: unknown): never {
  if (typeof value !== "string" || !isUuid(value)) throw new Error("Thread identifier is invalid");
  return value as never;
}
function threadRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("Thread revision is invalid");
  return value;
}
function threadFields(input: Record<string, unknown>): NewThread {
  if (typeof input.name !== "string") throw new Error("Thread name is invalid");
  const name = input.name.trim().replace(/\s+/gu, " ");
  if (!name || name.length > 120) throw new Error("Thread name is invalid");
  if (input.description !== undefined && typeof input.description !== "string") throw new Error("Thread description is invalid");
  const description = typeof input.description === "string" ? input.description.trim() : undefined;
  if (description && description.length > 1_000) throw new Error("Thread description is invalid");
  return { name, ...(description ? { description } : {}) };
}
