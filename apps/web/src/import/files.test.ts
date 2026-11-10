/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from "vitest";
import { readImportFiles } from "./files";

const KINDLE = "Piranesi (Susanna Clarke)\n- Your Highlight on page 3 | Location 40-41 | Added on Monday, 6 October 2026 10:00:00\n\nThe Beauty of the House is immeasurable.\n==========\n";

describe("reading an import in the browser", () => {
  it("tells Kindle clippings apart from other text", async () => {
    const read = await readImportFiles([new File([KINDLE], "My Clippings.txt")]);
    expect(read.provider).toBe("kindle");
    expect(read.fileName).toBe("My Clippings.txt");
    expect(read.preview.document.annotations.map(({ text }) => text)).toEqual(["The Beauty of the House is immeasurable."]);
  });

  it("sends an e-reader database to the database reader, and refuses what is not one", async () => {
    const bytes = new Uint8Array(200);
    bytes.set([..."SQLite format 3\0"].map((character) => character.charCodeAt(0)));
    const readDatabase = vi.fn(() => Promise.resolve({ provider: "kobo" as const, preview: { document: { formatVersion: 1 as const, books: [], annotations: [] }, warnings: [] } }));
    expect(await readImportFiles([new File([bytes], "KoboReader.sqlite")], readDatabase)).toMatchObject({ provider: "kobo", fileName: "KoboReader.sqlite" });
    await expect(readImportFiles([new File([new Uint8Array(200)], "notes.db")], readDatabase)).rejects.toThrow("not an e-reader database");
    expect(readDatabase).toHaveBeenCalledOnce();
  });

  it("takes several files only as KOReader sidecars or Boox exports", async () => {
    await expect(readImportFiles([new File([KINDLE], "a.txt"), new File([KINDLE], "b.txt")])).rejects.toThrow("several KOReader or Boox");
    await expect(readImportFiles([])).rejects.toThrow("Choose a file");
  });
});
