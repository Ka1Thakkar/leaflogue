import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncOperationId, type ResolvedSyncChange, type SyncCursor, type SyncedChange } from "@leaflogue/contracts";
import type { SyncBootstrapSource, SyncChangeSource, SyncPullPage, SyncSubmission, SyncTransport } from "@leaflogue/remote";
import { LocalLibrary } from "@leaflogue/storage";
import { createSyncRunner, describeSyncProblem, runUntilSettled } from "./sync-runner";

const remoteDeviceId = "70000000-0000-4000-8000-000000000000";
const remoteBookId = "71000000-0000-4000-8000-000000000000";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A library whose snapshot bootstrap has already happened, as sync-state tests elsewhere arrange it. */
function bootstrappedLibrary(): LocalLibrary {
  const directory = mkdtempSync(join(tmpdir(), "leaflogue-sync-runner-"));
  directories.push(directory);
  const path = join(directory, "library.sqlite");
  new LocalLibrary(path).close();
  const setup = new DatabaseSync(path);
  setup.prepare("UPDATE sync_state SET remote_generation = 1, remote_sequence = 0, snapshot_required = 0").run();
  setup.close();
  return new LocalLibrary(path);
}

class MemoryProvider implements SyncTransport, SyncChangeSource {
  readonly received: SyncedChange[] = [];
  submits = 0;
  pulls = 0;
  readonly feed: Array<{ sequence: number; entityId: string; change: SyncedChange }> = [];
  failure?: unknown;

  async submit(changes: readonly ResolvedSyncChange[]): Promise<SyncSubmission> {
    this.submits += 1;
    const operationIds: string[] = [];
    for (const { change, entries } of changes) {
      if (this.failure) return { operationIds, failure: this.failure };
      this.received.push(change);
      operationIds.push(...entries.map(syncOperationId));
    }
    return { operationIds };
  }

  async pull(cursor: SyncCursor, limit: number): Promise<SyncPullPage> {
    this.pulls += 1;
    const next = this.feed.filter(({ sequence }) => sequence > cursor.afterSequence).slice(0, limit);
    return {
      page: {
        changes: next.map(({ sequence, entityId, change }) => ({
          sequence, entityType: change.entityType, entityId, revision: change.deviceRevision, changedAt: 1,
        })),
        nextCursor: { generation: cursor.generation, afterSequence: next.at(-1)?.sequence ?? cursor.afterSequence },
        isDone: next.length < limit || next.at(-1)?.sequence === this.feed.at(-1)?.sequence,
        resetRequired: false,
      },
      changes: next.map(({ change }) => change),
    };
  }
}

class ReplayingProvider extends MemoryProvider implements SyncBootstrapSource {
  resetsLeft = 0;
  recognizesCursor = true;
  validations = 0;

  async validateCursor(): Promise<boolean> {
    this.validations += 1;
    return this.recognizesCursor;
  }

  async bootstrapCursor(): Promise<SyncCursor> {
    return { generation: 1, afterSequence: 0 };
  }

  override async pull(cursor: SyncCursor, limit: number): Promise<SyncPullPage> {
    if (this.resetsLeft > 0) {
      this.resetsLeft -= 1;
      this.pulls += 1;
      return { page: { changes: [], nextCursor: { generation: cursor.generation, afterSequence: 0 }, isDone: false, resetRequired: true }, changes: [] };
    }
    return super.pull(cursor, limit);
  }
}

function remoteBook(title: string): SyncedChange {
  return { entityType: "book", operation: "upsert", deviceId: remoteDeviceId, deviceRevision: 1,
    collectionIds: [], tagIds: [], book: {
    id: remoteBookId as never, title, authors: [], status: "unread", archived: false,
    createdAt: 1, updatedAt: 1, revision: 1, highlightCount: 0,
  } };
}

