// @vitest-environment edge-runtime

import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { convexModules } from "./test.setup";

const OWNER = "https://host.example|owner";
const provisionHostOwner = makeFunctionReference<"mutation", { identityTokenIdentifier: string }, { libraryId: string }>("access:provisionHostOwner");
const search = makeFunctionReference<"action", { libraryId: string; query: string }, { source: string; items: Array<Record<string, unknown>> }>("catalogRuntime:search");
const createBook = makeFunctionReference<"mutation", Record<string, unknown>, Record<string, unknown>>("runtime:createBook");

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("book lookup for web clients", () => {
  it("searches for a library member, and adds a result in one step", async () => {
    const t = convexTest(schema, convexModules);
    const { libraryId } = await t.mutation(provisionHostOwner, { identityTokenIdentifier: OWNER });
    vi.stubEnv("GOOGLE_BOOKS_API_KEY", "books-key");
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      urls.push(input);
      return new Response(JSON.stringify({ totalItems: 1, items: [{ id: "abc", volumeInfo: {
        title: "The Glass Orchard", authors: ["Imogen Vale"], publisher: "Hollow Press",
        industryIdentifiers: [{ type: "ISBN_13", identifier: "9780306406157" }],
        imageLinks: { thumbnail: "https://books.google.com/books/content?id=abc&img=1" },
      } }] }), { status: 200 });
    }));
    const owner = t.withIdentity({ tokenIdentifier: OWNER });
    const result = await owner.action(search, { libraryId, query: "glass orchard" });
    expect(result.source).toBe("google-books");
    expect(new URL(urls[0]!).searchParams.get("key")).toBe("books-key");
    const found = result.items[0]!;
    const book = await owner.mutation(createBook, {
      libraryId, id: "55555555-5555-4555-8555-555555555555", title: found.title, authors: found.authors,
      isbn13: found.isbn13, publisher: found.publisher, coverUrl: found.coverUrl,
    });
    expect(book).toMatchObject({ title: "The Glass Orchard", publisher: "Hollow Press", isbn13: "9780306406157", coverUrl: "https://books.google.com/books/content?id=abc&img=1" });
  });

  it("refuses people outside the library before contacting a provider", async () => {
    const t = convexTest(schema, convexModules);
    const { libraryId } = await t.mutation(provisionHostOwner, { identityTokenIdentifier: OWNER });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(t.withIdentity({ tokenIdentifier: "https://host.example|stranger" }).action(search, { libraryId, query: "x" }))
      .rejects.toThrow("LEAFLOGUE_ACCESS_DENIED");
    expect(fetch).not.toHaveBeenCalled();
  });
});
