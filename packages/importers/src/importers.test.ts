import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseKindleClippings, parsePortableJson } from "./index";

function kindleFixture(name: string): string {
  return readFileSync(new URL(`./fixtures/kindle/${name}`, import.meta.url), "utf8");
}

describe("portable JSON", () => {
  it("rejects duplicate IDs before returning a preview", () => {
    expect(() =>
      parsePortableJson(
        JSON.stringify({
          formatVersion: 1,
          books: [{ id: "book", title: "Book", authors: [] }],
          annotations: [
            { id: "same", bookId: "book", text: "First" },
            { id: "same", bookId: "book", text: "Second" },
          ],
        }),
      ),
    ).toThrow(/Duplicate annotation/);
  });

  it("normalizes a validated ISBN", () => {
    const preview = parsePortableJson(
      JSON.stringify({
        formatVersion: 1,
        books: [{ id: "book", title: "Book", authors: ["Writer"], isbn13: "978-1-63557-563-7" }],
        annotations: [{ id: "passage", bookId: "book", text: "A line" }],
      }),
    );
    expect(preview.document.books[0]?.isbn13).toBe("9781635575637");
  });
});

describe("Kindle clippings", () => {
  it("parses localized metadata and CRLF record separators", async () => {
    const localized = kindleFixture("localized.txt").replaceAll("\n", "\r\n");
    const preview = await parseKindleClippings(localized);

    expect(preview.document.books.map((book) => book.title)).toEqual([
      "El jardín de papel",
      "Die Uhrmacherin",
      "La cartographe des nuages",
    ]);
    expect(preview.document.annotations).toHaveLength(3);
    expect(preview.document.annotations[0]).toMatchObject({
      location: "3197-3198",
      note: "Volver a esta imagen.",
    });
    expect(preview.document.annotations[1]?.location).toBe("1064-1065");
    expect(preview.document.annotations[2]?.location).toBe("652-653");
    expect(preview.warnings).toEqual([]);
  });

  it("reads the dates non-English Kindles write", async () => {
    const preview = await parseKindleClippings(kindleFixture("localized.txt"));
    const dates = preview.document.annotations.map(({ createdAt }) => createdAt);
    expect(dates).toEqual([
      new Date(2014, 3, 10, 23, 29, 31).getTime(),
      new Date(2024, 4, 4, 19, 42, 0).getTime(),
      new Date(2024, 4, 7, 8, 15, 0).getTime(),
    ]);

    const cases: [string, Date | undefined][] = [
      ["- Your Highlight on Location 5 | Added on Monday, 1 January 2024 13:05:00", new Date(2024, 0, 1, 13, 5, 0)],
      ["- La tua evidenziazione alla posizione 5 | Aggiunto il lunedì 6 maggio 2024 10:15:00", new Date(2024, 4, 6, 10, 15, 0)],
      ["- Seu destaque na posição 5 | Adicionado: segunda-feira, 6 de março de 2024 07:01:02", new Date(2024, 2, 6, 7, 1, 2)],
      ["- Uw markering op locatie 5 | Toegevoegd op maandag 6 mei 2024 22:00:00", new Date(2024, 4, 6, 22, 0, 0)],
      ["- 位置No. 5のハイライト |作成日: 2024年5月6日月曜日 9:03:04", new Date(2024, 4, 6, 9, 3, 4)],
      ["- 您在位置 #5 的标注 | 添加于 2024年5月6日星期一 下午3:15:00", new Date(2024, 4, 6, 15, 15, 0)],
      ["- Deine Markierung bei Position 5 | Hinzugefügt am Samstag, 31. Februar 2024 19:42:00", undefined],
      ["- Deine Markierung bei Position 5 | Hinzugefügt am Samstag, 4. Brumaire 2024 19:42:00", undefined],
    ];
    for (const [metadata, expected] of cases) {
      const { document } = await parseKindleClippings(`Book\n${metadata}\n\nA passage.\n==========\n`);
      expect(document.annotations[0]?.createdAt, metadata).toBe(expected?.getTime());
    }
  });

  it("attaches a note only when its location is contained by the preceding highlight", async () => {
    const preview = await parseKindleClippings(`A Book
- Your Highlight on Location 20-22 | Added on Monday, January 1, 2024 1:00:00 PM

A memorable passage.
==========
A Book
- Your Note on Location 21 | Added on Monday, January 1, 2024 1:01:00 PM

Remember this.
==========`);
    expect(preview.document.annotations).toHaveLength(1);
    expect(preview.document.annotations[0]).toMatchObject({
      text: "A memorable passage.",
      note: "Remember this.",
    });
    expect(preview.warnings).toEqual([]);
  });

  it("keeps an unlocated note independent and reports it for review", async () => {
    const preview = await parseKindleClippings(`A Book
- Your Highlight on Location 20-22

A memorable passage.
==========
A Book
- Your Note

This association is unknown.
==========`);
    expect(preview.document.annotations).toHaveLength(2);
    expect(preview.document.annotations[1]).toMatchObject({ note: "This association is unknown." });
    expect(preview.warnings).toHaveLength(1);
  });

  it("does not attach a note that appears before its matching highlight", async () => {
    const preview = await parseKindleClippings(`A Book
- Your Note on Location 21

Review this later.
==========
A Book
- Your Highlight on Location 20-22

A memorable passage.
==========`);

    expect(preview.document.annotations).toHaveLength(2);
    expect(preview.document.annotations[0]).toMatchObject({ note: "Review this later." });
    expect(preview.document.annotations[1]).toMatchObject({ text: "A memorable passage." });
    expect(preview.warnings).toMatchObject([{ code: "ambiguous-note" }]);
  });

  it("does not overwrite a note already attached to a highlight", async () => {
    const preview = await parseKindleClippings(`A Book
- Your Highlight on Location 20-22

A memorable passage.
==========
A Book
- Your Note on Location 21

First note.
==========
A Book
- Your Note on Location 21

Second note.
==========
A Book
- Your Note on Location 22

Third note.
==========`);

    expect(preview.document.annotations).toHaveLength(3);
    expect(preview.document.annotations[0]).toMatchObject({ note: "First note." });
    expect(preview.document.annotations[1]).toMatchObject({ note: "Second note." });
    expect(preview.document.annotations[2]).toMatchObject({ note: "Third note." });
    expect(preview.warnings).toHaveLength(1);
    expect(preview.warnings[0]).toMatchObject({
      code: "ambiguous-note",
      message: expect.stringContaining("2 Kindle notes were kept separate"),
    });
  });

  it("uses occurrence ordinals for identical repeated clippings", async () => {
    const record = `A Book
- Your Highlight on Location 20

Repeated text.
==========`;
    const preview = await parseKindleClippings(`${record}\n${record}`);
    const ids = preview.document.annotations.map((annotation) => annotation.providerRecordId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toMatch(/:1$/);
    expect(ids[1]).toMatch(/:2$/);
  });

  it("keeps legacy IDs stable when safer parsing improves the displayed location", async () => {
    const preview = await parseKindleClippings(`A Book
- Your Highlight on Location 20–22

En dash.
==========`);

    expect(preview.document.annotations[0]).toMatchObject({
      location: "20-22",
      providerRecordId: "kindle:4673084d0018a917ffa42b69b3731154a80a72af99f5e4a4038928bb94834c51:1",
    });
  });

  it("keeps malformed dates non-fatal and does not trust unsafe locations", async () => {
    const preview = await parseKindleClippings(kindleFixture("malformed.txt"));

    expect(preview.document.annotations).toHaveLength(2);
    expect(preview.document.annotations[0]).toMatchObject({
      text: "The range runs backwards, so its location must not be trusted.",
    });
    expect(preview.document.annotations[0]).not.toHaveProperty("location");
    expect(preview.document.annotations[0]).not.toHaveProperty("createdAt");
    expect(preview.document.annotations[1]).toMatchObject({
      note: "This unsafe location must not attach to another clipping.",
    });
    expect(preview.document.annotations[1]).not.toHaveProperty("location");
    expect(preview.warnings.map((warning) => warning.code)).toEqual([
      "skipped-records",
      "ambiguous-note",
    ]);
  });

  it("accepts only the explicit English Kindle date grammar", async () => {
    const preview = await parseKindleClippings(`A Book
- Your Highlight on Location 1 | Added on 0

Malformed date.
==========
A Book
- Your Highlight on Location 2 | Added on Monday, January 1, 2024 1:00:00 PM

Supported date.
==========`);

    expect(preview.document.annotations[0]).not.toHaveProperty("createdAt");
    expect(preview.document.annotations[1]?.createdAt).toBeTypeOf("number");
  });

  it("rejects control characters and imports with no supported records", async () => {
    await expect(parseKindleClippings("A Book\n- Your Highlight\n\nText\u0000hidden\n=========="))
      .rejects.toThrow(/control characters/);
    await expect(parseKindleClippings("A Book\n- Your Bookmark on Location 1\n\nBookmark\n=========="))
      .rejects.toThrow(/No supported Kindle highlights or notes/);
  });

  it("skips a clipping whose body exceeds the per-record limit", async () => {
    const valid = `A Book\n- Your Highlight on Location 2\n\nKept.\n==========`;
    const oversized = `A Book\n- Your Highlight on Location 1\n\n${"x".repeat(200_001)}\n==========`;
    const preview = await parseKindleClippings(`${oversized}\n${valid}`);

    expect(preview.document.annotations.map((annotation) => annotation.text)).toEqual(["Kept."]);
    expect(preview.warnings).toMatchObject([{ code: "skipped-records" }]);
  });

  it("rejects files above the bounded Kindle record count", async () => {
    const records = Array.from({ length: 50_001 }, () => "x").join("\n==========\n");
    await expect(parseKindleClippings(records)).rejects.toThrow(/50,000 records/);
  });
});