describe("main-process sync runner", () => {
  it("pushes resolved local work, acknowledges it, then pulls with an exact cursor", async () => {
    const library = bootstrappedLibrary();
    const book = library.createBook({ title: "Piranesi" });
    library.createHighlight({ bookId: book.id, text: "Every room of the House" });
    const provider = new MemoryProvider();
    provider.feed.push({ sequence: 3, entityId: remoteBookId, change: remoteBook("From another device") });

    const result = await createSyncRunner({ ledger: library, transport: provider }).run();
    expect(result).toEqual({ status: "complete", bootstrapped: 0, pushed: 3, superseded: 0, pulled: 1 });
    expect(provider.received.map(({ entityType }) => entityType)).toEqual(["book", "highlight"]);
    expect(library.listPendingSyncChanges()).toEqual([]);
    expect(library.getSyncState().remoteCursor).toEqual({ generation: 1, afterSequence: 3 });
    expect(library.getBook(remoteBookId as never)?.title).toBe("From another device");
    library.close();
  });

  it("bootstraps a new library from a provider that can replay its history, then exchanges", async () => {
    const library = new LocalLibrary(":memory:");
    library.createBook({ title: "Before sync" });
    const provider = new ReplayingProvider();
    provider.feed.push({ sequence: 1, entityId: remoteBookId, change: remoteBook("Already on the provider") });
    // The book was already queued when it was written, so bootstrap adds no second entry for it.
    await expect(createSyncRunner({ ledger: library, transport: provider }).run())
      .resolves.toEqual({ status: "complete", bootstrapped: 0, pushed: 1, superseded: 0, pulled: 1 });
    expect(provider.received.map((change) => change.entityType)).toEqual(["book"]);
    expect(library.getSyncState()).toMatchObject({ snapshotRequired: false, remoteCursor: { generation: 1, afterSequence: 1 } });
    expect(library.getBook(remoteBookId as never)?.title).toBe("Already on the provider");
    library.close();
  });

  it("rebuilds once when the provider no longer recognises the cursor", async () => {
    const library = bootstrappedLibrary();
    library.createBook({ title: "Mine" });
    const provider = new ReplayingProvider();
    provider.resetsLeft = 1;
    const result = await createSyncRunner({ ledger: library, transport: provider }).run();
    // The first push landed before the provider asked for a rebuild, so the
    // rebuild queues the book again; a provider treats the repeat as harmless.
    expect(result).toEqual({ status: "complete", bootstrapped: 1, pushed: 2, superseded: 0, pulled: 0 });
    provider.resetsLeft = 5;
    await expect(createSyncRunner({ ledger: library, transport: provider }).run())
      .resolves.toMatchObject({ status: "snapshot-required", bootstrapped: 1 });
    library.close();
  });

  it("validates a provider cursor before pushing any queued local state", async () => {
    const library = bootstrappedLibrary();
    library.createBook({ title: "Must not reach an unverified history" });
    const provider = new ReplayingProvider();
    provider.recognizesCursor = false;
    const submit = provider.submit.bind(provider);
    provider.submit = async (changes) => {
      expect(provider.validations).toBe(1);
      return submit(changes);
    };

    await expect(createSyncRunner({ ledger: library, transport: provider }).run())
      .resolves.toEqual({ status: "complete", bootstrapped: 0, pushed: 1, superseded: 0, pulled: 0 });
    expect(provider.validations).toBe(1);
    expect(provider.submits).toBe(1);
    library.close();
  });

  it("does nothing in either direction until a snapshot establishes the provider cursor", async () => {
    const library = new LocalLibrary(":memory:");
    library.createBook({ title: "Unbootstrapped" });
    const provider = new MemoryProvider();
    await expect(createSyncRunner({ ledger: library, transport: provider }).run())
      .resolves.toEqual({ status: "snapshot-required", bootstrapped: 0, pushed: 0, superseded: 0, pulled: 0 });
    expect([provider.submits, provider.pulls]).toEqual([0, 0]);
    expect(library.listPendingSyncChanges()).toHaveLength(1);
    library.close();
  });

  it("bounds each run and continues from where the previous one stopped", async () => {
    const library = bootstrappedLibrary();
    for (const title of ["One", "Two", "Three"]) library.createBook({ title });
    const provider = new MemoryProvider();
    const runner = createSyncRunner({ ledger: library, transport: provider, batchSize: 1, maxBatches: 2 });
    await expect(runner.run()).resolves.toEqual({ status: "incomplete", bootstrapped: 0, pushed: 2, superseded: 0, pulled: 0 });
    expect(library.listPendingSyncChanges()).toHaveLength(1);
    await expect(runner.run()).resolves.toEqual({ status: "complete", bootstrapped: 0, pushed: 1, superseded: 0, pulled: 0 });
    expect(() => createSyncRunner({ ledger: library, transport: provider, batchSize: 101 })).toThrow(/bounds/);
    library.close();
  });

  it("joins an overlapping run and refuses new ones after shutdown", async () => {
    const library = bootstrappedLibrary();
    library.createBook({ title: "Queued" });
    const provider = new MemoryProvider();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const submit = provider.submit.bind(provider);
    let entered = false;
    provider.submit = async (changes) => {
      entered = true;
      await gate;
      return submit(changes);
    };
    const runner = createSyncRunner({ ledger: library, transport: provider });
    const first = runner.run();
    expect(runner.run()).toBe(first);
    await vi.waitFor(() => expect(entered).toBe(true));
    const stopped = runner.shutdown();
    release();
    await stopped;
    // The in-flight change landed and is acknowledged; the pull never starts.
    await expect(first).resolves.toEqual({ status: "cancelled", bootstrapped: 0, pushed: 1, superseded: 0, pulled: 0 });
    expect(provider.pulls).toBe(0);
    await expect(runner.run()).resolves.toEqual({ status: "cancelled", bootstrapped: 0, pushed: 0, superseded: 0, pulled: 0 });
    expect(provider.submits).toBe(1);
    library.close();
  });

  it("asks the transport to terminate an in-flight provider call on shutdown", async () => {
    const library = bootstrappedLibrary();
    library.createBook({ title: "Queued" });
    let reject!: (reason: unknown) => void;
    let entered = false;
    const provider = new MemoryProvider() as MemoryProvider & { cancel(): Promise<void> };
    provider.submit = async () => {
      entered = true;
      return new Promise<never>((_resolve, rejectPromise) => { reject = rejectPromise; });
    };
    provider.cancel = async () => reject(Object.assign(new Error("connection terminated"), { code: "ECONNRESET" }));
    const runner = createSyncRunner({ ledger: library, transport: provider });
    const running = runner.run();
    await vi.waitFor(() => expect(entered).toBe(true));
    await runner.shutdown();
    await expect(running).resolves.toMatchObject({ status: "cancelled", pushed: 0, pulled: 0 });
    library.close();
  });

  it("reports a sanitized problem and keeps undelivered work queued", async () => {
    const library = bootstrappedLibrary();
    const book = library.createBook({ title: "Private title" });
    library.createNote({ bookId: book.id, markdown: "A private thought" });
    const provider = new MemoryProvider();
    provider.failure = Object.assign(
      new Error("connect ECONNRESET postgres://reader:hunter2@db.example/leaflogue while writing 'A private thought'"),
      { code: "ECONNRESET" },
    );
    const problems: unknown[] = [];
    const result = await createSyncRunner({ ledger: library, transport: provider, onProblem: (problem) => problems.push(problem) }).run();
    expect(result).toEqual({
      status: "failed", bootstrapped: 0, pushed: 0, superseded: 0, pulled: 0,
      problem: { phase: "push", kind: "unreachable", message: "Leaflogue could not reach the sync provider." },
    });
    expect(problems).toEqual([result.status === "failed" ? result.problem : undefined]);
    expect(JSON.stringify(problems)).not.toMatch(/hunter2|private|postgres:/iu);
    expect(library.listPendingSyncChanges()).toHaveLength(3);
    library.close();
  });

  it("classifies provider failures by code alone", () => {
    expect(describeSyncProblem("pull", { code: "28P01", message: "password=secret" }))
      .toEqual({ phase: "pull", kind: "credentials", message: "The sync provider rejected the configured credentials." });
    expect(describeSyncProblem("push", { code: "42501" }).kind).toBe("permission");
    expect(describeSyncProblem("push", { code: "08006" }).kind).toBe("unreachable");
    expect(describeSyncProblem("push", { code: "40001" }).kind).toBe("busy");
    expect(describeSyncProblem("connect", { code: "LEAFLOGUE_CONVEX_VERSION_UNSUPPORTED", message: "secret" }))
      .toEqual({ phase: "connect", kind: "schema",
        message: "The Convex backend version is unsupported. Check connection in Settings for upgrade steps." });
    expect(describeSyncProblem("push", new Error("Synced note's book or highlight no longer exists")))
      .toEqual({ phase: "push", kind: "stopped", message: "Synchronization stopped before finishing. Unsent changes remain queued." });
  });
});

