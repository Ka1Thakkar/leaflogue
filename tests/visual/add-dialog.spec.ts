import { expect, test } from "@playwright/test";
import { selectOption } from "../shared/select";

test("Add dialog has grouped, readable forms at every viewport", async ({ page }) => {
  await page.goto("/?capture#/library");
  await page.getByRole("button", { name: "Add to library", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add to your library" });
  await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  const helper = dialog.getByText("Separate authors with a new line or semicolon.");
  await expect(helper).toHaveCSS("text-transform", "none");
  await expect(dialog).toHaveScreenshot("add-book-dialog.png");
  await selectOption(dialog.getByRole("combobox", { name: "What are you adding?" }), "article");
  await expect(dialog.getByRole("form", { name: "Book details" })).toBeHidden();
  await expect(dialog.getByLabel("Article URL")).toBeVisible();
  await expect(dialog).toHaveScreenshot("add-article-dialog.png");
});
