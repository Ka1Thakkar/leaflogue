import { describe, expect, it, vi } from "vitest";
import type { ReadingStatusEvent } from "@leaflogue/contracts";
import { assertTrustedSenderUrl, readingStatusHistoryPage, registerTrustedHandler, validateAiSettings, validateCommitImport, validateConflictResolution, validateSyncConflictResolution, validateSyncRunOptions, validateDailyRequest, validateExternalUrl, validateHighlightQuery, validateNoteOrigin, validateSetBookCompletionDate, validateSetBookReadingStatus, validateThreadCreate, validateThreadDelete, validateThreadMembership, validateThreadUpdate } from "./ipc-security";

const firstId = "5a540f21-7f61-44d7-89a5-f1b4643ce26c";
const secondId = "6b651032-8a72-45e8-9ab6-a2c5754df37d";

describe("main-process IPC security", () => {
  it("rejects untrusted events before a registered handler can run", () => {
    let registered: ((event: { senderFrame?: { url: string } }, ...args: unknown[]) => unknown) | undefined;
    const handler = vi.fn((value: unknown) => value);
    registerTrustedHandler({ handle: (_channel, listener) => { registered = listener; } }, "test:operation", () => false, handler);
    const listener = registered;
    if (!listener) throw new Error("Handler was not registered");

    expect(() => listener({ senderFrame: { url: "https://attacker.test" } }, "payload")).toThrow(/Untrusted/);
    expect(handler).not.toHaveBeenCalled();
    expect(listener({ senderFrame: { url: "http://localhost:5173" } }, "payload")).toBe("payload");
    expect(handler).toHaveBeenCalledWith("payload");
  });

  it("accepts only the packaged app origin or loopback during development", () => {
    expect(() => assertTrustedSenderUrl("leaflogue://app/index.html", true)).not.toThrow();
    expect(() => assertTrustedSenderUrl("http://localhost:5173/", false)).not.toThrow();
    expect(() => assertTrustedSenderUrl("https://127.0.0.1:5173/", false)).not.toThrow();
    for (const untrusted of [undefined, "not a URL", "https://example.com", "file:///tmp/app.html", "http://localhost.attacker.test"]) {
      expect(() => assertTrustedSenderUrl(untrusted, false)).toThrow(/Untrusted/);
    }
    expect(() => assertTrustedSenderUrl("http://localhost:5173/", true)).toThrow(/Untrusted/);
  });

  it("normalizes reviewed import commits and rejects unreviewed shapes", () => {
    expect(validateCommitImport({ token: firstId, sourceId: secondId, newSourceName: "  Kobo Clara  " }))
      .toEqual({ token: firstId, sourceId: secondId, newSourceName: "Kobo Clara" });
    for (const invalid of [null, [], {}, { token: "bad", sourceId: secondId }, { token: firstId, sourceId: secondId, newSourceName: " " }]) {
      expect(() => validateCommitImport(invalid)).toThrow();
    }
  });

  it("allows only a validated conflict id and explicit resolution", () => {
    expect(validateConflictResolution({ id: firstId, resolution: "keep-local" }))
      .toEqual({ id: firstId, resolution: "keep-local" });
    expect(validateConflictResolution({ id: firstId, resolution: "use-incoming" }))
      .toEqual({ id: firstId, resolution: "use-incoming" });
    expect(() => validateConflictResolution({ id: firstId, resolution: "overwrite" })).toThrow();
    expect(() => validateConflictResolution({ id: "bad", resolution: "keep-local" })).toThrow();
  });

  it("allows only a validated sync conflict id, resolution, and shown revision", () => {
    expect(validateSyncConflictResolution({ id: firstId, resolution: "restore", expectedRevision: 0, extra: true }))
      .toEqual({ id: firstId, resolution: "restore", expectedRevision: 0 });
    for (const invalid of [
      null,
      [],
      { id: firstId, resolution: "keep-local", expectedRevision: 1 },
      { id: "bad", resolution: "discard", expectedRevision: 1 },
      { id: firstId, resolution: "discard" },
      { id: firstId, resolution: "discard", expectedRevision: -1 },
      { id: firstId, resolution: "discard", expectedRevision: "1" },
    ]) {
      expect(() => validateSyncConflictResolution(invalid)).toThrow(/Sync conflict resolution is invalid/);
    }
  });

  it("accepts only an exact reviewed note as a sync migration confirmation", () => {
    expect(validateSyncRunOptions(undefined)).toEqual({});
    expect(validateSyncRunOptions({})).toEqual({});
    expect(validateSyncRunOptions({ confirmDetachNoteId: firstId }))
      .toEqual({ confirmDetachNoteId: firstId });
    expect(validateSyncRunOptions({ confirmDetachNoteId: "legacy-note" }))
      .toEqual({ confirmDetachNoteId: "legacy-note" });
    for (const invalid of [null, [], "confirm", { confirmDetachNoteId: "" },
      { confirmDetachNoteId: "x".repeat(513) },
      { confirmDetachNoteId: firstId, unexpected: true }]) {
      expect(() => validateSyncRunOptions(invalid)).toThrow(/Sync options are invalid/);
    }
  });

  it("accepts only revision-safe reading status commands", () => {
    expect(validateSetBookReadingStatus({ id: firstId, status: "paused", expectedRevision: 3 }))
      .toEqual({ id: firstId, status: "paused", expectedRevision: 3 });
    for (const invalid of [
      null,
      {},
      { id: "bad", status: "reading", expectedRevision: 1 },
      { id: firstId, status: "rereading", expectedRevision: 1 },
      { id: firstId, status: "reading", expectedRevision: 0 },
      { id: firstId, status: "reading", expectedRevision: 1.5 },
    ]) {
      expect(() => validateSetBookReadingStatus(invalid)).toThrow(/Reading status is invalid/);
    }
  });

  it("accepts only revision-safe ISO completion dates", () => {
    expect(validateSetBookCompletionDate({ id: firstId, completedOn: "2024-02-29", expectedRevision: 3 }))
      .toEqual({ id: firstId, completedOn: "2024-02-29", expectedRevision: 3 });
    expect(validateSetBookCompletionDate({ id: firstId, expectedRevision: 4 }))
      .toEqual({ id: firstId, expectedRevision: 4 });
    for (const invalid of [null, {}, { id: "bad", expectedRevision: 1 }, { id: firstId, completedOn: "2024-2-29", expectedRevision: 1 }, { id: firstId, expectedRevision: 0 }]) {
      expect(() => validateSetBookCompletionDate(invalid)).toThrow(/Completion date is invalid/);
    }
  });

  it("discloses when the desktop status-history page is truncated", () => {
    const events = Array.from({ length: 101 }, (_, index) => ({
      id: `event-${index}` as never,
      bookId: firstId as never,
      status: "reading" as const,
      source: "reader" as const,
      changedAt: 101 - index,
      bookRevision: index + 1,
    })) satisfies ReadingStatusEvent[];
    expect(readingStatusHistoryPage(events)).toEqual({ events: events.slice(0, 100), hasMore: true });
    expect(readingStatusHistoryPage(events.slice(0, 100))).toEqual({ events: events.slice(0, 100), hasMore: false });
  });

  it("validates revision-safe thread and bounded daily requests", () => {
    expect(validateThreadCreate({ name: "  Home   and exile ", description: " Across homes " }))
      .toEqual({ name: "Home and exile", description: "Across homes" });
    expect(validateThreadUpdate({ id: firstId, name: "Home", expectedRevision: 2 }))
      .toEqual({ id: firstId, name: "Home", expectedRevision: 2 });
    expect(validateThreadDelete({ id: firstId, expectedRevision: 2 }))
      .toEqual({ id: firstId, expectedRevision: 2 });
    expect(validateThreadMembership({ bookId: firstId, highlightId: secondId, threadIds: [firstId], expectedHighlightRevision: 3 }))
      .toEqual({ bookId: firstId, highlightId: secondId, threadIds: [firstId], expectedHighlightRevision: 3 });
    expect(validateDailyRequest({ timezone: "  Asia/Kolkata ", another: true }))
      .toEqual({ timezone: "Asia/Kolkata", another: true });
    for (const invalid of [
      {}, { name: " " }, { id: "bad", name: "Home", expectedRevision: 1 },
      { id: firstId, expectedRevision: 0 },
      { bookId: firstId, highlightId: secondId, threadIds: Array(21).fill(firstId), expectedHighlightRevision: 1 },
      { timezone: " ", another: false }, { timezone: "UTC", another: "yes" },
    ]) {
      expect(() => {
        if ("timezone" in invalid) validateDailyRequest(invalid);
        else if ("bookId" in invalid) validateThreadMembership(invalid);
        else if ("name" in invalid && "id" in invalid) validateThreadUpdate(invalid);
        else if ("name" in invalid) validateThreadCreate(invalid);
        else validateThreadDelete(invalid);
      }).toThrow();
    }
  });

  it("lets only credential-free https links leave the app", () => {
    expect(validateExternalUrl("https://example.test/path?q=1#x").href).toBe("https://example.test/path?q=1#x");
    for (const invalid of [
      undefined, 1, "", "not a url", "http://example.test", "javascript:alert(1)", "file:///etc/passwd",
      "leaflogue://app/", "https://user:pass@example.test", `https://example.test/${"x".repeat(2_048)}`,
    ]) {
      expect(() => validateExternalUrl(invalid)).toThrow();
    }
  });

  it("accepts only bounded, allowlisted highlight queries", () => {
    const bookId = "10000000-0000-4000-8000-000000000000";
    expect(validateHighlightQuery({ bookId, search: "house", source: "imported", notes: "with", sort: "newest", dateKind: "created", dateFrom: 0, dateBefore: 86_400_000, offset: 20, limit: 20, tagId: undefined }))
      .toEqual({ bookId, search: "house", source: "imported", notes: "with", sort: "newest", dateKind: "created", dateFrom: 0, dateBefore: 86_400_000, offset: 20, limit: 20 });
    expect(validateHighlightQuery({})).toEqual({});
    expect(validateHighlightQuery({ search: " house ", sort: "relevance" })).toEqual({ search: " house ", sort: "relevance" });
    for (const invalid of [
      null, [], "query", { bookId: "bad" }, { tagId: 1 }, { search: "x".repeat(201) }, { source: "kobo" },
      { notes: "some" }, { sort: "relevance" }, { search: "  ", sort: "relevance" }, { dateKind: "read" }, { dateFrom: 1.5 }, { offset: -1 },
      { limit: 0 }, { limit: 101 }, { sql: "1=1" },
    ]) {
      expect(() => validateHighlightQuery(invalid)).toThrow("Highlight query is invalid");
    }
  });

  it("accepts only bounded AI settings and keeps the key transient", () => {
    expect(validateAiSettings({
      enabled: true,
      selectedProvider: "anthropic",
      selectedModel: "claude-model",
      apiKey: "  transient-key  ",
    })).toEqual({ enabled: true, selectedProvider: "anthropic", selectedModel: "claude-model", apiKey: "  transient-key  " });
    for (const invalid of [
      null,
      {},
      { enabled: "yes", selectedProvider: "openai", selectedModel: "model" },
      { enabled: false, selectedProvider: "openai", selectedModel: "model", unexpected: true },
      { enabled: false, selectedProvider: "openai", selectedModel: "model", apiKey: " " },
      { enabled: false, selectedProvider: "openai", selectedModel: "model", apiKey: "key", clearSavedApiKey: true },
    ]) {
      expect(() => validateAiSettings(invalid)).toThrow(/AI settings are invalid/);
    }
  });

  it("lets the renderer keep an AI note but never claim an imported original", () => {
    expect(validateNoteOrigin("reader")).toBe("reader");
    expect(validateNoteOrigin("ai")).toBe("ai");
    for (const refused of ["import", "", "AI", null, 1, {}]) {
      expect(() => validateNoteOrigin(refused)).toThrow(/Note origin is invalid/);
    }
  });
});