describe("running until settled", () => {
  const pass = (status: "complete" | "incomplete" | "failed", moved: number) =>
    ({ bootstrapped: 0, pushed: moved, superseded: 0, pulled: moved, status }) as Awaited<ReturnType<ReturnType<typeof createSyncRunner>["run"]>>;

  it("keeps going while each pass stops at its bound having moved something, and adds up the counts", async () => {
    const results = [pass("incomplete", 4), pass("incomplete", 4), pass("complete", 1)];
    const runner = { run: vi.fn(async () => results.shift()!) };
    expect(await runUntilSettled(runner)).toEqual({ bootstrapped: 0, pushed: 9, superseded: 0, pulled: 9, status: "complete" });
    expect(runner.run).toHaveBeenCalledTimes(3);
  });

  it("stops when a pass makes no progress, fails, or the run bound is reached", async () => {
    const stuck = { run: vi.fn(async () => pass("incomplete", 0)) };
    expect((await runUntilSettled(stuck)).status).toBe("incomplete");
    expect(stuck.run).toHaveBeenCalledTimes(1);
    const failing = { run: vi.fn(async () => pass("failed", 2)) };
    expect((await runUntilSettled(failing)).status).toBe("failed");
    expect(failing.run).toHaveBeenCalledTimes(1);
    const endless = { run: vi.fn(async () => pass("incomplete", 1)) };
    expect((await runUntilSettled(endless, 3)).status).toBe("incomplete");
    expect(endless.run).toHaveBeenCalledTimes(3);
  });
});

