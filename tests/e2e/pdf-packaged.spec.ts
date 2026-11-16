import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
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
    app.page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await completeLocalSetup(app.page);
    await app.page.evaluate(() => localStorage.setItem("leaflogue.reader-display", JSON.stringify({ dark: true, theme: true })));
    await app.page.reload();
    const setup = await app.page.evaluate(async () => ({ id: (await window.leaflogue.library.createBook({ title: "Packaged PDF", authors: [] })).id, file: (await window.leaflogue.system.getCapabilities()).storagePaths.libraryFile }));
    const bytes = !scanned && process.env.LEAFLOGUE_TEST_PDF ? await readFile(process.env.LEAFLOGUE_TEST_PDF) : readerPdf(scanned);
    const source = join(profile.files, "sample.pdf"); await writeFile(source, bytes);
    await mkdir(`${setup.file}.epubs`, { recursive: true });
    await writeFile(join(`${setup.file}.epubs`, `${setup.id}.attachment.json`), JSON.stringify({ path: source, sha256: createHash("sha256").update(bytes).digest("hex") }));
    await app.page.evaluate((id) => { location.hash = `#/library/${id}`; }, setup.id);
    await app.page.getByRole("button", { name: "Read", exact: true }).click();
    const reader = app.page.frameLocator('iframe[title="PDF pages"]');
    const first = reader.locator('article[data-chapter="0"] .pdf-page-image');
    await expect(first).toHaveAttribute("data-rendered", "true"); await expect(first).toBeInViewport();
    expect(await first.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(300);
    await app.page.getByRole("button", { name: "Expand context panel", exact: true }).click();
    await app.page.getByRole("button", { name: "Restore split view", exact: true }).click();
    await app.page.getByRole("button", { name: "Collapse context panel", exact: true }).click();
    await app.page.getByRole("button", { name: "Open context panel", exact: true }).click();
    await expect(first).toBeInViewport();
    await reader.locator("body").click(); await app.page.keyboard.press("ArrowRight");
    const second = reader.locator('article[data-chapter="1"] .pdf-page-image');
    await expect(second).toHaveAttribute("data-rendered", "true"); await expect(second).toBeInViewport(); await expect(first).not.toBeVisible();
    await app.page.keyboard.press("ArrowLeft"); await expect(first).toHaveAttribute("data-rendered", "true"); await expect(first).toBeInViewport();
    await app.page.screenshot({ path: test.info().outputPath("packaged-pdf.png") });
  } catch (error) { throw new Error(`Packaged PDF display failed. Console: ${errors.join("\n")}; stderr: ${app.stderr()}`, { cause: error }); }
  finally { await stopPackagedProcess(app.child); await app.browser.close(); await removeProfile(profile); }
});
