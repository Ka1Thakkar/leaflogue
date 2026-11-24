import type {} from "../e2e/env";
import { expect, test } from "@playwright/test";

test("article adapter shares confirmed highlights, typography and position in the headless reader", async ({ page }) => {
  await page.goto("/?reader=article#/library");
  const id = await page.evaluate(async () => {
    const book = (await window.leaflogue.library.listBooks())[0]!;
    location.hash = `#/library/${book.id}`; return book.id;
  });
  await page.getByRole("button", { name: "Read", exact: true }).click();
  const frame = page.frameLocator('iframe[title="Article pages"]');
  const paragraph = frame.locator('p[data-paragraph="0"]');
  await expect(paragraph).toBeVisible();
  await expect(page.getByRole("region", { name: "Local article reader", exact: true })).toContainText("Full article text stays on this computer");
  const selected = await paragraph.evaluate(element => {
    const doc = element.ownerDocument; const node = element.firstChild!;
    const range = doc.createRange(); range.setStart(node, 0); range.setEnd(node, 20);
    const selection = doc.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return range.toString();
  });
  const toolbar = page.getByRole("toolbar", { name: "Selected text actions", exact: true });
  await expect(toolbar).toBeVisible();
  await toolbar.getByRole("button", { name: "Highlight", exact: true }).click();
  await expect.poll(() => page.evaluate(async ({ id, selected }) => {
    const contents = await window.leaflogue.library.getBookContents(id);
    return contents?.highlights.find(item => item.text === selected)?.sourceLocation;
  }, { id, selected })).toMatch(/^article:[a-f\d]{64}:/u);
  await page.getByRole("region", { name: "Book pages", exact: true }).click({ button: "right" });
  const options = page.getByRole("dialog", { name: "Reader options", exact: true });
  await options.getByRole("tab", { name: "Text", exact: true }).click();
  await options.getByRole("spinbutton", { name: "Text size value", exact: true }).fill("23");
  await expect(paragraph).toHaveCSS("font-size", "23px");
  await options.getByRole("button", { name: "Close reader options", exact: true }).click();
  await page.keyboard.press("PageDown");
  await expect.poll(() => page.evaluate(async id => (await window.leaflogue.epub!.open(id))?.position.offset, id)).toBeGreaterThan(0);
});
