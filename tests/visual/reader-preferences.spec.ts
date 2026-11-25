import type {} from "../e2e/env";
import { expect, test, type Page } from "@playwright/test";

async function openReader(page: Page) {
  await page.goto("/?reader=epub#/library");
  await page.evaluate(async () => { const book = (await window.leaflogue.library.listBooks())[0]!; location.hash = `#/library/${book.id}`; });
  await page.getByRole("button", { name: "Read", exact: true }).click();
  await expect(page.frameLocator('iframe[title="EPUB pages"]').locator("p[data-paragraph='0']")).toBeVisible();
}
async function options(page: Page) {
  await page.getByRole("region", { name: "Book pages", exact: true }).click({ button: "right" });
  return page.getByRole("dialog", { name: "Reader options", exact: true });
}

test("reader typography, layout, presets and quiet information work without Electron", async ({ page }) => {
  await openReader(page);
  const dialog = await options(page);
  await dialog.getByRole("tab", { name: "Text", exact: true }).click();
  await dialog.getByRole("spinbutton", { name: "Text size value", exact: true }).fill("23");
  await dialog.getByRole("button", { name: "Increase text weight", exact: true }).click();
  await dialog.getByRole("button", { name: "Justified", exact: true }).click();
  const frame = page.frameLocator('iframe[title="EPUB pages"]');
  await expect(frame.locator('p[data-paragraph="0"]')).toHaveCSS("font-size", "23px");
  await expect(frame.locator('p[data-paragraph="0"]')).toHaveCSS("font-weight", "500");
  await expect(frame.locator("strong").first()).toHaveCSS("font-weight", "800");
  await expect(frame.locator("em").first()).toHaveCSS("font-style", "italic");
  await expect(frame.getByRole("heading")).toHaveCSS("text-align", "center");
  await expect(frame.getByText("A centered dedication")).toHaveCSS("text-align", "center");
  await expect(frame.locator('p[data-paragraph="0"]')).toHaveCSS("text-align", "justify");
  for (const [name, value] of [["Line spacing", "1.8"], ["Paragraph spacing", "0.5"], ["Paragraph indentation", "1"]]) {
    await dialog.getByRole("checkbox", { name: `Use publisher ${name!.toLowerCase()}`, exact: true }).uncheck();
    await dialog.getByRole("spinbutton", { name: `${name} value`, exact: true }).fill(value!);
  }
  await expect(frame.locator('p[data-paragraph="0"]')).toHaveCSS("line-height", "41.4px");
  await dialog.getByText("Advanced spacing", { exact: true }).click();
  await dialog.getByRole("spinbutton", { name: "Letter spacing value", exact: true }).fill("0.02");
  await dialog.getByRole("button", { name: "Off", exact: true }).click();
  await expect(frame.locator('p[data-paragraph="0"]')).toHaveCSS("hyphens", "none");
  await dialog.getByRole("tab", { name: "Layout", exact: true }).click();
  await dialog.getByRole("switch", { name: "Reading progress", exact: true }).check();
  await dialog.getByRole("switch", { name: "Chapter information", exact: true }).check();
  await dialog.getByRole("switch", { name: "Clock", exact: true }).check();
  await dialog.getByRole("button", { name: "Two", exact: true }).click();
  await dialog.getByRole("tab", { name: "Appearance", exact: true }).click();
  await dialog.getByRole("button", { name: "Sepia", exact: true }).click();
  await expect(frame.locator("body")).toHaveCSS("background-color", "rgb(33, 27, 20)");
  await dialog.getByRole("tab", { name: "Presets", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Preset name", exact: true }).fill("Evening");
  await dialog.getByRole("button", { name: "Save current preset", exact: true }).click();
  await dialog.getByRole("button", { name: "Reset all reading preferences", exact: true }).click();
  await expect(frame.locator('p[data-paragraph="0"]')).toHaveCSS("font-size", "18px");
  await dialog.getByRole("button", { name: "Apply Evening", exact: true }).click();
  await expect(frame.locator('p[data-paragraph="0"]')).toHaveCSS("font-size", "23px");
  await dialog.getByRole("button", { name: "Close reader options", exact: true }).click();
  await expect(page.getByLabel("Reading information", { exact: true })).toContainText("A quiet beginning");
  await expect(page.getByLabel("Reading information", { exact: true }).locator("time")).not.toBeEmpty();
  await page.keyboard.press("PageDown");
  await expect.poll(() => page.evaluate(() => window.leaflogue.reader!.open("bd809783-25e1-4d95-80a0-d03442a57d5c" as never).then((book) => book?.position.offset))).toBeGreaterThan(0);
  const saved = await page.evaluate(() => (JSON.parse(localStorage.getItem("leaflogue.reader-preferences.v1")!) as { global: { size: number; progress: boolean } }).global);
  expect(saved.size).toBe(23); expect(saved.progress).toBe(true);
});

test("reader preferences persist, per-book overrides isolate changes, and tabs use arrow keys", async ({ page }) => {
  await openReader(page);
  let dialog = await options(page);
  await dialog.getByRole("tab", { name: "Text", exact: true }).click();
  const size = dialog.getByRole("spinbutton", { name: "Text size value", exact: true });
  await size.fill(""); await size.pressSequentially("25");
  await expect(size).toHaveValue("25");
  await dialog.getByRole("tab", { name: "Presets", exact: true }).click();
  await dialog.getByRole("switch", { name: "Use separate preferences for this book", exact: true }).check();
  await dialog.getByRole("tab", { name: "Text", exact: true }).click();
  await dialog.getByRole("spinbutton", { name: "Text size value", exact: true }).fill("30");
  await dialog.getByRole("tab", { name: "Text", exact: true }).press("ArrowRight");
  await expect(dialog.getByRole("tab", { name: "Layout", exact: true })).toBeFocused();
  await page.reload(); await openReader(page); dialog = await options(page);
  await dialog.getByRole("tab", { name: "Text", exact: true }).click();
  await expect(dialog.getByRole("spinbutton", { name: "Text size value", exact: true })).toHaveValue("30");
  await dialog.getByRole("tab", { name: "Presets", exact: true }).click();
  await dialog.getByRole("switch", { name: "Use separate preferences for this book", exact: true }).uncheck();
  await dialog.getByRole("tab", { name: "Text", exact: true }).click();
  await expect(dialog.getByRole("spinbutton", { name: "Text size value", exact: true })).toHaveValue("25");
});

test("expanded two-column spreads preserve the current passage when typography changes", async ({ page }, info) => {
  test.skip(info.project.name !== "wide", "Two columns need the expanded desktop reader");
  await openReader(page);
  await page.getByRole("button", { name: "Expand context panel", exact: true }).click();
  let dialog = await options(page);
  await dialog.getByRole("tab", { name: "Layout", exact: true }).click();
  await dialog.getByRole("button", { name: "Two", exact: true }).click();
  const frame = page.frameLocator('iframe[title="EPUB pages"]');
  await expect(frame.locator("#reader-pages")).toHaveCSS("column-count", "2");
  await dialog.getByRole("button", { name: "Close reader options", exact: true }).click();
  for (let i = 0; i < 8; i++) await page.keyboard.press("PageDown");
  await expect.poll(() => page.evaluate(async () => (await window.leaflogue.reader!.open("bd809783-25e1-4d95-80a0-d03442a57d5c" as never))?.position.paragraph)).toBeGreaterThan(0);
  const saved = await page.evaluate(async () => (await window.leaflogue.reader!.open("bd809783-25e1-4d95-80a0-d03442a57d5c" as never))!.position);
  dialog = await options(page);
  await dialog.getByRole("tab", { name: "Text", exact: true }).click();
  await dialog.getByRole("spinbutton", { name: "Text size value", exact: true }).fill("31");
  const visible = await page.locator('iframe[title="EPUB pages"]').evaluate((element, anchor) => {
    const doc = (element as HTMLIFrameElement).contentDocument!;
    const paragraph = doc.querySelector(`[data-paragraph="${anchor.paragraph}"]`)!;
    const range = doc.createRange(); range.setStart(paragraph.firstChild!, anchor.offset ?? 0); range.setEnd(paragraph.firstChild!, (anchor.offset ?? 0) + 1);
    const rect = range.getBoundingClientRect(); const view = doc.getElementById("reader-scroll")!.getBoundingClientRect();
    return rect.left >= view.left - 1 && rect.right <= view.right + 1 && rect.top >= view.top - 1 && rect.bottom <= view.bottom + 1;
  }, saved);
  expect(visible).toBe(true);
});
