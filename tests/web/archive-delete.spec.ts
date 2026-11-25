import { expect, test } from "@playwright/test";
import { chooseShelf, confirmDialog } from "../shared/library";

test("the shared Add flow and archived deletion work through the hosted adapter", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add to library", exact: true }).click();
  const add = page.getByRole("dialog", { name: "Add to your library" });
  await expect(add.getByRole("combobox", { name: "What are you adding?" })).toHaveCount(0);
  await add.getByLabel("Title", { exact: true }).fill("An archived browser item");
  await add.getByRole("button", { name: "Add book", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "An archived browser item" })).toBeVisible();
  await page.getByLabel("More book actions").click();
  await page.getByRole("menuitem", { name: "Archive book" }).click();
  await confirmDialog(page, /^Archive this book\?$/u, "Archive book");
  await chooseShelf(page, "archived");
  await page.getByRole("link", { name: "Open An archived browser item", exact: true }).click();
  await page.getByLabel("More book actions").click();
  await page.getByRole("menuitem", { name: "Delete permanently" }).click();
  await confirmDialog(page, /^Delete from your library\?$/u, "Delete permanently");
  await expect(page.getByRole("heading", { level: 1, name: "Your library" })).toBeVisible();
  await chooseShelf(page, "archived");
  await expect(page.getByRole("link", { name: "Open An archived browser item", exact: true })).toHaveCount(0);
});