it("publishes monotonic counters across bounded passes and the real remaining queue", async () => {
  const library = bootstrappedLibrary();
  try {
    for (let index = 0; index < 3; index += 1) library.createBook({ title: `Local ${index}` });
    const provider = new MemoryProvider();
    provider.feed.push({ sequence: 1, entityId: remoteBookId, change: remoteBook("A remote book") });
    const progress: import("@leaflogue/contracts").SyncProgress[] = [];
    const result = await runUntilSettled(createSyncRunner({ ledger: library, transport: provider, batchSize: 1, maxBatches: 1, onProgress: (value) => progress.push(value) }));
    expect(result).toMatchObject({ status: "complete", pushed: 3, pulled: 1 });
    expect(progress.at(-1)).toMatchObject({ phase: "pull", pushed: 3, pulled: 1, remaining: 0 });
    expect(progress.some((value) => value.remaining === 3)).toBe(true);
    expect(progress.every((value, index) => index === 0 || (value.pushed >= progress[index - 1]!.pushed && value.pulled >= progress[index - 1]!.pulled))).toBe(true);
    expect(library.countPendingSyncChanges()).toBe(0);
    expect((await createSyncRunner({ ledger: library, transport: provider, onProgress: () => { throw Error("Broken observer"); } }).run()).status).toBe("complete");
  } finally { library.close(); }
});
