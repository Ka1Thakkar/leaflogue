import { expect, test } from "@playwright/test";
import { createProfile, launch, removeProfile, type Profile } from "./harness";

let profile: Profile;
test.beforeEach(() => { profile = createProfile(); });
test.afterEach(async () => { await removeProfile(profile); });

test("defines selected words through the real offline bridge and preserves keyboard focus", async () => {
  const session = await launch(profile);
  const { page } = session;
  await page.getByRole("button", { name: "Set up later" }).click();
  const trigger = page.getByRole("button", { name: "Offline dictionary", exact: true });
  await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
  await page.getByRole("combobox", { name: "Search books, passages, settings, and commands" }).fill("offline dictionary");
  await page.getByRole("option", { name: /Open offline dictionary/ }).click();
  const dialog = page.getByRole("dialog", { name: "Offline dictionary" });
  const field = dialog.getByRole("textbox", { name: "Word or phrase" });
  await expect(field).toBeFocused();
  await field.fill("serendipity");
  await dialog.getByRole("button", { name: "Define", exact: true }).click();
  await expect(dialog).toContainText("fortunate");
  await field.fill("zzzznotaword");
  await field.press("Enter");
  await expect(dialog).toContainText("No entry found");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();

  const bookId = await page.evaluate(async () => {
    const book = await window.leaflogue.library.createBook({ title: "Walden", authors: ["Henry David Thoreau"] });
    await window.leaflogue.library.createHighlight({ bookId: book.id, text: "I went to the woods because I wished to live deliberately." });
    return book.id;
  });
  await page.evaluate(id => { location.hash = `#/library/${id}`; }, bookId);
  const quote = page.locator("blockquote").filter({ hasText: "I went to the woods because I wished to live deliberately." }).first();
  await expect(quote).toBeVisible();
  // Select the actual word as a reader would, then release the mouse on the passage.
  await quote.evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const start = node.textContent?.indexOf("deliberately") ?? -1;
      if (start < 0) continue;
      const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + "deliberately".length);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); break;
    }
  });
  await page.getByRole("button", { name: "Define “deliberately”" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "deliberately", exact: true })).toBeVisible();
  for (const mode of ["light", "dark"] as const) {
    await page.evaluate(async next => { const appearance = await window.leaflogue.appearance.describe(); await window.leaflogue.appearance.save({ themeId: appearance.themeId, mode: next }); }, mode);
    await expect(page.locator("html")).toHaveAttribute("data-appearance", mode);
    await dialog.screenshot({ path: `/tmp/leaflogue-dictionary-dialog-${mode}.png` });
  }
  await page.screenshot({ path: "/tmp/leaflogue-offline-dictionary.png" });
  await session.close(); // Includes network-denial and unexpected native-dialog assertions.
});
