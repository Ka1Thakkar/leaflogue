import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import { createProfile, removeProfile } from "./harness";
import { completeLocalSetup, launchPackagedApp, stopPackagedProcess } from "./packaged-process";
import { readerPdf } from "./pdf-fixture";
const executable = process.env.LEAFLOGUE_PACKAGED_EXECUTABLE;
for (const scanned of [false, true]) test(`displays ${scanned ? "image-only" : "text"} PDF pages in the packaged reader after resizing and keyboard navigation`, async () => {
  test.skip(!executable, "Requires a native packaged executable");
  const profile = createProfile(); const app = await launchPackagedApp(executable!, profile);
  const errors: string[] = [];
  try {
    app.page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
    app.page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await completeLocalSetup(app.page);
    await app.page.evaluate(() => localStorage.setItem("leaflogue.reader-display", JSON.stringify({ dark: true, theme: true })));
    await app.page.reload();
    const setup = await app.page.evaluate(async () => ({ id: (await window.leaflogue.library.createBook({ title: "Packaged PDF", authors: [] })).id, file: (await window.leaflogue.system.getCapabilities()).storagePaths.libraryFile }));
    const font = await readFile(join(dirname(createRequire(__filename).resolve("pdfjs-dist/package.json")), "standard_fonts", "LiberationSans-Regular.ttf"));
    const bytes = !scanned && process.env.LEAFLOGUE_TEST_PDF ? await readFile(process.env.LEAFLOGUE_TEST_PDF) : readerPdf(scanned, font, !scanned);
    const source = join(profile.files, "sample.pdf"); await writeFile(source, bytes);
    await mkdir(`${setup.file}.epubs`, { recursive: true });
    await writeFile(join(`${setup.file}.epubs`, `${setup.id}.attachment.json`), JSON.stringify({ path: source, sha256: createHash("sha256").update(bytes).digest("hex") }));
    await app.page.evaluate((id) => { location.hash = `#/library/${id}`; }, setup.id);
    await app.page.getByRole("button", { name: "Read", exact: true }).click();
    const reader = app.page.frameLocator('iframe[title="PDF pages"]');
    const first = reader.locator('article[data-chapter="0"] .pdf-page-image');
    await expect(first).toHaveAttribute("data-rendered", "true"); await expect(first).toBeInViewport();
    expect(await first.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(300);
    const framePaper = await app.page.evaluate(async () => { const a = await window.leaflogue.appearance.describe(); return a.themes.find((t) => t.id === a.themeId)!.dark.paper; });
    const frameRgb = `rgb(${[1, 3, 5].map((offset) => parseInt(framePaper.slice(offset, offset + 2), 16)).join(", ")})`;
    await expect(reader.locator("body")).toHaveCSS("background-color", frameRgb);
    await expect(reader.locator("html")).toHaveCSS("background-color", frameRgb);
    await app.page.getByRole("button", { name: "Expand context panel", exact: true }).click();
    await app.page.getByRole("button", { name: "Restore split view", exact: true }).click();
    await app.page.getByRole("button", { name: "Collapse context panel", exact: true }).click();
    await app.page.getByRole("button", { name: "Open context panel", exact: true }).click();
    await expect(first).toBeInViewport();
    await reader.locator("body").click(); await app.page.keyboard.press("ArrowRight");
    const second = reader.locator('article[data-chapter="1"] .pdf-page-image');
    await expect(second).toHaveAttribute("data-rendered", "true"); await expect(second).toBeInViewport(); await expect(first).not.toBeVisible();
    if (!scanned) await expect.poll(async () => app.page.locator('iframe[title="PDF pages"]').evaluate((frame) => Array.from((frame as HTMLIFrameElement).contentDocument!.fonts).filter((font) => font.family.startsWith("g_") && font.status === "loaded").length)).toBeGreaterThan(0);
    await app.page.screenshot({ path: test.info().outputPath("packaged-pdf-text.png") });
    await app.page.keyboard.press("ArrowLeft"); await expect(first).toHaveAttribute("data-rendered", "true"); await expect(first).toBeInViewport();
    await app.page.screenshot({ path: test.info().outputPath("packaged-pdf.png") });
    const chapter = Number(process.env.LEAFLOGUE_TEST_PDF_CHAPTER ?? 0);
    if (!scanned && process.env.LEAFLOGUE_TEST_PDF && Number.isInteger(chapter) && chapter > 0 && chapter < 1000) {
      for (let index = 1; index <= chapter; index++) {
        await app.page.keyboard.press("ArrowRight");
        await expect(reader.locator(`article[data-chapter="${index}"] .pdf-page-image`)).toHaveAttribute("data-rendered", "true");
      }
      const paper = await app.page.evaluate(async () => { const a = await window.leaflogue.appearance.describe(); return a.themes.find((t) => t.id === a.themeId)!.dark.paper; });
      const expected = [1, 3, 5].map((offset) => parseInt(paper.slice(offset, offset + 2), 16));
      const actual = await reader.locator(`article[data-chapter="${chapter}"] .pdf-page-image`).evaluate((image) => {
        const canvas = image.ownerDocument.createElement("canvas"); canvas.width = canvas.height = 1;
        canvas.getContext("2d")!.drawImage(image as HTMLImageElement, 0, 0);
        return Array.from(canvas.getContext("2d")!.getImageData(0, 0, 1, 1).data).slice(0, 3);
      });
      expect(Math.max(...actual.map((value, index) => Math.abs(value - expected[index]!)))).toBeLessThanOrEqual(1);
      await app.page.screenshot({ path: test.info().outputPath("packaged-pdf-chapter.png") });
    }
  } catch (error) { await app.page.screenshot({ path: test.info().outputPath("failure.png") }); throw new Error(`Packaged PDF display failed. State: ${JSON.stringify(await app.page.evaluate(() => ({ active: document.activeElement?.outerHTML.slice(0, 300), tabs: Array.from(document.querySelectorAll("[role=tab]"), (tab) => [tab.textContent, tab.getAttribute("aria-selected")]), frames: document.querySelectorAll("iframe").length })))}. Console: ${errors.join("\n")}; stderr: ${app.stderr()}`, { cause: error }); }
  finally { await stopPackagedProcess(app.child); await app.browser.close(); await removeProfile(profile); }
});
