import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NoteId, SyncRunOptions } from "@leaflogue/contracts";
import { initializePostgres, type PostgresClient } from "@leaflogue/remote";
import { LocalLibrary } from "@leaflogue/storage";
import { createDesktopSyncService } from "./desktop-sync-service";

function pgliteClient(database: PGlite): PostgresClient {
  return {
    async connect() {},
    async end() {},
    async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
      if (values?.length) return { rows: (await database.query<Row>(text, [...values])).rows };
      const results = await database.exec(text);
      return { rows: (results.at(-1)?.rows ?? []) as Row[] };
    },
  };
}

const directories: string[] = [];
const databases: PGlite[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) await database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("desktop PostgreSQL sync service", () => {
  it("joins explicit runs, provisions one shared library, and syncs another installation", async () => {
    const database = new PGlite();
    databases.push(database);
    const client = pgliteClient(database);
    await initializePostgres("pglite://memory", () => client);
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-sync-service-"));
    directories.push(directory);
    const first = new LocalLibrary(join(directory, "first.sqlite"));
    const second = new LocalLibrary(join(directory, "second.sqlite"));
    first.createBook({ title: "Piranesi" });
    const config = { provider: "postgres", connectionString: "postgresql://redacted", source: "config" } as const;
    const createClient = vi.fn(() => client);
    const service = createDesktopSyncService({ getLibrary: () => first, readConfig: () => config, createPostgresClient: createClient });
    const running = service.run();
    expect(service.run()).toBe(running);
    await expect(running).resolves.toMatchObject({ status: "complete", pushed: 1 });

    const receiver = createDesktopSyncService({ getLibrary: () => second, readConfig: () => config, createPostgresClient: () => client });
    await expect(receiver.run()).resolves.toMatchObject({ status: "complete", pulled: 1 });
    expect(second.listBooks().map(({ title }) => title)).toEqual(["Piranesi"]);
    await expect(client.query<{ count: string }>("SELECT count(*)::text AS count FROM leaflogue.libraries"))
      .resolves.toEqual({ rows: [{ count: "1" }] });
    expect(createClient).toHaveBeenCalledWith("postgresql://redacted");
    first.close();
    second.close();
  });

  it("refuses missing and Convex configurations without opening a client", async () => {
    const library = new LocalLibrary(":memory:");
    const createClient = vi.fn();
    for (const config of [undefined, { provider: "convex", deploymentUrl: "https://example.convex.cloud", source: "config" } as const]) {
      const service = createDesktopSyncService({ getLibrary: () => library, readConfig: () => config, createPostgresClient: createClient });
      await expect(service.run()).resolves.toMatchObject({ status: "failed", problem: { phase: "connect", kind: "configuration" } });
    }
    expect(createClient).not.toHaveBeenCalled();
    library.close();
  });

  it.each([
    ["older", "DELETE FROM leaflogue.schema_migrations WHERE version = (SELECT max(version) FROM leaflogue.schema_migrations)"],
    ["newer", "INSERT INTO leaflogue.schema_migrations (version) VALUES (99)"],
  ])("refuses an %s schema before provisioning remote state", async (_label, alterSchema) => {
    const database = new PGlite();
    databases.push(database);
    const client = pgliteClient(database);
    await initializePostgres("pglite://memory", () => client);
    await client.query(alterSchema);
    const library = new LocalLibrary(":memory:");
    const service = createDesktopSyncService({
      getLibrary: () => library,
      readConfig: () => ({ provider: "postgres", connectionString: "postgresql://redacted", source: "config" }),
      createPostgresClient: () => client,
    });

    await expect(service.run()).resolves.toMatchObject({
      status: "failed",
      problem: { phase: "connect", kind: "schema" },
    });
    await expect(client.query<{ count: string }>("SELECT count(*)::text AS count FROM leaflogue.libraries"))
      .resolves.toEqual({ rows: [{ count: "0" }] });
    library.close();
  });

  it("refuses an ambiguous remote library without registering the device", async () => {
    const database = new PGlite();
    databases.push(database);
    const client = pgliteClient(database);
    await initializePostgres("pglite://memory", () => client);
    await client.query(
      "INSERT INTO leaflogue.libraries (id, name) VALUES ($1, 'One'), ($2, 'Two')",
      ["33d26461-9e2c-42ed-aef7-e27f4d9012fa", "72f5bca7-0236-42a8-9b9a-a8e3dce8eb85"],
    );
    const library = new LocalLibrary(":memory:");
    const service = createDesktopSyncService({
      getLibrary: () => library,
      readConfig: () => ({ provider: "postgres", connectionString: "postgresql://redacted", source: "config" }),
      createPostgresClient: () => client,
    });

    await expect(service.run()).resolves.toMatchObject({
      status: "failed",
      problem: { phase: "connect", kind: "library" },
    });
    await expect(client.query<{ count: string }>("SELECT count(*)::text AS count FROM leaflogue.devices"))
      .resolves.toEqual({ rows: [{ count: "0" }] });
    library.close();
  });

  it("closes a client when shutdown starts during connection", async () => {
    const library = new LocalLibrary(":memory:");
    let rejectConnect: ((reason: Error) => void) | undefined;
    const connect = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectConnect = reject; }));
    const end = vi.fn(async () => { rejectConnect?.(Object.assign(new Error("closed"), { code: "57P01" })); });
    const client: PostgresClient = {
      connect,
      end,
      async query<Row extends Record<string, unknown>>() { return { rows: [] as Row[] }; },
    };
    const service = createDesktopSyncService({
      getLibrary: () => library,
      readConfig: () => ({ provider: "postgres", connectionString: "postgresql://redacted", source: "config" }),
      createPostgresClient: () => client,
    });

    const running = service.run();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    await service.shutdown();

    await expect(running).resolves.toMatchObject({ status: "cancelled" });
    expect(end).toHaveBeenCalledOnce();
    library.close();
  });
});

