import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  ConvexSyncTransport,
  assertCompatibleConvexDeployment,
  ensureConvexLibrary,
  prepareConvexLibrary,
} from "@leaflogue/remote";
import { LocalLibrary } from "@leaflogue/storage";
import { createDesktopSyncService } from "../../apps/desktop/src/main/desktop-sync-service";

const deploymentUrl = process.env.LEAFLOGUE_CONVEX_URL?.trim();
const syncKey = process.env.LEAFLOGUE_CONVEX_SYNC_KEY?.trim();

if (!deploymentUrl || !syncKey) {
  throw new Error("Set LEAFLOGUE_CONVEX_URL and LEAFLOGUE_CONVEX_SYNC_KEY in the ignored local .env before running the live test");
}

it("converges three isolated desktops through the configured Convex deployment", async () => {
  const directory = mkdtempSync(join(tmpdir(), "leaflogue-live-convex-"));
  const libraries: LocalLibrary[] = [];
  const makeDevice = (name: string) => {
    const library = new LocalLibrary(join(directory, `${name}.sqlite`));
    libraries.push(library);
    const service = createDesktopSyncService({
      getLibrary: () => library,
      readConfig: () => ({ provider: "convex", deploymentUrl, syncKey, source: "config" }),
      createPostgresClient: () => { throw new Error("PostgreSQL was selected during a Convex test"); },
      createConvexTransport: async (config, deviceId, runOptions, signal) => {
        const options = { deploymentUrl: config.deploymentUrl, syncKey };
        await assertCompatibleConvexDeployment(config.deploymentUrl, { signal });
        const libraryId = await ensureConvexLibrary(options, signal);
        const migration = await prepareConvexLibrary(options, libraryId, {
          ...(runOptions.confirmDetachNoteId ? { confirmDetachNoteId: runOptions.confirmDetachNoteId } : {}),
        }, signal);
        return { migration, transport: new ConvexSyncTransport({ ...options, session: { libraryId, deviceId } }) };
      },
    });
    return { library, service };
  };
  const sync = async (device: ReturnType<typeof makeDevice>) => {
    for (let pass = 0; pass < 20; pass += 1) {
      const result = await device.service.run();
      if (result.status === "complete") return;
      expect(result).toMatchObject({ status: "incomplete" });
    }
    throw new Error("Live Convex sync did not converge within 20 bounded passes");
  };

  try {
    await assertCompatibleConvexDeployment(deploymentUrl);
    const first = makeDevice("first");
    const second = makeDevice("second");
    expect(first.library.getSyncState().deviceId).not.toBe(second.library.getSyncState().deviceId);

    const title = `Leaflogue live test ${randomUUID()}`;
    const book = first.library.createBook({ title });
    const highlight = first.library.createHighlight({ bookId: book.id, text: "A synthetic passage", noteMarkdown: "A synthetic attached note" });
    await sync(first);
    await sync(second);
    expect(second.library.listBooks()).toEqual(expect.arrayContaining([expect.objectContaining({ id: book.id, title })]));
    expect(second.library.getBookContents(book.id)?.highlights).toEqual([
      expect.objectContaining({ id: highlight.id, text: "A synthetic passage",
        notes: [expect.objectContaining({ markdown: "A synthetic attached note" })] }),
    ]);

    const note = second.library.createNote({ bookId: book.id, markdown: "A synthetic standalone note" });
    await sync(second);
    await sync(first);
    expect(first.library.getBookContents(book.id)?.standaloneNotes).toEqual([
      expect.objectContaining({ id: note.id, markdown: "A synthetic standalone note" }),
    ]);

    first.library.deleteHighlight({ id: highlight.id, bookId: book.id, expectedRevision: highlight.revision });
    await sync(first);
    await sync(second);
    expect(second.library.getBookContents(book.id)?.highlights).toEqual([]);

    const third = makeDevice("third");
    await sync(third);
    expect(third.library.getBookContents(book.id)?.standaloneNotes).toEqual([
      expect.objectContaining({ id: note.id, markdown: "A synthetic standalone note" }),
    ]);
    expect(third.library.getBookContents(book.id)?.highlights).toEqual([]);
    for (const device of [first, second, third]) expect(device.library.listPendingSyncChanges()).toEqual([]);
  } finally {
    for (const library of libraries) library.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);

it("refuses the old key after rotation and accepts it again after restoration", async () => {
  if (process.env.CONVEX_DEPLOY_KEY || !process.env.CONVEX_DEPLOYMENT?.startsWith("dev:") ||
      new URL(process.env.CONVEX_URL ?? "https://invalid.example").origin !== new URL(deploymentUrl).origin) {
    throw new Error("Live key rotation requires the matching CLI-selected development deployment without a deploy key");
  }
  const deploymentName = new URL(deploymentUrl).hostname.split(".")[0]!;
  const rotate = (key: string) => {
    const result = spawnSync("npx", ["convex", "env", "set", "--deployment", deploymentName, "LEAFLOGUE_SYNC_KEY"], {
      input: `${key}\n`, encoding: "utf8", timeout: 30_000,
    });
    if (result.status !== 0) throw new Error("Could not update the selected test deployment's sync key");
  };
  const originalKey = syncKey;
  const rotatedKey = randomBytes(32).toString("hex");
  try {
    rotate(rotatedKey);
    await expect(ensureConvexLibrary({ deploymentUrl, syncKey: originalKey }))
      .rejects.toMatchObject({ code: "LEAFLOGUE_SYNC_KEY_INVALID" });
    await expect(ensureConvexLibrary({ deploymentUrl, syncKey: rotatedKey }))
      .resolves.toMatch(/^[0-9a-f-]{36}$/u);
  } finally {
    rotate(originalKey);
  }
  await expect(ensureConvexLibrary({ deploymentUrl, syncKey: originalKey }))
    .resolves.toMatch(/^[0-9a-f-]{36}$/u);
}, 120_000);
