import { expect, type Page } from "@playwright/test";
import { selectOption } from "./select";

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