describe("desktop Convex sync service", () => {
  it("uses the signed-in Convex transport and reports a missing sign-in as a credential problem", async () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-convex-service-"));
    directories.push(directory);
    const library = new LocalLibrary(join(directory, "library.sqlite"));
    try {
      const config = { provider: "convex", deploymentUrl: "https://example.convex.cloud", source: "config" } as const;
      const createPostgresClient = vi.fn();
      const signedOut = createDesktopSyncService({
        getLibrary: () => library, readConfig: () => config, createPostgresClient,
        createConvexTransport: async () => { throw Object.assign(new Error("secret provider text"), { code: "LEAFLOGUE_AUTH_REQUIRED" }); },
      });
      const refused = await signedOut.run();
      expect(refused).toMatchObject({ status: "failed", problem: { phase: "connect", kind: "credentials" } });
      expect(JSON.stringify(refused)).not.toContain("secret provider text");
      expect(createPostgresClient).not.toHaveBeenCalled();

      const unavailable = createDesktopSyncService({ getLibrary: () => library, readConfig: () => config, createPostgresClient });
      await expect(unavailable.run()).resolves.toMatchObject({ status: "failed", problem: { kind: "configuration" } });
    } finally {
      library.close();
    }
  });

  it("reports bounded migration progress and requires exact note confirmation before exchange", async () => {
    const library = new LocalLibrary(":memory:");
    try {
      const noteId = "99999999-9999-4999-8999-999999999999" as NoteId;
      const transport = {
        async submit() { return { operationIds: [] }; },
        async bootstrapCursor() { return { generation: 1, afterSequence: 0 }; },
        async validateCursor() { return true; },
        async pull() {
          return { page: { changes: [], nextCursor: { generation: 1, afterSequence: 0 }, isDone: true, resetRequired: false }, changes: [] };
        },
      };
      const createConvexTransport = vi.fn(async (
        _config: unknown,
        _deviceId: string,
        runOptions: SyncRunOptions,
        signal: AbortSignal,
      ) => {
        expect(signal.aborted).toBe(false);
        return {
          transport,
          migration: runOptions.confirmDetachNoteId === noteId
            ? { status: "ready" as const, updated: 1, detached: 1 }
            : { status: "review-required" as const, updated: 50, detached: 0,
              reviewNoteId: noteId, reviewReason: "oversized" as const },
        };
      });
      const service = createDesktopSyncService({
        getLibrary: () => library,
        readConfig: () => ({ provider: "convex", deploymentUrl: "https://example.convex.cloud",
          syncKey: "k".repeat(44), source: "config" }),
        createPostgresClient: vi.fn(),
        createConvexTransport,
      });
      await expect(service.run()).resolves.toMatchObject({
        status: "migration-review-required",
        migration: { updated: 50, detached: 0, reviewNoteId: noteId, reviewReason: "oversized" },
      });
      await expect(service.run({ confirmDetachNoteId: noteId })).resolves.toMatchObject({
        status: "complete", migration: { updated: 1, detached: 1 },
      });
      expect(createConvexTransport).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.any(String),
        { confirmDetachNoteId: noteId },
        expect.anything(),
      );
    } finally {
      library.close();
    }
  });

  it("cancels Convex preparation before waiting for shutdown", async () => {
    const library = new LocalLibrary(":memory:");
    try {
      let preparationSignal: AbortSignal | undefined;
      const createConvexTransport = vi.fn((
        _config: unknown,
        _deviceId: string,
        _runOptions: SyncRunOptions,
        signal: AbortSignal,
      ) => {
        preparationSignal = signal;
        return new Promise<never>((_resolve, reject) => {
          const cancel = () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
          if (signal.aborted) cancel();
          else signal.addEventListener("abort", cancel, { once: true });
        });
      });
      const service = createDesktopSyncService({
        getLibrary: () => library,
        readConfig: () => ({ provider: "convex", deploymentUrl: "https://example.convex.cloud",
          syncKey: "k".repeat(44), source: "config" }),
        createPostgresClient: vi.fn(),
        createConvexTransport,
      });
      const running = service.run();
      await vi.waitFor(() => expect(createConvexTransport).toHaveBeenCalledOnce());
      await service.shutdown();
      expect(preparationSignal?.aborted).toBe(true);
      await expect(running).resolves.toMatchObject({ status: "cancelled" });
    } finally {
      library.close();
    }
  });
});
