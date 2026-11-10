import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BOOX_LIMITS, collectBooxExports, collectKOReaderSidecars, KOREADER_LIMITS } from "./reader-folders";

const roots: string[] = [];
function device(): string {
  const root = mkdtempSync(join(tmpdir(), "leaflogue-koreader-"));
  roots.push(root);
  return root;
}
function write(root: string, path: string, content = "return {}"): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("KOReader sidecar collection", () => {
  it("finds sidecars beside books and in KOReader's settings folders, including under .adds", () => {
    const root = device();
    write(root, "Books/Orchard.sdr/metadata.epub.lua");
    write(root, ".adds/koreader/docsettings/mnt/onboard/Harbour.sdr/metadata.pdf.lua");
    write(root, "koreader/hashdocsettings/01/0123456789abcdef0123456789abcdef.sdr/metadata.epub.lua");
    write(root, "Books/Orchard.epub", "not a sidecar");
    write(root, "Books/loose/metadata.epub.lua");
    write(root, ".Trash-1000/Old.sdr/metadata.epub.lua");
    expect(collectKOReaderSidecars(root).map(({ path }) => path)).toEqual([
      join(".adds/koreader/docsettings/mnt/onboard/Harbour.sdr/metadata.pdf.lua"),
      join("Books/Orchard.sdr/metadata.epub.lua"),
      join("koreader/hashdocsettings/01/0123456789abcdef0123456789abcdef.sdr/metadata.epub.lua"),
    ]);
  });

  it("never follows symbolic links and skips oversized or non-UTF-8 files", () => {
    const root = device();
    const outside = device();
    write(outside, "Secret.sdr/metadata.epub.lua", "return { secret = true }");
    symlinkSync(join(outside, "Secret.sdr"), join(root, "Linked.sdr"));
    mkdirSync(join(root, "Real.sdr"));
    symlinkSync(join(outside, "Secret.sdr/metadata.epub.lua"), join(root, "Real.sdr/metadata.epub.lua"));
    write(root, "Big.sdr/metadata.epub.lua", "x".repeat(64));
    write(root, "Bytes.sdr/metadata.epub.lua");
    writeFileSync(join(root, "Bytes.sdr/metadata.epub.lua"), Buffer.from([0xff, 0xfe]));
    expect(collectKOReaderSidecars(root, { ...KOREADER_LIMITS, fileBytes: 32 })).toEqual([]);
  });

  it("stops at the entry limit instead of walking forever", () => {
    const root = device();
    for (let index = 0; index < 5; index += 1) write(root, `Book ${index}.sdr/metadata.epub.lua`);
    expect(() => collectKOReaderSidecars(root, { ...KOREADER_LIMITS, entries: 4 })).toThrow("too many files");
  });
});

describe("Boox export collection", () => {
  const isExport = (source: string) => source.startsWith("Reading Notes |");
  it("reads only the Boox exports directly inside the folder", () => {
    const root = device();
    write(root, "Orchard.txt", "Reading Notes | <<Orchard>>Imogen Vale\n");
    write(root, "shopping.txt", "milk");
    write(root, "nested/Harbour.txt", "Reading Notes | <<Harbour>>Tomas Reyes\n");
    symlinkSync(join(root, "Orchard.txt"), join(root, "Linked.txt"));
    expect(collectBooxExports(root, isExport)).toEqual(["Reading Notes | <<Orchard>>Imogen Vale\n"]);
  });

  it("refuses a folder with too many text files", () => {
    const root = device();
    for (let index = 0; index < 3; index += 1) write(root, `${index}.txt`, "Reading Notes | <<x>>\n");
    expect(() => collectBooxExports(root, isExport, { ...BOOX_LIMITS, files: 2 })).toThrow("too many text files");
  });
});
