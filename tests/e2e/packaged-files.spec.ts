import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test, type Page } from "@playwright/test";
import { KOBO_BOOK, KOBO_NOTE, KOBO_PASSAGES, writeKoboDatabase } from "./fixtures";
import { createProfile, networkActivity, removeProfile } from "./harness";
import { answerNativeFileDialog, nativeDialogsAvailable } from "./native-file-dialog";
import { completeLocalSetup, launchPackagedApp, stopPackagedProcess, type PackagedApp } from "./packaged-process";
import { confirmDialog, openRail, passage } from "./steps";

/**
 * The packaged app's file workflows through the real system file dialogs:
 * import a Kobo database, back up, change the library, restore the backup,
 * and export, all offline. Linux only: it needs X11 and xdotool to answer the
 * GTK file chooser (see native-file-dialog.ts).
 */

const configuredExecutable = process.env.LEAFLOGUE_PACKAGED_EXECUTABLE?.trim();

/** Click `trigger` and answer the file dialog it opens. */
async function throughDialog(click: () => Promise<void>, title: string, path: string, kind: "open" | "save"): Promise<void> {
  await Promise.all([answerNativeFileDialog(title, path, kind), click()]);
}

async function bookLink(page: Page, title: string) {
  await openRail(page, "Library");
  return page.getByRole("link", { name: `Open ${title}`, exact: true });
}

// In a Docker container, give Chromium room: Docker's default 64 MiB
// /dev/shm crashes the renderer right after the import commits, which first
// looked like a hung commit (the commit itself takes milliseconds). Run the
// container with `--shm-size=2g` (or `--ipc=host`); CI runners need nothing.
test("the packaged app imports, backs up, restores, and exports through system file dialogs", async () => {
  test.skip(!configuredExecutable, "Set LEAFLOGUE_PACKAGED_EXECUTABLE to an extracted AppImage executable");
  test.skip(!(await nativeDialogsAvailable()), "Needs Linux with X11 and xdotool to answer the system file dialogs");
  test.setTimeout(180_000);
  const executable = resolve(configuredExecutable!);
  const profile = createProfile();
  mkdirSync(profile.files, { recursive: true });
  const kobo = writeKoboDatabase(profile.files);
  const backup = join(profile.files, "leaflogue-backup.sqlite");
  const exported = join(profile.files, "leaflogue-export.json");
  let app: PackagedApp | undefined;
  try {
    app = await launchPackagedApp(executable, profile);
    const { page } = app;
    await completeLocalSetup(page);

    await test.step("import a Kobo database", async () => {
      await openRail(page, "Library");
      await page.getByRole("button", { name: "Import", exact: true }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Import" })).toBeVisible();
      const dialog = page.locator("main");
      await throughDialog(() => dialog.getByRole("button", { name: /^Choose (file|a different file)$/u }).click(), "Choose reading annotations", kobo, "open");
      await expect(dialog.getByRole("table", { name: "Books in this file" }).getByText(KOBO_BOOK.title, { exact: true })).toBeVisible();
      await dialog.getByLabel("Name this source").fill("Packaged Kobo");
      await dialog.getByRole("button", { name: "Import highlights and notes" }).click();
      await expect(dialog.getByRole("status")).toContainText("Import complete:");
      await openRail(page, "Library");
      await (await bookLink(page, KOBO_BOOK.title)).click();
      await expect(passage(page, KOBO_PASSAGES[0])).toContainText(KOBO_NOTE);
    });

    await test.step("save a backup", async () => {
      await openRail(page, "Settings");
      await throughDialog(() => page.getByRole("button", { name: "Create backup" }).click(), "Back up Leaflogue", backup, "save");
      await expect(page.getByText("Backup saved as leaflogue-backup.sqlite.")).toBeVisible();
      const database = new DatabaseSync(backup, { readOnly: true });
      try {
        expect(database.prepare("SELECT count(*) AS count FROM books WHERE title = ?").get(KOBO_BOOK.title)).toEqual({ count: 1 });
      } finally {
        database.close();
      }
    });

    await test.step("restore the backup over a changed library", async () => {
      await openRail(page, "Library");
      await page.getByRole("button", { name: "Add book" }).click();
      const form = page.getByRole("dialog", { name: "Add a book" });
      await form.getByLabel("Title").fill("Added after the backup");
      await form.getByRole("button", { name: "Add book" }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Added after the backup" })).toBeVisible();

      await openRail(page, "Settings");
      await page.getByRole("button", { name: "Restore backup" }).click();
      await throughDialog(() => confirmDialog(page, /^Restore this backup\?$/u, "Choose backup"), "Restore a Leaflogue backup", backup, "open");
      await expect(page.getByText("Restored 1 book from leaflogue-backup.sqlite.")).toBeVisible();
      await expect(await bookLink(page, "Added after the backup")).toHaveCount(0);
      await expect(await bookLink(page, KOBO_BOOK.title)).toBeVisible();
    });

    await test.step("export the library", async () => {
      await openRail(page, "Settings");
      await page.getByRole("button", { name: "Export your library" }).click();
      const choices = page.getByRole("dialog", { name: "Export your library" });
      await choices.getByRole("radio", { name: /^JSON/u }).check();
      await throughDialog(() => choices.getByRole("button", { name: "Export", exact: true }).click(), "Export Leaflogue library", exported, "save");
      await expect.poll(() => existsSync(exported)).toBe(true);
      expect(readFileSync(exported, "utf8")).toContain(KOBO_PASSAGES[1]);
    });

    await app.quit();
    expect(networkActivity(app.netLog), "packaged Chromium renderer or browser service used the network").toEqual([]);
  } finally {
    if (app && process.env.LEAFLOGUE_E2E_DIALOG_SHOTS) process.stdout.write(`packaged stderr:\n${app.stderr()}\n`);
    if (app) await stopPackagedProcess(app.child);
    await removeProfile(profile);
  }
});
