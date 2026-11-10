import { describe, expect, it } from "vitest";
import { parseKOReaderSidecars } from "./koreader";

const current = `-- we can read Lua syntax here!
return {
    ["annotations"] = {
        [1] = {
            ["chapter"] = "The Orchard",
            ["datetime"] = "2025-03-02 21:14:05",
            ["drawer"] = "lighten",
            ["note"] = "Seasons as panes\\
of glass.",
            ["page"] = "/body/DocFragment[12]/body/p[3]/text().0",
            ["pageno"] = 41,
            ["pos0"] = "/body/DocFragment[12]/body/p[3]/text().0",
            ["pos1"] = "/body/DocFragment[12]/body/p[3]/text().52",
            ["text"] = "Every pane held a season.",
        },
        [2] = {
            ["datetime"] = "2025-03-03 08:00:00",
            ["page"] = "/body/DocFragment[13]",
            ["pageno"] = 44,
        },
    },
    ["doc_props"] = {
        ["authors"] = "Imogen Vale\\
A. Translator",
        ["description"] = "A novel.",
        ["identifiers"] = "uuid:1234\\
ISBN:978-0-306-40615-7",
        ["language"] = "en",
        ["series"] = "Glasshouse",
        ["series_index"] = 2,
        ["title"] = "The Glass Orchard",
    },
    ["partial_md5_checksum"] = "0123456789ABCDEF0123456789abcdef",
    ["summary"] = {
        ["modified"] = "2025-03-04",
        ["status"] = "complete",
    },
}
`;

const legacy = `return {
    ["bookmarks"] = {
        [1] = {
            ["datetime"] = "2019-06-01 10:00:00",
            ["highlighted"] = true,
            ["notes"] = "She pruned the light.",
            ["page"] = 7,
            ["text"] = "A gardener of hours.",
        },
        [2] = {
            ["datetime"] = "2019-06-01 11:00:00",
            ["highlighted"] = true,
            ["notes"] = "The frost kept its counsel.",
            ["page"] = 9,
            ["text"] = "Page 9 The frost kept its counsel. @ 2019-06-01 11:00:00",
        },
    },
    ["highlight"] = {
        [9] = {
            [1] = { ["datetime"] = "2019-06-01 11:00:00", ["pos0"] = "p9", ["text"] = "The frost kept its counsel." },
        },
        [7] = {
            [1] = { ["chapter"] = "One", ["datetime"] = "2019-06-01 10:00:00", ["pos0"] = "p7", ["text"] = "She pruned the light." },
        },
    },
}
`;

describe("KOReader import", () => {
  it("reads current sidecars: passages, notes, pages, times, and book details", async () => {
    const { document, warnings } = await parseKOReaderSidecars([{ path: "Books/Orchard.sdr/metadata.epub.lua", source: current }]);
    expect(document.books).toEqual([{
      providerRecordId: "koreader-book:0123456789abcdef0123456789abcdef",
      title: "The Glass Orchard",
      authors: ["Imogen Vale", "A. Translator"],
      isbn13: "9780306406157",
      description: "A novel.",
      series: "Glasshouse",
      seriesNumber: "2",
      language: "en",
      status: "finished",
    }]);
    expect(document.annotations).toEqual([{
      providerRecordId: expect.stringMatching(/^koreader:[0-9a-f]{64}:1$/),
      bookProviderRecordId: "koreader-book:0123456789abcdef0123456789abcdef",
      text: "Every pane held a season.",
      note: "Seasons as panes\nof glass.",
      location: "The Orchard · page 41",
      createdAt: new Date(2025, 2, 2, 21, 14, 5).getTime(),
    }]);
    expect(warnings).toEqual([{ code: "skipped-records", message: "Skipped 1 page bookmark without text." }]);
  });

  it("keeps an annotation's identity when only its note changes", async () => {
    const before = await parseKOReaderSidecars([{ path: "a.sdr/metadata.epub.lua", source: current }]);
    const after = await parseKOReaderSidecars([{ path: "a.sdr/metadata.epub.lua", source: current.replace("Seasons as panes", "Panes as seasons") }]);
    expect(after.document.annotations[0]!.providerRecordId).toBe(before.document.annotations[0]!.providerRecordId);
    expect(after.document.annotations[0]!.note).toContain("Panes as seasons");
  });

  it("reads legacy sidecars, joining notes by time and ignoring automatic labels", async () => {
    const { document } = await parseKOReaderSidecars([{ path: "Library/The Gardener.sdr/metadata.pdf.lua", source: legacy }]);
    expect(document.books[0]).toMatchObject({ title: "The Gardener", authors: [] });
    expect(document.annotations.map(({ text, note, location }) => ({ text, note, location }))).toEqual([
      { text: "She pruned the light.", note: "A gardener of hours.", location: "One · page 7" },
      { text: "The frost kept its counsel.", note: undefined, location: "Page 9" },
    ]);
  });

  it("imports a sidecar found twice only once, and skips files that are not sidecars", async () => {
    const { document, warnings } = await parseKOReaderSidecars([
      { path: "Orchard.sdr/metadata.epub.lua", source: current },
      { path: "koreader/docsettings/Orchard.sdr/metadata.epub.lua", source: current },
      { path: "broken.sdr/metadata.epub.lua", source: 'os.execute("touch /tmp/owned")' },
    ]);
    expect(document.books).toHaveLength(1);
    expect(document.annotations).toHaveLength(1);
    expect(warnings).toContainEqual({ code: "skipped-records", message: "Skipped 1 unreadable sidecar file." });
  });

  it("refuses a set with no sidecars or no highlights", async () => {
    await expect(parseKOReaderSidecars([])).rejects.toThrow("No KOReader sidecar files were found");
    await expect(parseKOReaderSidecars([{ path: "x.lua", source: "print(1)" }])).rejects.toThrow("These are not KOReader sidecar files");
    await expect(parseKOReaderSidecars([{ path: "x.lua", source: "return { doc_props = { title = \"Empty\" } }" }])).rejects.toThrow("No KOReader highlights or notes were found");
  });
});
