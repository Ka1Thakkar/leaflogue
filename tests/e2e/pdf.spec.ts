import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { createProfile, launch, removeProfile } from "./harness";
import { readerPdf } from "./pdf-fixture";

test("reads PDF pages and shares highlights and notes with the library", async () => {
  const profile = createProfile();
  try {
    const file = join(profile.files, "text-book.pdf");
    const font = await readFile(join(dirname(createRequire(__filename).resolve("pdfjs-dist/package.json")), "standard_fonts", "LiberationSans-Regular.ttf"));
    await writeFile(file, readerPdf(false, font, true));
    let session = await launch(profile); let page = session.page;
    await page.getByRole("button", { name: "Set up later" }).click();
    const saved = await page.evaluate(async () => {
      const book = await window.leaflogue.library.createBook({ title: "PDF fixture", authors: [] });
      const highlight = await window.leaflogue.library.createHighlight({ bookId: book.id, text: "We read deliberately.", noteMarkdown: "A shared note" });
      return { bookId: book.id, highlightId: highlight.id };
    });
    await page.evaluate((id) => { location.hash = `#/library/${id}`; }, saved.bookId);
    await page.getByRole("button", { name: "Read", exact: true }).click();
    await session.chooseFile(file); await page.getByRole("button", { name: "Attach book file", exact: true }).click();
    let reader = page.frameLocator('iframe[title="PDF pages"]');
    await expect(reader.getByText("We read deliberately.", { exact: true })).toBeVisible();
    await expect(reader.locator(".pdf-page-image").first()).toHaveAttribute("data-rendered", "true");
    await expect.poll(async () => page.locator('iframe[title="PDF pages"]').evaluate((frame) => {
      const doc = (frame as HTMLIFrameElement).contentDocument!; const image = doc.querySelector<HTMLImageElement>(".pdf-page-image")!;
      const canvas = doc.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; canvas.getContext("2d")!.drawImage(image, 0, 0);
      return Array.from(canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data).some((value, i) => i % 4 < 3 && value < 200);
    })).toBe(true);
    await expect(page.getByRole("button", { name: /1 note: We read deliberately/ })).toBeVisible();
    await reader.locator("body").click({ button: "right" });
    const options = page.getByRole("dialog", { name: "Reader options", exact: true });
    const pixel = (x: number, y: number) => page.locator('iframe[title="PDF pages"]').evaluate((frame, point) => {
      const doc = (frame as HTMLIFrameElement).contentDocument!; const image = doc.querySelector<HTMLImageElement>(".pdf-page-image")!;
      if (image.dataset.rendered !== "true" || !image.complete || !image.naturalWidth) return [];
      const canvas = doc.createElement("canvas"); canvas.width = canvas.height = 1;
      canvas.getContext("2d")!.drawImage(image, point.x * image.naturalWidth / 400, point.y * image.naturalHeight / 500, 1, 1, 0, 0, 1, 1);
      return Array.from(canvas.getContext("2d")!.getImageData(0, 0, 1, 1).data).slice(0, 3);
    }, { x, y });
    const paperPixel = () => pixel(0, 0);
    const imagePixel = () => pixel(80, 300);
    await expect.poll(imagePixel).toEqual([82, 71, 66]);
    await expect.poll(paperPixel).toEqual([0, 0, 0]);
    const surround = page.getByRole("region", { name: "Book pages", exact: true });
    await expect(surround).toHaveCSS("background-color", "rgb(0, 0, 0)");
    await expect(reader.locator("body")).toHaveCSS("background-color", "rgb(0, 0, 0)");
    await expect(reader.locator("html")).toHaveCSS("background-color", "rgb(0, 0, 0)");
    await options.getByRole("tab", { name: "Appearance", exact: true }).click();
    await options.getByRole("switch", { name: "Dark mode", exact: true }).uncheck();
    await expect.poll(paperPixel).toEqual([255, 255, 255]);
    await expect(surround).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(reader.locator("body")).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await options.getByRole("switch", { name: "Use theme colours", exact: true }).check();
    const theme = await page.evaluate(async () => { const a = await window.leaflogue.appearance.describe(); return a.themes.find((t) => t.id === a.themeId)!; });
    const rgb = (hex: string) => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
    await expect.poll(async () => Math.max(...(await paperPixel()).map((channel, i) => Math.abs(channel - rgb(theme.light.paper)[i]!)))).toBeLessThanOrEqual(1);
    await expect(surround).toHaveCSS("background-color", `rgb(${rgb(theme.light.paper).join(", ")})`);
    await options.getByRole("switch", { name: "Dark mode", exact: true }).check();
    await expect.poll(async () => Math.max(...(await paperPixel()).map((channel, i) => Math.abs(channel - rgb(theme.dark.paper)[i]!)))).toBeLessThanOrEqual(1);
    await expect(surround).toHaveCSS("background-color", `rgb(${rgb(theme.dark.paper).join(", ")})`);
    await expect(reader.locator("body")).toHaveCSS("background-color", `rgb(${rgb(theme.dark.paper).join(", ")})`);
    await expect(reader.locator("html")).toHaveCSS("background-color", `rgb(${rgb(theme.dark.paper).join(", ")})`);
    await expect.poll(imagePixel).toEqual([82, 71, 66]);
    await expect(reader.locator("canvas")).toHaveCount(0);
    await options.getByRole("switch", { name: "Use theme colours", exact: true }).uncheck();
    await options.getByRole("tab", { name: "Book", exact: true }).click();
    await options.getByRole("combobox", { name: "PDF zoom", exact: true }).click(); await page.getByRole("option", { name: "150%", exact: true }).click();
    await expect(reader.locator(".pdf-sheet").first()).toHaveCSS("transform", "matrix(1.5, 0, 0, 1.5, 0, 0)");
    await options.getByRole("combobox", { name: "PDF zoom", exact: true }).click(); await page.getByRole("option", { name: "Fit page", exact: true }).click();
    await expect(page.getByRole("listbox")).not.toBeVisible();
    await page.keyboard.press("Escape");
    await expect(options).not.toBeVisible();
    await page.locator("#context-reader").click({ position: { x: 5, y: 5 } }); await page.keyboard.press("PageDown");
    await expect(reader.getByText("Return to this paragraph.", { exact: true })).toBeVisible();
    await page.keyboard.press("ArrowLeft");
    await expect(reader.locator('article[data-chapter="0"] .pdf-page-image')).toHaveAttribute("data-rendered", "true");
    await page.keyboard.press("ArrowRight");
    await expect(reader.locator('article[data-chapter="1"] .pdf-page-image')).toHaveAttribute("data-rendered", "true");
    await expect.poll(async () => page.locator('iframe[title="PDF pages"]').evaluate((frame) => Array.from((frame as HTMLIFrameElement).contentDocument!.fonts).filter((font) => font.family.startsWith("g_") && font.status === "loaded").length)).toBeGreaterThan(0);
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
    // Both quotes are found in the EPUB; only the open chapter is painted, and the two sit in different chapters.
    await expect.poll(async () => page.locator('iframe[title="EPUB pages"]').evaluate((frame) => {
      const inner = (frame as HTMLIFrameElement).contentWindow as Window & typeof globalThis;
      return inner.CSS.highlights.get("leaflogue-saved")?.size ?? 0;
    })).toBe(1);
    await page.frameLocator('iframe[title="EPUB pages"]').locator("body").click({ button: "right" });
    await expect(page.getByRole("dialog", { name: "Reader options", exact: true }).getByText("Highlights in this book (2)")).toBeVisible();
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
    await page.getByRole("button", { name: "Attach book file", exact: true }).click();
    const reader = page.frameLocator('iframe[title="PDF pages"]'); await expect(reader.locator(".pdf-page-image").first()).toHaveAttribute("data-rendered", "true");
    await expect.poll(async () => page.locator('iframe[title="PDF pages"]').evaluate((frame) => {
      const doc = (frame as HTMLIFrameElement).contentDocument!; const image = doc.querySelector<HTMLImageElement>(".pdf-page-image")!;
      const canvas = doc.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; canvas.getContext("2d")!.drawImage(image, 0, 0);
      return canvas.width > 300 && Array.from(canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data).some((value, i) => i % 4 < 3 && value < 100);
    })).toBe(true);
    expect(await reader.locator(".pdf-page-image").first().evaluate((image) => {
      const canvas = image.ownerDocument.createElement("canvas"); canvas.width = canvas.height = 1;
      canvas.getContext("2d")!.drawImage(image as HTMLImageElement, 0, 0);
      return Array.from(canvas.getContext("2d")!.getImageData(0, 0, 1, 1).data);
    })).toEqual([255, 255, 255, 255]);
    await expect(reader.locator("[data-paragraph]")).toHaveCount(0);
    await expect(page.getByText(/OCR|Image-only page/)).toHaveCount(0);
    await page.locator("#context-reader").click({ position: { x: 5, y: 5 } }); await page.keyboard.press("PageDown");
    await expect.poll(async () => page.evaluate(async (bookId) => (await window.leaflogue.epub!.open(bookId))?.position.chapter, id)).toBe(1);
    await session.close();
  } finally { await removeProfile(profile); }
});


