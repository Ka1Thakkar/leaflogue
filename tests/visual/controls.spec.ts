import { expect, test } from "@playwright/test";
import { selectOption } from "../shared/select";

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date("2026-11-09T12:00:00Z") });
});

test("custom selects support keyboard dismissal, typeahead, and empty filter values", async ({ page }) => {
  await page.goto("/#/settings");
  const mode = page.getByRole("combobox", { name: "Appearance mode" });
  await expect(mode).toBeVisible();
  const previous = await mode.textContent();
  await mode.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(mode).toBeFocused();
  await expect(mode).toHaveText(previous!);
  await mode.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("l");
  await expect(page.getByRole("option", { name: "Light", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-appearance", "light");
  await expect(page.locator("select:visible")).toHaveCount(0);

  await page.goto("/#/library");
  await page.getByRole("button", { name: /^Filters/ }).click();
  const shelf = page.getByRole("combobox", { name: "Shelf" });
  await selectOption(shelf, "archived");
  await expect(page.getByRole("heading", { name: "Archived books", exact: true })).toBeVisible();
  await selectOption(shelf, "active");
  const collections = page.getByRole("combobox", { name: "Collection", exact: true });
  await selectOption(collections, "");
  await expect(collections).toContainText("All collections");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("select options stay in the native dialog's top layer", async ({ page }) => {
  await page.goto("/#/library");
  await page.getByRole("button", { name: "Customise", exact: true }).click();
  await page.getByRole("button", { name: "New widget", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New widget" });
  await expect(dialog).toBeVisible();
  const group = dialog.getByLabel("Group by", { exact: true });
  await group.click();
  const list = page.getByRole("listbox");
  await expect(list).toBeVisible();
  expect(await list.evaluate(element => element.closest("dialog")?.open)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(group).toBeFocused();
  await selectOption(group, "weekday");
  await expect(group).toContainText("Weekday");
});

test("the custom calendar validates typed dates and restores focus", async ({ page }) => {
  await page.goto("/#/library");
  await page.getByRole("link", { name: "Open Piranesi", exact: true }).click();
  await selectOption(page.getByRole("combobox", { name: "Reading status" }), "finished");
  const input = page.getByRole("textbox", { name: "Completion date", exact: true });
  await input.fill("2025-02-29");
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await input.fill("2024-02-29");
  await expect(input).not.toHaveAttribute("aria-invalid", "true");
  await page.getByRole("button", { name: "Choose completion date" }).click();
  const calendar = page.getByRole("dialog", { name: "Choose a date", exact: true });
  await expect(calendar).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(calendar).toBeHidden();
  await expect(input).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("the shared multi-select searches within a dialog and dismisses one layer at a time", async ({ page }) => {
  await page.goto("/#/highlights");
  await page.getByRole("article").first().hover();
  await page.getByRole("button", { name: "Add to thematic thread" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Thematic threads", exact: true });
  const picker = dialog.getByRole("button", { name: "Threads", exact: true });
  await picker.click();
  const search = page.getByRole("searchbox", { name: "Search threads" });
  await search.fill("architecture");
  await expect(page.getByRole("checkbox", { name: "Impossible architecture" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(search).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(picker).toBeFocused();
});
