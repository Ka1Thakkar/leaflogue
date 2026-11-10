import { describe, expect, it } from "vitest";
import type { BookId, HighlightId, ImportDocument } from "@leaflogue/contracts";
import { assertUniqueImportIds, canonicalImportJson, chooseDailyHighlightId, normalizeBookText, normalizeIsbn13, resolveLocalDay, normalizeBookMetadata, passagePlace, passagePosition, validateCompletionDate } from "./index";

const validDocument: ImportDocument = {
  formatVersion: 1,
  books: [{ providerRecordId: "book-1", title: "Piranesi", authors: ["Susanna Clarke"] }],
  annotations: [
    {
      providerRecordId: "passage-1",
      bookProviderRecordId: "book-1",
      text: "Every room of the House keeps its weather.",
    },
  ],
};

describe("import identity validation", () => {
  it("accepts a referentially valid document", () => {
    expect(() => assertUniqueImportIds(validDocument)).not.toThrow();
  });

  it("rejects duplicate annotations before persistence", () => {
    expect(() =>
      assertUniqueImportIds({
        ...validDocument,
        annotations: [...validDocument.annotations, validDocument.annotations[0]!],
      }),
    ).toThrow(/Duplicate annotation/);
  });

  it("rejects an annotation whose book is absent", () => {
    expect(() =>
      assertUniqueImportIds({
        ...validDocument,
        annotations: [{ ...validDocument.annotations[0]!, bookProviderRecordId: "missing" }],
      }),
    ).toThrow(/unknown book/);
  });
});

describe("book normalization", () => {
  it("normalizes accents and punctuation for candidate lookup", () => {
    expect(normalizeBookText("  Cien años—de soledad! ")).toBe("cien anos de soledad");
  });

  it("accepts only checksum-valid ISBN-13 values", () => {
    expect(normalizeIsbn13("978-1-63557-563-7")).toBe("9781635575637");
    expect(normalizeIsbn13("9781635575638")).toBeUndefined();
  });
});

describe("completion dates", () => {
  it("accepts only real ISO calendar dates", () => {
    expect(validateCompletionDate(undefined)).toBeUndefined();
    expect(validateCompletionDate("2024-02-29")).toBe("2024-02-29");
    for (const value of ["0000-01-01", "2023-02-29", "2026-13-01", "2026-9-01", " 2026-09-01 "]) {
      expect(() => validateCompletionDate(value)).toThrow(/valid calendar date/);
    }
  });
});

describe("daily selection policy", () => {
  it("canonicalizes equivalent timezone names", () => {
    const now = Date.parse("2026-09-22T08:00:00.000Z");
    expect(resolveLocalDay("utc", now)).toEqual(resolveLocalDay("Etc/UTC", now));
    expect(() => resolveLocalDay("Not/A_Zone", now)).toThrow(/Timezone is invalid/u);
  });

  it("chooses a book before a passage and avoids recent books when possible", () => {
    const firstBook = "10000000-0000-4000-8000-000000000000" as BookId;
    const secondBook = "20000000-0000-4000-8000-000000000000" as BookId;
    const first = "30000000-0000-4000-8000-000000000000" as HighlightId;
    const candidates = [
      { id: first, bookId: firstBook },
      { id: "40000000-0000-4000-8000-000000000000" as HighlightId, bookId: firstBook },
      { id: "50000000-0000-4000-8000-000000000000" as HighlightId, bookId: secondBook },
    ];
    const choice = chooseDailyHighlightId(candidates, [first], first, {
      localDay: "2026-09-22",
      timezone: "UTC",
      candidateDigest: "a".repeat(64),
      revision: 2,
    });
    expect(candidates.find(({ id }) => id === choice)?.bookId).toBe(secondBook);
  });
});

describe("book metadata normalization", () => {
  it("keeps the reader's wording while trimming, collapsing whitespace, and clearing blanks", () => {
    expect(normalizeBookMetadata({
      title: "  Jonathan   Strange & Mr Norrell ",
      authors: [" Susanna  Clarke ", "", "Susanna Clarke"],
      description: "  Line one.\n\nLine two.  ",
      publisher: " ",
      series: " The   Ladies ",
      isbn13: "978-1-63557-563-7",
      coverUrl: " https://covers.openlibrary.org/b/isbn/9781635575637-L.jpg ",
    })).toEqual({
      title: "Jonathan Strange & Mr Norrell",
      authors: ["Susanna Clarke"],
      description: "Line one.\n\nLine two.",
      series: "The Ladies",
      isbn13: "9781635575637",
      coverUrl: "https://covers.openlibrary.org/b/isbn/9781635575637-L.jpg",
    });
  });

  it("rejects blank titles, invalid ISBNs, and oversized fields", () => {
    expect(() => normalizeBookMetadata({ title: "  ", authors: [] })).toThrow(/title is required/);
    expect(() => normalizeBookMetadata({ title: "Book", authors: [], isbn13: "978-1-63557-563-8" })).toThrow(/ISBN-13 is invalid/);
    expect(() => normalizeBookMetadata({ title: "x".repeat(1_001), authors: [] })).toThrow(/too long/);
    expect(() => normalizeBookMetadata({ title: "Book", authors: Array.from({ length: 51 }, (_, index) => `A${index}`) })).toThrow(/authors are invalid/);
    expect(() => normalizeBookMetadata({ title: "Book", authors: [], coverUrl: "http://example.test/cover.jpg" })).toThrow(/HTTPS URL/);
    expect(() => normalizeBookMetadata({ title: "Book", authors: [], coverUrl: "https://reader:secret@example.test/cover.jpg" })).toThrow(/HTTPS URL/);
  });
});

describe("canonical import JSON", () => {
  it("is the same whatever order the fields arrive in, and leaves out absent ones", () => {
    const a = canonicalImportJson("annotation", { createdAt: 5, note: "n", providerRecordId: "bm-1", bookProviderRecordId: "vol-1", text: undefined });
    const b = canonicalImportJson("annotation", { providerRecordId: "bm-1", bookProviderRecordId: "vol-1", note: "n", createdAt: 5 });
    expect(a).toBe(b);
    expect(a).toBe('{"providerRecordId":"bm-1","bookProviderRecordId":"vol-1","note":"n","createdAt":5}');
    expect(canonicalImportJson("book", { status: "reading", title: "T", providerRecordId: "v", authors: [] }))
      .toBe('{"providerRecordId":"v","title":"T","authors":[],"status":"reading"}');
  });
});

describe("passage position", () => {
  it("reads a trailing percentage and leaves page or location numbers alone", () => {
    expect(passagePosition("Part 3: The Prophet · 63%")).toBe(0.63);
    expect(passagePosition("75%")).toBe(0.75);
    expect(passagePosition("Page 42")).toBeUndefined();
    expect(passagePosition("3197-3198")).toBeUndefined();
    expect(passagePosition("Chapter 5 · 140%")).toBeUndefined();
    expect(passagePlace("Part 3: The Prophet · 63%")).toBe("Part 3: The Prophet");
    expect(passagePlace("75%")).toBeUndefined();
    expect(passagePlace("Page 42")).toBe("Page 42");
  });
});
