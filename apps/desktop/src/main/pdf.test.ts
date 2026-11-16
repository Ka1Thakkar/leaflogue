import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readerPdf } from "../../../../tests/e2e/pdf-fixture";
import { parsePdf } from "./pdf";
import { EpubStore } from "./epub";
describe("local PDF reading", () => {
  it("extracts text and inert positioned markup while accepting image-only pages", async () => {
    const book = await parsePdf(readerPdf());
    expect(book.format).toBe("pdf"); expect(book.chapters).toHaveLength(2);
    expect(book.chapters[0]?.text).toContain("We read deliberately.");
    expect(book.chapters[0]?.html).toContain("<canvas");
    const scan = await parsePdf(readerPdf(true));
    expect(scan.chapters).toHaveLength(2); expect(scan.chapters[0]?.paragraphs).toEqual([""]);
    expect(scan.chapters[0]?.html).not.toContain("data-paragraph");
    await expect(parsePdf(Buffer.from("not a PDF"))).rejects.toThrow();
  });
  it("keeps one linked file, verifies bytes, persists PDF positions and retains originals", async () => {
    const root = await mkdtemp(join(tmpdir(), "leaflogue-pdf-")); const id = "12345678-1234-4234-8234-123456789abc";
    try {
      const bytes = readerPdf(); const file = join(root, "original.pdf"); await writeFile(file, bytes);
      const store = new EpubStore(root); const book = await store.attach(id, file);
      await expect(store.attach(id, file)).rejects.toThrow(/already/u);
      expect(Buffer.from(await store.readPdf(id, book.sha256))).toEqual(bytes);
      await store.savePosition(id, book.sha256, 1, 0);
      expect((await new EpubStore(root).open(id))?.position.chapter).toBe(1);
      await writeFile(file, readerPdf(true)); await expect(store.readPdf(id, book.sha256)).rejects.toThrow(/changed/u);
      await store.unlink(id); const scan = await store.attach(id, file); await store.savePosition(id, scan.sha256, 1, 0);
      expect((await store.open(id))?.position.chapter).toBe(1);
      await store.unlink(id); expect(await readFile(file)).toEqual(readerPdf(true));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
