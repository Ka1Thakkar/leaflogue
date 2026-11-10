import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexSyncTransport, assertCompatibleConvexDeployment, ensureConvexLibrary } from "@leaflogue/remote";
import { LocalLibrary } from "@leaflogue/storage";
import schema from "../../../../convex/schema";
import { convexFetch } from "./convex-test-backend.test-support";
import { createSyncRunner } from "./sync-runner";

/**
 * Two desktop installations converging through the real Convex functions, run
 * in-process by convex-test. Requests travel through the real transport and
 * Convex HTTP client; the fake fetch below only replaces the network hop, and
 * redacts plain errors the way a production deployment does.
 */

const modules = import.meta.glob("../../../../convex/**/!(*.*.*)*.*s");
const DEPLOYMENT = "https://leaflogue-test.convex.cloud";
const SYNC_KEY = "s".repeat(44);

type Backend = ReturnType<typeof convexTest>;
let backend: Backend;
let libraryId: string;
let directory: string;
const opened: LocalLibrary[] = [];

beforeEach(async () => {
  vi.stubEnv("LEAFLOGUE_SYNC_KEY", SYNC_KEY);
  backend = convexTest(schema, modules);
  libraryId = await ensureConvexLibrary({ deploymentUrl: DEPLOYMENT, syncKey: SYNC_KEY, fetch: convexFetch(() => backend) });
  directory = mkdtempSync(join(tmpdir(), "leaflogue-convex-convergence-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const library of opened.splice(0)) library.close();
  rmSync(directory, { recursive: true, force: true });
});

/** `deployment.contract` stands in for the version an older deployment reports at preflight. */
async function device(name: string, syncKey = SYNC_KEY, deployment: { contract?: number } = {}) {
  const library = new LocalLibrary(join(directory, `${name}.sqlite`));
  opened.push(library);
  const options = { deploymentUrl: DEPLOYMENT, syncKey, fetch: convexFetch(() => backend) };
  const { deviceId } = library.getSyncState();
  // Every device resolves the same one library through the key.
  await expect(ensureConvexLibrary(options)).resolves.toBe(libraryId);
  const runner = () => createSyncRunner({
    ledger: library,
    transport: new ConvexSyncTransport({
      ...options, session: { libraryId, deviceId }, mutationContractVersion: deployment.contract,
    }),
  });
  return {
    library,
    run: () => runner().run(),
    /** Convex pulls at most four states per call, so a pass may stop at its batch ceiling. */
    sync: async () => {
      for (let pass = 0; pass < 20; pass += 1) {
        const result = await runner().run();
        if (result.status === "complete") return result;
        expect(result).toMatchObject({ status: "incomplete" });
      }
      throw new Error("Sync did not converge");
    },
  };
}

function reading(library: LocalLibrary) {
  return library.listBooks().map((book) => {
    const contents = library.getBookContents(book.id)!;
    return {
      title: book.title,
      highlights: contents.highlights.map((highlight) => ({
        id: highlight.id,
        text: highlight.text,
        notes: highlight.notes.map((note) => ({ id: note.id, markdown: note.markdown })),
      })),
      standaloneNotes: contents.standaloneNotes.map((note) => ({ id: note.id, markdown: note.markdown })),
    };
  }).sort((first, second) => first.title.localeCompare(second.title));
}

function organization(library: LocalLibrary) {
  return {
    collections: library.listCollections().map(({ name, description, bookCount }) => ({ name, description, bookCount })),
    tags: library.listTags().map(({ name, color, bookCount, highlightCount }) => ({ name, color, bookCount, highlightCount })),
    books: library.listBooks().map((book) => ({
      title: book.title,
      organization: library.getBookOrganization(book.id),
    })).sort((first, second) => first.title.localeCompare(second.title)),
  };
}

describe("two-device sync convergence through Convex", () => {
  it("brings a second installation up to date, including organization, and keeps device identities", async () => {
    await expect(assertCompatibleConvexDeployment(DEPLOYMENT, { fetch: convexFetch(() => backend) }))
      .resolves.toEqual({ mutationContractVersion: 23 });
    const first = await device("first");
    const second = await device("second");
    const book = first.library.createBook({ title: "Piranesi" });
    const highlight = first.library.createHighlight({ bookId: book.id, text: "Every room of the House keeps its weather.", noteMarkdown: "Tides" });
    first.library.createNote({ bookId: book.id, markdown: "A note about the whole book" });
    const collection = first.library.createCollection({ name: "Labyrinths", description: "Impossible places" });
    const tag = first.library.createTag({ name: "Favourite", color: "#eb6f92" });
    first.library.setBookCollectionMembership({ bookId: book.id, collectionId: collection.id, included: true });
    first.library.setBookTagMembership({ bookId: book.id, tagId: tag.id, included: true });
    first.library.setHighlightTagMembership({ bookId: book.id, highlightId: highlight.id, tagId: tag.id, included: true });
    await first.sync();

    second.library.createBook({ title: "Jonathan Strange & Mr Norrell" });
    await second.sync();
    await first.sync();

    expect(reading(second.library)).toEqual(reading(first.library));
    expect(organization(second.library)).toEqual(organization(first.library));
    expect(second.library.listTags()).toMatchObject([{ name: "Favourite", bookCount: 1, highlightCount: 1 }]);
    expect(first.library.getSyncState().deviceId).not.toBe(second.library.getSyncState().deviceId);
    expect(first.library.getSyncState().remoteCursor).toEqual(second.library.getSyncState().remoteCursor);
    expect(first.library.listPendingSyncChanges()).toEqual([]);
    expect(second.library.listPendingSyncChanges()).toEqual([]);

    const [secondCollection] = second.library.listCollections();
    const [secondTag] = second.library.listTags();
    second.library.deleteCollection({ id: secondCollection!.id, expectedRevision: secondCollection!.revision });
    second.library.deleteTag({ id: secondTag!.id, expectedRevision: secondTag!.revision });
    await second.sync();
    await first.sync();
    expect(first.library.listCollections()).toEqual([]);
    expect(first.library.listTags()).toEqual([]);
    expect(first.library.getBookOrganization(book.id)).toMatchObject({ collectionIds: [], tagIds: [], highlightTags: [] });

    const before = reading(first.library);
    await first.sync();
    await second.sync();
    expect(reading(first.library)).toEqual(before);
    expect(reading(second.library)).toEqual(before);
  });

  it("syncs threads and passage membership and never deletes passages with a thread", async () => {
    const first = await device("first");
    const second = await device("second");
    const book = first.library.createBook({ title: "Piranesi" });
    const highlight = first.library.createHighlight({ bookId: book.id, text: "The House" });
    const thread = first.library.createThread({ name: "Architecture", description: "Halls and tides" });
    first.library.setHighlightThreadMembership({
      bookId: book.id, highlightId: highlight.id, threadIds: [thread.id], expectedHighlightRevision: highlight.revision,
    });
    first.library.createThread({ name: "Tides" });
    second.library.createThread({ name: "tides" });
    await first.sync();
    await second.sync();
    await first.sync();
    expect(second.library.getHighlightThreadIds(book.id, highlight.id)).toEqual([thread.id]);
    const threads = (library: LocalLibrary) => library.listThreads()
      .map(({ id, name, passageCount }) => ({ id, name, passageCount })).sort((a, b) => a.id.localeCompare(b.id));
    expect(threads(first.library)).toHaveLength(3);
    expect(threads(second.library)).toEqual(threads(first.library));

    const shared = second.library.listThreads().find(({ id }) => id === thread.id)!;
    second.library.deleteThread({ id: thread.id, expectedRevision: shared.revision });
    await second.sync();
    await first.sync();
    expect(first.library.getHighlightThreadIds(book.id, highlight.id)).toEqual([]);
    expect(reading(first.library)[0]!.highlights.map(({ text }) => text)).toEqual(["The House"]);
    expect(first.library.listPendingSyncChanges()).toEqual([]);
  });

  it("holds newer changes while the deployment is older, then sends them all once it is updated", async () => {
    // Desktops update first: against a contract-22 deployment the new desktop
    // sends what that contract can store and keeps the rest queued.
    const deployment: { contract?: number } = { contract: 22 };
    const first = await device("first", SYNC_KEY, deployment);
    const second = await device("second");
    const book = first.library.createBook({ title: "Piranesi" });
    await expect(first.run()).resolves.toMatchObject({ status: "complete" });
    const highlight = first.library.createHighlight({ bookId: book.id, text: "The House" });
    const thread = first.library.createThread({ name: "Architecture" });
    first.library.setHighlightThreadMembership({
      bookId: book.id, highlightId: highlight.id, threadIds: [thread.id], expectedHighlightRevision: highlight.revision,
    });
    first.library.setBookReadingStatus({ id: book.id, status: "reading", expectedRevision: first.library.getBook(book.id)!.revision });
    const held = await first.run();
    expect(held).toMatchObject({ status: "failed", problem: { kind: "schema", message: expect.stringMatching(/Update the Convex deployment/) } });
    expect(first.library.listPendingSyncChanges().length).toBeGreaterThan(0);
    await second.sync();
    expect(second.library.listBooks().map(({ title }) => title)).toEqual(["Piranesi"]);
    expect(second.library.listThreads()).toEqual([]);

    delete deployment.contract;
    await first.sync();
    await second.sync();
    expect(first.library.listPendingSyncChanges()).toEqual([]);
    expect(second.library.getHighlightThreadIds(book.id, highlight.id)).toEqual([thread.id]);
    expect(second.library.getBook(book.id)).toMatchObject({ status: "reading" });
    expect(second.library.listReadingStatusHistory(book.id)).toEqual(first.library.listReadingStatusHistory(book.id));
    expect(reading(second.library)).toEqual(reading(first.library));
  });

  it("keeps every device's reading-status history, including concurrent offline changes", async () => {
    const first = await device("first");
    const second = await device("second");
    const book = first.library.createBook({ title: "Piranesi" });
    const current = first.library.setBookReadingStatus({ id: book.id, status: "reading", expectedRevision: book.revision }).book;
    await first.sync();
    await second.sync();
    first.library.setBookReadingStatus({ id: book.id, status: "finished", expectedRevision: current.revision });
    const onSecond = second.library.getBook(book.id)!;
    second.library.setBookReadingStatus({ id: book.id, status: "paused", expectedRevision: onSecond.revision });
    await first.sync();
    await second.sync();
    await first.sync();
    const history = (library: LocalLibrary) => library.listReadingStatusHistory(book.id)
      .map(({ id, status }) => ({ id, status })).sort((a, b) => a.id.localeCompare(b.id));
    expect(history(first.library).map(({ status }) => status).sort()).toEqual(["finished", "paused", "reading"]);
    expect(history(second.library)).toEqual(history(first.library));
    const fresh = await device("fresh");
    await fresh.sync();
    expect(history(fresh.library)).toEqual(history(first.library));
  });

  it("settles two devices' offline daily picks on the earlier one", async () => {
    const first = await device("first");
    const second = await device("second");
    const book = first.library.createBook({ title: "Piranesi" });
    for (const text of ["One", "Two", "Three"]) first.library.createHighlight({ bookId: book.id, text });
    await first.sync();
    await second.sync();
    const earlier = first.library.ensureDailyHighlight({ timezone: "UTC" })!;
    await new Promise((resolve) => setTimeout(resolve, 5));
    second.library.ensureDailyHighlight({ timezone: "UTC" });
    await second.sync();
    await first.sync();
    await second.sync();
    const picks = (library: LocalLibrary) => library.listDailySelections().map(({ id, highlightId }) => ({ id, highlightId }));
    expect(picks(first.library)).toEqual([{ id: earlier.selection.id, highlightId: earlier.selection.highlightId }]);
    expect(picks(second.library)).toEqual(picks(first.library));
    const fresh = await device("fresh");
    await fresh.sync();
    expect(picks(fresh.library)).toEqual(picks(first.library));
  });

  it("converges after concurrent offline edits and keeps the losing note for review", async () => {
    const first = await device("first");
    const second = await device("second");
    const book = first.library.createBook({ title: "Piranesi" });
    const note = first.library.createNote({ bookId: book.id, markdown: "Shared start" });
    await first.sync();
    await second.sync();

    first.library.updateNote({ id: note.id, bookId: book.id, expectedRevision: note.revision, markdown: "Written on the first device" });
    const onSecond = second.library.getBookContents(book.id)!.standaloneNotes[0]!;
    second.library.updateNote({ id: onSecond.id, bookId: book.id, expectedRevision: onSecond.revision, markdown: "Written on the second device" });
    await first.sync();
    await second.sync();
    await first.sync();

    expect(reading(first.library)).toEqual(reading(second.library));
    const kept = reading(first.library)[0]!.standaloneNotes[0]!.markdown;
    const lost = kept === "Written on the first device" ? "Written on the second device" : "Written on the first device";
    const preserved = [first.library, second.library].flatMap((library) => library.listSyncConflicts().conflicts);
    expect(preserved.map((conflict) => conflict.preservedBody)).toContain(lost);
  });

  it("preserves concurrent same-name collections and tags as distinct records", async () => {
    const first = await device("first");
    const second = await device("second");
    await first.sync();
    await second.sync();
    first.library.createCollection({ name: "Favourites" });
    second.library.createCollection({ name: "favourites" });
    first.library.createTag({ name: "Architecture" });
    second.library.createTag({ name: "ARCHITECTURE" });
    await first.sync();
    await second.sync();
    await first.sync();

    expect(first.library.listCollections().map(({ name }) => name.toLowerCase())).toEqual(["favourites", "favourites"]);
    expect(second.library.listCollections().map(({ id, name, revision }) => ({ id, name, revision })))
      .toEqual(first.library.listCollections().map(({ id, name, revision }) => ({ id, name, revision })));
    expect(second.library.listTags().map(({ id, name, revision }) => ({ id, name, revision })))
      .toEqual(first.library.listTags().map(({ id, name, revision }) => ({ id, name, revision })));
  });

  it("lets a deletion win over a concurrent edit everywhere without losing the edit", async () => {
    const first = await device("first");
    const second = await device("second");
    const book = first.library.createBook({ title: "Piranesi" });
    const highlight = first.library.createHighlight({ bookId: book.id, text: "The House" });
    await first.sync();
    await second.sync();

    first.library.deleteHighlight({ id: highlight.id, bookId: book.id, expectedRevision: highlight.revision });
    const onSecond = second.library.getBookContents(book.id)!.highlights[0]!;
    second.library.updateHighlight({ id: onSecond.id, bookId: book.id, text: "The House, revised", expectedRevision: onSecond.revision });
    await second.sync();
    await first.sync();
    await second.sync();

    expect(reading(first.library)[0]!.highlights).toEqual([]);
    expect(reading(second.library)[0]!.highlights).toEqual([]);
    const preserved = [first.library, second.library].flatMap((library) => library.listSyncConflicts().conflicts);
    expect(preserved).toEqual([expect.objectContaining({ kind: "highlight", preservedBody: "The House, revised" })]);
  });

  it("refuses a device with an old key after rotation and reports it as a credential problem", async () => {
    const first = await device("first");
    const second = await device("second");
    first.library.createBook({ title: "Piranesi" });
    await first.sync();
    await second.sync();

    // Rotating the key is how a lost device is cut off.
    const rotated = "r".repeat(44);
    vi.stubEnv("LEAFLOGUE_SYNC_KEY", rotated);
    second.library.createBook({ title: "Written with the old key" });
    const refused = await second.run();
    expect(refused).toMatchObject({ status: "failed", problem: { kind: "credentials" } });
    expect(second.library.listPendingSyncChanges().length).toBeGreaterThan(0);
    const kept = await device("first-rekeyed", rotated);
    await kept.sync();
    expect(reading(kept.library).map(({ title }) => title)).toEqual(["Piranesi"]);
  });

  it("resumes cleanly after the network drops part-way through a delivery", async () => {
    const first = await device("first");
    const book = first.library.createBook({ title: "Piranesi" });
    for (const text of ["One", "Two", "Three", "Four"]) first.library.createHighlight({ bookId: book.id, text });
    const queued = first.library.listPendingSyncChanges().length;
    const { deviceId } = first.library.getSyncState();
    let remaining = 3;
    const online = convexFetch(() => backend);
    const flaky = new ConvexSyncTransport({
      deploymentUrl: DEPLOYMENT,
      syncKey: SYNC_KEY,
      fetch: async (input, init) => {
        if (remaining-- <= 0) throw new TypeError("fetch failed");
        return online(input, init);
      },
      session: { libraryId, deviceId },
    });
    const interrupted = await createSyncRunner({ ledger: first.library, transport: flaky }).run();
    expect(interrupted).toMatchObject({ status: "failed", problem: { phase: "push", kind: "unreachable" } });
    const pending = first.library.listPendingSyncChanges().length;
    expect(pending).toBeGreaterThan(0);
    expect(pending).toBeLessThan(queued);

    await first.sync();
    expect(first.library.listPendingSyncChanges()).toEqual([]);
    const second = await device("second");
    await second.sync();
    expect(reading(second.library)[0]!.highlights.map(({ text }) => text).sort()).toEqual(["Four", "One", "Three", "Two"]);
  });

  it("lets a newly joined device bootstrap from the provider history", async () => {
    const first = await device("first");
    const book = first.library.createBook({ title: "Piranesi" });
    for (const text of ["One", "Two", "Three", "Four", "Five"]) first.library.createHighlight({ bookId: book.id, text });
    const collection = first.library.createCollection({ name: "Labyrinths" });
    first.library.setBookCollectionMembership({ bookId: book.id, collectionId: collection.id, included: true });
    await first.sync();

    const fresh = await device("fresh");
    await fresh.sync();
    expect(reading(fresh.library)).toEqual(reading(first.library));
    expect(organization(fresh.library)).toEqual(organization(first.library));
  });
});
