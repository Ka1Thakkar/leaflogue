import { selectOption } from "../shared/select";
import { expect, type Page } from "@playwright/test";
import type { Session } from "./harness";

/** Reader-level steps shared by the end-to-end specs. */

export async function openRail(page: Page, name: "Library" | "Highlights" | "Settings"): Promise<void> {
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await navigation.getByRole("link", { name: new RegExp(`^${name}`, "u") }).click();
}

/** Import is its own page, opened from the rail. */
export async function openImport(page: Page) {
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: /^Import/u }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Import" })).toBeVisible();
  return page.locator("main");
}

export interface ImportReview {
  readonly fileLabel: RegExp;
  readonly books: number;
  readonly annotations: number;
  readonly sourceName: string;
  readonly titles: readonly string[];
  /** KOReader highlights are chosen as a folder rather than a file. */
  readonly folder?: boolean;
  readonly separateCopies?: readonly string[];
}

/** Choose a file (or folder), check the review, name a new source, commit, and close. */
export async function importFile(session: Session, path: string, review: ImportReview): Promise<string> {
  const dialog = await openImport(session.page);
  await session.chooseFile(path);
  await dialog.getByRole("button", { name: review.folder ? "Choose folder" : /^Choose (file|a different file)$/u }).click();
  await expect(dialog.getByText(review.fileLabel)).toBeVisible();
  const tile = (label: string) => dialog.locator(".ui-tile").filter({ hasText: label });
  await expect(tile("Books in this file").locator(".ui-figure")).toHaveText(String(review.books));
  await expect(tile("With a highlight date").locator(".ui-sub")).toHaveText(`of ${review.annotations} annotation${review.annotations === 1 ? "" : "s"}`);
  const listed = dialog.getByRole("table", { name: "Books in this file" });
  for (const title of review.titles) await expect(listed.getByText(title, { exact: true })).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Import source" })).toContainText("Create a new source");
  for (const title of review.separateCopies ?? []) await selectOption(dialog.getByRole("combobox", { name: `Import ${title} into`, exact: true }), "new");
  await dialog.getByLabel("Name this source").fill(review.sourceName);
  await dialog.getByRole("button", { name: "Import highlights and notes" }).click();
  await expect(dialog.getByRole("status")).toContainText("Import complete:");
  const receipt = await dialog.getByRole("status").innerText();
  await openRail(session.page, "Library");
  return receipt;
}

/** Find a book by title from the library search; `highlightCount` separates duplicates. */
export async function openBook(page: Page, title: string, highlightCount?: number): Promise<void> {
  await openRail(page, "Library");
  await page.getByRole("searchbox", { name: "Search your library" }).fill(title);
  const links = page.getByRole("link", { name: `Open ${title}`, exact: true });
  const link = highlightCount === undefined
    ? links.first()
    : links.filter({ hasText: new RegExp(`Passages\\s*${highlightCount}(?!\\d)`, "u") });
  await link.click();
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
}

export function passage(page: Page, text: string) {
  return page.getByRole("article").filter({ hasText: text });
}

/** Answer one of Leaflogue's in-app confirmation dialogs, checking its title. */
export async function confirmDialog(page: Page, title: RegExp, confirmLabel: string): Promise<void> {
  const dialog = page.getByRole("dialog", { name: title });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: confirmLabel, exact: true }).click();
  await expect(dialog).toBeHidden();
}

/** Choose the library shelf, opening the filter panel if it is closed. */
export async function chooseShelf(page: Page, shelf: "active" | "archived"): Promise<void> {
  const select = page.getByRole("combobox", { name: "Shelf" });
  if (!await select.isVisible()) await page.getByRole("button", { name: /^Filters/ }).click();
  await selectOption(select, shelf);
}
