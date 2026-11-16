import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { createProfile, launch, removeProfile } from "./harness";
import { readerPdf } from "./pdf-fixture";

test("reads PDF pages and shares highlights and notes with the library", async () => {
  const profile = createProfile();
  try {
    const file = join(profile.files, "text-book.pdf"); await writeFile(file, readerPdf());
    let session = await launch(profile); let page = session.page;
    await page.getByRole("button", { name: "Set up later" }).click();
    const saved = await page.evaluate(async () => {
      const book = await window.leaflogue.library.createBook({ title: "PDF fixture", authors: [] });
      const highlight = await window.leaflogue.library.createHighlight({ bookId: book.id, text: "We read deliberately.", noteMarkdown: "A shared note" });
      return { bookId: book.id, highlightId: highlight.id };
    });
    await page.evaluate((id) => { location.hash = `#/library/${id}`; }, saved.bookId);
    await page.getByRole("button", { name: "Read", exact: true }).click();
    await session.chooseFile(file); await page.getByRole("button", { name: "Attach PDF", exact: true }).click();
    let reader = page.frameLocator('iframe[title="PDF pages"]');
    await expect(reader.getByText("We read deliberately.", { exact: true })).toBeVisible();
    await expect.poll(async () => page.locator('iframe[title="PDF pages"]').evaluate((frame) => {
      const canvas = (frame as HTMLIFrameElement).contentDocument!.querySelector("canvas")!;
      return Array.from(canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data).some((value, i) => i % 4 < 3 && value < 200);
    })).toBe(true);
    await expect(page.getByRole("button", { name: /1 note: We read deliberately/ })).toBeVisible();
    await reader.locator("body").click({ button: "right" });
    const options = page.getByRole("dialog", { name: "Reader options", exact: true });
    await options.getByRole("combobox", { name: "PDF zoom", exact: true }).click(); await page.getByRole("option", { name: "150%", exact: true }).click();
    await expect(reader.locator(".pdf-sheet").first()).toHaveCSS("transform", "matrix(1.5, 0, 0, 1.5, 0, 0)");
    await options.getByRole("combobox", { name: "PDF zoom", exact: true }).click(); await page.getByRole("option", { name: "Fit page", exact: true }).click();
    await expect(page.getByRole("listbox")).not.toBeVisible();
    await page.keyboard.press("Escape");
    await expect(options).not.toBeVisible();
    await page.locator("#context-reader").click({ position: { x: 5, y: 5 } }); await page.keyboard.press("PageDown");
    await expect(reader.getByText("Return to this paragraph.", { exact: true })).toBeVisible();
    await reader.getByText("Return to this paragraph.", { exact: true }).evaluate((element) => {
      const doc = element.ownerDocument; const range = doc.createRange(); range.selectNodeContents(element);
      doc.getSelection()!.removeAllRanges(); doc.getSelection()!.addRange(range); element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await page.getByRole("toolbar", { name: "Selected text actions", exact: true }).getByRole("button", { name: "Highlight", exact: true }).click();
    await expect.poll(async () => page.evaluate(async (id) => (await window.leaflogue.library.getBookContents(id))!.highlights.length, saved.bookId)).toBe(2);
    await expect.poll(async () => page.evaluate(async (id) => (await window.leaflogue.epub!.open(id))?.position.chapter, saved.bookId)).toBe(1);
    await session.close(); session = await launch(profile); page = session.page;
    await page.evaluate((id) => { location.hash = `#/library/${id}`; }, saved.bookId);
    await page.getByRole("button", { name: "Read", exact: true }).click(); reader = page.frameLocator('iframe[title="PDF pages"]');
    await expect(reader.getByText("Return to this paragraph.", { exact: true })).toBeVisible();
    const contents = await page.evaluate(async (id) => window.leaflogue.library.getBookContents(id), saved.bookId);
    expect(contents!.highlights.some((h) => h.id === saved.highlightId && h.notes[0]?.markdown === "A shared note")).toBe(true);
    // One linked file, even across formats. Unlink is required before attaching another.
    await session.chooseFile(resolve(__dirname, "../fixtures/local-reader.epub"));
    await expect(page.evaluate(async (id) => window.leaflogue.epub!.attach(id), saved.bookId)).rejects.toThrow(/already/u);
    await page.evaluate(async (id) => window.leaflogue.epub!.unlink!(id), saved.bookId);
    expect((await page.evaluate(async (id) => window.leaflogue.library.getBookContents(id), saved.bookId))!.highlights).toHaveLength(2);
    await session.chooseFile(resolve(__dirname, "../fixtures/local-reader.epub"));
    await page.evaluate(async (id) => window.leaflogue.epub!.attach(id), saved.bookId);
    await session.close(); session = await launch(profile); page = session.page;
    await page.evaluate((id) => { location.hash = `#/library/${id}`; }, saved.bookId); await page.getByRole("button", { name: "Read", exact: true }).click();
    await expect.poll(async () => page.locator('iframe[title="EPUB pages"]').evaluate((frame) => {
      const inner = (frame as HTMLIFrameElement).contentWindow as Window & typeof globalThis;
      return inner.CSS.highlights.get("leaflogue-saved")?.size ?? 0;
    })).toBe(2);
    await session.close();
  } finally { await removeProfile(profile); }
});

test("reads image-only PDFs without OCR messages or fabricated highlights", async () => {
  const profile = createProfile();
  try {
    const file = join(profile.files, "scan.pdf"); await writeFile(file, readerPdf(true));
    const session = await launch(profile); const { page } = session;
    await page.getByRole("button", { name: "Set up later" }).click();
    const id = await page.evaluate(async () => (await window.leaflogue.library.createBook({ title: "Scanned PDF", authors: [] })).id);
    await page.evaluate((bookId) => { location.hash = `#/library/${bookId}`; }, id);
    await page.getByRole("button", { name: "Read", exact: true }).click(); await session.chooseFile(file);
    await page.getByRole("button", { name: "Attach PDF", exact: true }).click();
    const reader = page.frameLocator('iframe[title="PDF pages"]'); await expect(reader.locator("canvas").first()).toBeVisible();
    await expect.poll(async () => page.locator('iframe[title="PDF pages"]').evaluate((frame) => {
      const canvas = (frame as HTMLIFrameElement).contentDocument!.querySelector("canvas")!;
      return canvas.width > 300 && Array.from(canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data).some((value, i) => i % 4 < 3 && value < 100);
    })).toBe(true);
    await expect(reader.locator("[data-paragraph]")).toHaveCount(0);
    await expect(page.getByText(/OCR|Image-only page/)).toHaveCount(0);
    await page.locator("#context-reader").click({ position: { x: 5, y: 5 } }); await page.keyboard.press("PageDown");
    await expect.poll(async () => page.evaluate(async (bookId) => (await window.leaflogue.epub!.open(bookId))?.position.chapter, id)).toBe(1);
    await session.close();
  } finally { await removeProfile(profile); }
});
