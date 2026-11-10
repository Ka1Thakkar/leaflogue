import { describe, expect, it, vi } from "vitest";
import { catalogIsbn13, googleVolume, normalizeCatalogQuery, openLibraryDocument, searchCatalog } from "./index";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const noWait = async () => undefined;

const volume = {
  id: "abc_123",
  volumeInfo: {
    title: " The Glass Orchard ",
    authors: ["Imogen Vale"],
    industryIdentifiers: [{ type: "ISBN_10", identifier: "0-306-40615-2" }],
    publisher: "Hollow Press",
    description: "A novel.",
    language: "en",
    imageLinks: { thumbnail: "http://books.google.com/books/content?id=abc&printsec=frontcover&img=1&zoom=1&source=gbs_api" },
  },
};

describe("book lookup", () => {
  it("normalizes ISBN-10 to ISBN-13 and refuses bad checksums", () => {
    expect(catalogIsbn13("0-306-40615-2")).toBe("9780306406157");
    expect(catalogIsbn13("978-0-306-40615-7")).toBe("9780306406157");
    expect(catalogIsbn13("0-306-40615-3")).toBeUndefined();
    expect(catalogIsbn13("The Glass Orchard")).toBeUndefined();
  });

  it("bounds and collapses the query", () => {
    expect(normalizeCatalogQuery("  glass   orchard ")).toBe("glass orchard");
    expect(() => normalizeCatalogQuery("   ")).toThrow("Enter a title");
    expect(() => normalizeCatalogQuery("x".repeat(201))).toThrow("at most 200 bytes");
  });

  it("reads a Google volume, keeping only Google-hosted covers over HTTPS", () => {
    expect(googleVolume(volume)).toEqual({
      provider: "google-books",
      providerId: "abc_123",
      title: "The Glass Orchard",
      authors: ["Imogen Vale"],
      isbn13: "9780306406157",
      description: "A novel.",
      publisher: "Hollow Press",
      language: "en",
      coverUrl: "https://books.google.com/books/content?id=abc&printsec=frontcover&img=1",
    });
    expect(googleVolume({ ...volume, volumeInfo: { ...volume.volumeInfo, imageLinks: { thumbnail: "https://evil.example/cover.jpg" } } })).not.toHaveProperty("coverUrl");
    expect(googleVolume({ id: "bad id!", volumeInfo: { title: "X" } })).toBeUndefined();
  });

  it("searches Google first, retrying a busy response", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json({ totalItems: 1, items: [volume] }));
    const result = await searchCatalog("9780306406157", { fetch, sleep: noWait, googleBooksApiKey: "key-123" });
    expect(result.source).toBe("google-books");
    expect(result.items[0]!.title).toBe("The Glass Orchard");
    const url = new URL(String(fetch.mock.calls[1]![0]));
    expect(url.searchParams.get("q")).toBe("isbn:9780306406157");
    expect(url.searchParams.get("key")).toBe("key-123");
  });

  it("falls back to Open Library when Google is down or finds nothing", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ error: "forbidden" }, 403))
      .mockResolvedValueOnce(json({ docs: [{ key: "/works/OL123W", title: "The Glass Orchard", author_name: ["Imogen Vale"], isbn: ["9780306406157"], cover_i: 42 }, { key: "nope", title: "x" }] }));
    const result = await searchCatalog("glass orchard", { fetch, sleep: noWait });
    expect(result).toEqual({
      source: "open-library",
      items: [{
        provider: "open-library", providerId: "OL123W", title: "The Glass Orchard", authors: ["Imogen Vale"],
        isbn13: "9780306406157", coverUrl: "https://covers.openlibrary.org/b/id/42-L.jpg",
      }],
    });
    expect(openLibraryDocument({ key: "/works/OL1W", title: "Lonely", cover_i: -1 })).not.toHaveProperty("coverUrl");
  });

  it("reports both providers being down as unavailable", async () => {
    const fetch = vi.fn().mockResolvedValue(json({}, 500));
    await expect(searchCatalog("glass orchard", { fetch, sleep: noWait })).rejects.toThrow("Book lookup is unavailable");
  });
});
