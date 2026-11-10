import { expect, test, type Page } from "@playwright/test";

/** ⌘K in the browser: the library's books and passages, the web app's settings, and only actions a browser can run. */

const mod = process.platform === "darwin" ? "Meta" : "Control";

async function openPalette(page: Page) {
  await page.keyboard.press(`${mod}+k`);
  const palette = page.getByRole("dialog", { name: "Search and commands" });
  await expect(palette.getByRole("combobox", { name: "Search books, passages, settings, and commands" })).toBeFocused();
  return palette;
}

async function search(page: Page, text: string) {
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.type(text);
}

test("searches the hosted library and offers what the web app can do", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");
  await expect(page.getByRole("status").filter({ hasText: "Saved online" })).toBeVisible();
  await page.getByRole("button", { name: "Add book" }).click();
  const form = page.getByRole("dialog", { name: "Add a book" });
  await form.getByLabel("Title").fill("The Lantern Ledger");
  await form.getByLabel("Authors").fill("Mira Okafor");
  await form.getByRole("button", { name: "Add book" }).click();
  await page.getByRole("button", { name: "Add highlight" }).click();
  const keep = page.getByRole("dialog", { name: "Keep a passage" });
  await keep.getByRole("textbox", { name: "Quote" }).fill("Ledgers remember what lanterns only lit for a moment.");
  await keep.getByRole("button", { name: "Add highlight" }).click();
  await expect(keep).toBeHidden();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: /^Library/u }).click();

  const palette = await openPalette(page);
  const options = palette.getByRole("option");

  await test.step("books and passages are found", async () => {
    await search(page, "lantern ledger");
    await expect(options.first()).toContainText("The Lantern Ledger");
    await search(page, "lanterns only lit");
    await expect(palette.getByRole("option").filter({ hasText: "Ledgers remember what lanterns only lit" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
  });

  await test.step("actions leave out files on this computer, backups, updates, and sync", async () => {
    await openPalette(page);
    await search(page, ">");
    await expect(options.filter({ hasText: "Import highlights from a file" })).toHaveCount(1);
    await expect(options.filter({ hasText: "Sign out" })).toHaveCount(1);
    for (const desktop of ["Export your library", "Create a backup", "Check for updates", "Sync now"]) {
      await expect(options.filter({ hasText: desktop })).toHaveCount(0);
    }
    await search(page, "/");
    await expect(options.filter({ hasText: "Review synced changes" })).toHaveCount(0);
    await search(page, "themes folder");
    await expect(options.filter({ hasText: /^Themes folder/u })).toHaveCount(0);
  });

  await test.step("a setting opens Settings at its control", async () => {
    await search(page, "appearance mode");
    await expect(options.first()).toContainText("Light or dark mode");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Appearance mode" })).toBeFocused();
  });

  await test.step("switching light and dark runs from the palette", async () => {
    const before = await page.locator("html").getAttribute("data-appearance");
    await openPalette(page);
    await search(page, ">switch to");
    // Enter runs what is shown, so wait for the action to be listed first.
    await expect(palette.getByRole("option").first()).toContainText(/switch to/iu);
    await page.keyboard.press("Enter");
    await expect(page.locator("html")).not.toHaveAttribute("data-appearance", before ?? "");
  });

  await test.step("a book opens from the palette", async () => {
    await openPalette(page);
    await search(page, "lantern ledger");
    await expect(palette.getByRole("option").first()).toContainText("The Lantern Ledger");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: "The Lantern Ledger" })).toBeVisible();
  });

  expect(errors).toEqual([]);
});
