import { describe, expect, it } from "vitest";
import { looksLikeBooxExport, parseBooxExport, parseBooxExports } from "./boox";

// Layouts as published by open-source Boox tools (boox2logseq, boox-annotation-parser).
const current = `Reading Notes | <<System for Writing__33d2f489-1c2b-4a5e-9f00-123456789abc>>Bob Doto

Introduction

2024-10-27 07:56  |  Page No.: 14

"The structure of a Luhmann-style zettelkasten is not predetermined."

【Annotation】much like graphs

-------------------

2024-10-28 21:50  |  Page No.: 20

"Notes link to notes."

-------------------
Chapter 2
2024-10-29 06:00  |  Page No.: 31
Plain passage without quotes.
【Note】A second note
over two lines
-------------------
A line Leaflogue cannot place
-------------------
`;

const legacy = `BOOX Reading Notes | <<Trilogia de la Fundacion (Spanish Edition) - Isaac Asimov (146)>>
Isaac Asimov
Cuarta parte. Los comerciantes
Time：2021-08-17 22:48
【Original Text】ruegos
【Annotations】requests
【Page Number】442
-------------------
`;

describe("Boox import", () => {
  it("reads current exports: passages, notes, chapters carried over, pages, and times", async () => {
    expect(looksLikeBooxExport(current)).toBe(true);
    const { document, warnings } = await parseBooxExport(current);
    expect(document.books).toEqual([{ providerRecordId: expect.stringMatching(/^boox-book:/), title: "System for Writing", authors: ["Bob Doto"] }]);
    expect(document.annotations.map(({ text, note, location, createdAt }) => ({ text, note, location, createdAt }))).toEqual([
      { text: "The structure of a Luhmann-style zettelkasten is not predetermined.", note: "much like graphs", location: "Introduction · page 14", createdAt: new Date(2024, 9, 27, 7, 56).getTime() },
      { text: "Notes link to notes.", note: undefined, location: "Introduction · page 20", createdAt: new Date(2024, 9, 28, 21, 50).getTime() },
      { text: "Plain passage without quotes.", note: "A second note\nover two lines", location: "Chapter 2 · page 31", createdAt: new Date(2024, 9, 29, 6, 0).getTime() },
    ]);
    expect(warnings).toEqual([{ code: "skipped-records", message: "Skipped 1 entry Leaflogue could not read." }]);
  });

  it("reads exports from older firmware", async () => {
    const { document } = await parseBooxExport(legacy);
    expect(document.books[0]).toMatchObject({ title: "Trilogia de la Fundacion (Spanish Edition) - Isaac Asimov (146)", authors: ["Isaac Asimov"] });
    expect(document.annotations.map(({ text, note, location, createdAt }) => ({ text, note, location, createdAt }))).toEqual([
      { text: "ruegos", note: "requests", location: "Cuarta parte. Los comerciantes · page 442", createdAt: new Date(2021, 7, 17, 22, 48).getTime() },
    ]);
  });

  it("refuses text that is not a Boox export", async () => {
    expect(looksLikeBooxExport("My Clippings")).toBe(false);
    await expect(parseBooxExport("My Clippings")).rejects.toThrow("Not a Boox highlights export");
  });
});

describe("Boox notes folder", () => {
  it("merges several exports and keeps a re-exported passage once", async () => {
    const again = current.replace("Plain passage without quotes.", "A new passage.");
    const { document, warnings } = await parseBooxExports([current, legacy, again, "not an export"]);
    expect(document.books.map(({ title }) => title)).toEqual(["System for Writing", "Trilogia de la Fundacion (Spanish Edition) - Isaac Asimov (146)"]);
    expect(document.annotations.map(({ text }) => text)).toEqual([
      "The structure of a Luhmann-style zettelkasten is not predetermined.",
      "Notes link to notes.",
      "Plain passage without quotes.",
      "ruegos",
      "A new passage.",
    ]);
    expect(warnings.map(({ message }) => message)).toEqual(["Skipped 2 entries Leaflogue could not read.", "Skipped 1 export Leaflogue could not read."]);
  });
});
