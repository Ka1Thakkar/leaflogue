// @vitest-environment edge-runtime

import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "./schema";
import { convexModules } from "./test.setup";

const OWNER = "https://host.example|owner";
const BOOK = "55555555-5555-4555-8555-555555555555";
const PASSAGE = "66666666-6666-4666-8666-666666666666";
const MINE = "77777777-7777-4777-8777-777777777777";
const EXPLAINED = "88888888-8888-4888-8888-888888888888";

const ref = <T extends "query" | "mutation">(type: T, name: string) => makeFunctionReference<T, Record<string, unknown>, unknown>(name);
const provisionHostOwner = makeFunctionReference<"mutation", { identityTokenIdentifier: string }, { libraryId: string }>("access:provisionHostOwner");
const createBook = ref("mutation", "runtime:createBook");
const createHighlight = ref("mutation", "runtime:createHighlight");
const updateHighlight = ref("mutation", "runtime:updateHighlight");
const createNote = ref("mutation", "runtime:createNote");
const publish = makeFunctionReference<"mutation", Record<string, unknown>, { publicId: string }>("publicationRuntime:publish");
const withdraw = ref("mutation", "publicationRuntime:withdraw");
const settings = makeFunctionReference<"query", Record<string, unknown>, { publicId: string; active: boolean; needsReview: boolean } | null>("publicationRuntime:settings");
const listMine = makeFunctionReference<"query", Record<string, unknown>, { page: Array<{ publicId: string; needsReview: boolean }> }>("publicationRuntime:listMine");
const get = makeFunctionReference<"query", { publicId: string }, Record<string, unknown> | null>("publicationRuntime:get");
const report = ref("mutation", "publicationRuntime:report");

async function library() {
  const t = convexTest(schema, convexModules);
  const { libraryId } = await t.mutation(provisionHostOwner, { identityTokenIdentifier: OWNER });
  const owner = t.withIdentity({ tokenIdentifier: OWNER });
  await owner.mutation(createBook, { libraryId, id: BOOK, title: "The Glass Orchard", authors: ["Imogen Vale"] });
  await owner.mutation(createHighlight, { libraryId, id: PASSAGE, bookId: BOOK, text: "Every pane held a season." });
  await owner.mutation(createNote, { libraryId, id: MINE, bookId: BOOK, highlightId: PASSAGE, markdown: "Glass as time." });
  await owner.mutation(createNote, { libraryId, id: EXPLAINED, bookId: BOOK, highlightId: PASSAGE, markdown: "Seasons framed.", origin: "ai" });
  return { t, owner, libraryId };
}

describe("public links for web clients", () => {
  it("publishes a frozen copy anyone can open, with only the chosen notes", async () => {
    const { t, owner, libraryId } = await library();
    await expect(owner.mutation(publish, { libraryId, highlightId: PASSAGE, noteIds: [], rightsConfirmed: false })).rejects.toThrow("allowed to share");
    const { publicId } = await owner.mutation(publish, { libraryId, highlightId: PASSAGE, noteIds: [EXPLAINED], rightsConfirmed: true });
    expect(await t.query(get, { publicId })).toEqual({
      publicId,
      passage: "Every pane held a season.",
      bookTitle: "The Glass Orchard",
      authors: ["Imogen Vale"],
      notes: [{ markdown: "Seasons framed.", ai: true }],
      publishedAt: expect.any(Number),
    });
    expect(await owner.query(settings, { libraryId, highlightId: PASSAGE })).toMatchObject({ publicId, active: true, needsReview: false });
    expect(await t.query(get, { publicId: "not-a-real-link" })).toBeNull();
  });

  it("hides a link when its passage changes, until it is published again, and withdraws it", async () => {
    const { t, owner, libraryId } = await library();
    const { publicId } = await owner.mutation(publish, { libraryId, highlightId: PASSAGE, noteIds: [], rightsConfirmed: true });
    await owner.mutation(updateHighlight, { libraryId, id: PASSAGE, bookId: BOOK, text: "Every pane held a different season.", expectedRevision: 1 });
    expect(await t.query(get, { publicId })).toBeNull();
    expect((await owner.query(listMine, { libraryId, paginationOpts: { numItems: 10, cursor: null } })).page).toMatchObject([{ publicId, needsReview: true }]);
    expect(await owner.mutation(publish, { libraryId, highlightId: PASSAGE, noteIds: [], rightsConfirmed: true })).toEqual({ publicId });
    expect(await t.query(get, { publicId })).toMatchObject({ passage: "Every pane held a different season." });
    await owner.mutation(withdraw, { libraryId, publicId });
    expect(await t.query(get, { publicId })).toBeNull();
    expect((await owner.query(listMine, { libraryId, paginationOpts: { numItems: 10, cursor: null } })).page).toEqual([]);
  });

  it("limits reports and keeps others from publishing", async () => {
    const { t, owner, libraryId } = await library();
    const { publicId } = await owner.mutation(publish, { libraryId, highlightId: PASSAGE, noteIds: [], rightsConfirmed: true });
    const reporterKey = "r".repeat(24);
    for (let index = 0; index < 5; index += 1) await t.mutation(report, { publicId, reporterKey, reason: "other" });
    await expect(t.mutation(report, { publicId, reporterKey, reason: "copyright" })).rejects.toThrow("most reports allowed today");
    await expect(t.mutation(report, { publicId, reporterKey: "bad", reason: "other" })).rejects.toThrow("could not be sent");
    await expect(t.withIdentity({ tokenIdentifier: "https://host.example|stranger" }).mutation(publish, { libraryId, highlightId: PASSAGE, noteIds: [], rightsConfirmed: true }))
      .rejects.toThrow("LEAFLOGUE_ACCESS_DENIED");
    await expect(owner.mutation(publish, { libraryId, highlightId: PASSAGE, noteIds: ["99999999-9999-4999-8999-999999999999"], rightsConfirmed: true }))
      .rejects.toThrow("not on this passage");
  });
});