test("preserves the original page when text overlaps artwork", async () => {
  const profile = createProfile();
  try {
    const file = join(profile.files, "overlap.pdf"); await writeFile(file, readerPdf(false, undefined, "overlap"));
    const session = await launch(profile); const { page } = session;
    await page.getByRole("button", { name: "Set up later" }).click();
    const id = await page.evaluate(async () => (await window.leaflogue.library.createBook({ title: "Overlapping artwork", authors: [] })).id);
    await page.evaluate((bookId) => { location.hash = `#/library/${bookId}`; }, id);
    await page.getByRole("button", { name: "Read", exact: true }).click(); await session.chooseFile(file);
    await page.getByRole("button", { name: "Attach book file", exact: true }).click();
    const reader = page.frameLocator('iframe[title="PDF pages"]');
    await expect(reader.locator(".pdf-page-image").first()).toHaveAttribute("data-rendered", "true");
    expect(await reader.locator(".pdf-page-image").first().evaluate((image) => {
      const canvas = image.ownerDocument.createElement("canvas"); canvas.width = canvas.height = 1;
      canvas.getContext("2d")!.drawImage(image as HTMLImageElement, 0, 0);
      return Array.from(canvas.getContext("2d")!.getImageData(0, 0, 1, 1).data);
    })).toEqual([255, 255, 255, 255]);
    await session.close();
  } finally { await removeProfile(profile); }
});
