import { describe, expect, it } from "vitest";
import { looksLikeTolinoNotes, parseTolinoDate, parseTolinoNotes } from "./tolino";

const SEPARATOR = "\n-----------------------------------\n";
// Entries as published by open-source Tolino tools (tolino-notes, tolino2md).
const compact = [
  'Ender\'s Game (Card, Orson Scott)\nHighlight on page 77: "Ender laughed. "I\'ll set up a system for you."\n"Now?"\nAdded on 08/20/2023 | 7:48',
  'Ender\'s Game (Card, Orson Scott)\nNotiz auf Seite 99: Test Note\n"Double quotes" at beginning.\n"Then run the simulations and see which ones are hardest, which easiest. "\nHinzugefügt am 20.08.2023 | 15:46',
  'Miss Merkel (Safier, David)\nMarkierung"In diesem Moment realisierte Angela."\nGeändert am 21.08.2022 | 22:55',
  'Ender\'s Game (Card, Orson Scott)\nBookmark on page 20: "The enemy\'s gate is down."\nAdded on 08/21/2023 | 9:00',
  'Dune (Book 1) (Herbert, Frank)\nHighlight on page 3: "Fear is the mind-killer."\nAdded on 11/13/2021 | 6:26',
].join(SEPARATOR);
const spaced = `Some Fancy Book (Somebody, Whosanauthor)

Markierung auf Seite 35: "It is vitally important to read fancy books."

Hinzugefügt am 09.09.2024 | 8:09


-----------------------------------

Less Fancy Book (Person, Author)

Notiz auf Seite 98-99:

I find this important!

"Things have to change, there need to be more fancy books"

Geändert am 11.09.2024 | 8:26
`;

describe("Tolino import", () => {
  it("reads compact entries in English and German, skipping bookmarks", async () => {
    const { document, warnings } = await parseTolinoNotes(compact);
    expect(document.books.map(({ title, authors }) => ({ title, authors }))).toEqual([
      { title: "Ender's Game", authors: ["Card, Orson Scott"] },
      { title: "Miss Merkel", authors: ["Safier, David"] },
      { title: "Dune (Book 1)", authors: ["Herbert, Frank"] },
    ]);
    expect(document.annotations.map(({ text, note, location, createdAt }) => ({ text, note, location, createdAt }))).toEqual([
      { text: 'Ender laughed. "I\'ll set up a system for you."\n"Now?', note: undefined, location: "Page 77", createdAt: new Date(2023, 7, 20, 7, 48).getTime() },
      { text: "Then run the simulations and see which ones are hardest, which easiest.", note: 'Test Note\n"Double quotes" at beginning.', location: "Page 99", createdAt: new Date(2023, 7, 20, 15, 46).getTime() },
      { text: "In diesem Moment realisierte Angela.", note: undefined, location: undefined, createdAt: new Date(2022, 7, 21, 22, 55).getTime() },
      { text: "Fear is the mind-killer.", note: undefined, location: "Page 3", createdAt: new Date(2021, 10, 13, 6, 26).getTime() },
    ]);
    expect(warnings).toEqual([{ code: "skipped-records", message: "Skipped 1 bookmark." }]);
  });

  it("reads entries spread over blank lines, with page ranges and multi-line notes", async () => {
    const { document } = await parseTolinoNotes(spaced);
    expect(document.annotations.map(({ text, note, location }) => ({ text, note, location }))).toEqual([
      { text: "It is vitally important to read fancy books.", note: undefined, location: "Page 35" },
      { text: "Things have to change, there need to be more fancy books", note: "I find this important!", location: "Page 98-99" },
    ]);
  });

  it("gives an entry the same identity on the next import even when its note changes", async () => {
    const before = await parseTolinoNotes(compact);
    const after = await parseTolinoNotes(compact.replace("Test Note", "Edited note"));
    expect(after.document.annotations.map(({ providerRecordId }) => providerRecordId)).toEqual(before.document.annotations.map(({ providerRecordId }) => providerRecordId));
  });

  it("recognises Tolino's file and not Kindle's", () => {
    expect(looksLikeTolinoNotes(compact)).toBe(true);
    expect(looksLikeTolinoNotes(spaced)).toBe(true);
    expect(looksLikeTolinoNotes("Book (Author)\n- Your Highlight on Location 1-2 | Added on Monday, May 4, 2020 1:00:00 PM\n\nText\n==========\n")).toBe(false);
  });

  it("reads dates the way each language writes them", () => {
    expect(parseTolinoDate("Added on 08/20/2023 | 7:48")).toBe(new Date(2023, 7, 20, 7, 48).getTime());
    expect(parseTolinoDate("Toegevoegd op 03/04/2021 | 18:26")).toBe(new Date(2021, 3, 3, 18, 26).getTime());
    expect(parseTolinoDate("Ajouté le 13.11.2021 | 18:26")).toBe(new Date(2021, 10, 13, 18, 26).getTime());
    expect(parseTolinoDate("Hinzugefügt am 31.02.2021 | 18:26")).toBeUndefined();
  });

  it("refuses a file without entries", async () => {
    await expect(parseTolinoNotes("just some text")).rejects.toThrow("No Tolino highlights or notes were found");
  });
});

describe("Tolino limits", () => {
  it("reads a long run of blank lines in linear time", async () => {
    const source = `${compact}\n${"\n".repeat(1 << 20)}`;
    const started = performance.now();
    expect(looksLikeTolinoNotes(source)).toBe(true);
    await parseTolinoNotes(source);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
