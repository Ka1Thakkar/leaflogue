import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { KOBO_BOOK, KOBO_NOTE, KOBO_PASSAGES, writeKoboDatabase } from "../e2e/fixtures";

/** A Kobo database read in the browser (SQLite in WebAssembly, in a worker) and sent to the server. */
test("imports a Kobo database from the browser", async ({ page }) => {
  const directory = mkdtempSync(join(tmpdir(), "leaflogue-web-import-"));
  try {
    const database = writeKoboDatabase(directory);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto("/");
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: /^Import/u }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Import" })).toBeVisible();
    const main = page.locator("main");
    // A browser reads chosen files; folders and plugged-in readers are the desktop app's.
    await expect(main.getByRole("button", { name: "Choose folder" })).toHaveCount(0);
    const chooser = page.waitForEvent("filechooser");
    await main.getByRole("button", { name: "Choose file" }).click();
    await (await chooser).setFiles(database);

    await expect(main.getByRole("table", { name: "Books in this file" }).getByText(KOBO_BOOK.title, { exact: true })).toBeVisible();
    await main.getByLabel("Name this source").fill("Kobo Clara");
    await main.getByRole("button", { name: "Import highlights and notes" }).click();
    await expect(main.getByRole("status")).toContainText("Import complete:");

    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: /^Library/u }).click();
    await page.getByRole("searchbox", { name: "Search your library" }).fill(KOBO_BOOK.title);
    await page.getByRole("link", { name: `Open ${KOBO_BOOK.title}`, exact: true }).click();
    await expect(page.getByRole("article").filter({ hasText: KOBO_PASSAGES[0] })).toContainText(KOBO_NOTE);
    expect(errors).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
