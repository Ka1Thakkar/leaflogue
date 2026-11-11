import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  KINDLE_BOOK,
  KINDLE_NOTE,
  KINDLE_PASSAGE,
  KOBO_BOOK,
  KOBO_NOTE,
  KOBO_PASSAGES,
  PORTABLE_PASSAGES,
  writeInvalidBackup,
  writeKindleClippings,
  writeKoboDatabase,
  writePortableExport,
} from "./fixtures";
import { createProfile, launch, removeProfile, type Profile } from "./harness";
import { chooseShelf, confirmDialog, importFile, openBook, openImport, openRail, passage } from "./steps";

/**
 * The explicit `v0.1.0` local workflow, in order, through the real interface
 * of the built desktop app. Each step depends on the library the previous
 * steps left behind, so this is one test with named steps.
 */

let profile: Profile;
test.beforeEach(() => { profile = createProfile(); });
test.afterEach(async () => { await removeProfile(profile); });

const MANUAL_BOOK = "A Field Guide to Quiet Rooms";
const MANUAL_PASSAGE = "A quiet room is a promise kept by its walls.";
const MANUAL_NOTE = "First note, written by hand.";

test("completes the v0.1.0 local workflow without network access", async () => {
  const session = await launch(profile);
  const { page } = session;

  await test.step("launch without an account and choose local-only storage", async () => {
    const setup = page.getByRole("dialog", { name: "Your library starts on this computer." });
    await expect(setup).toBeVisible();
    await expect(setup.getByText(session.libraryFile)).toBeVisible();
    await setup.getByRole("button", { name: "Continue" }).click();
    const storage = page.getByRole("dialog", { name: "Would you like a remote library?" });
    await expect(storage.getByRole("radio", { name: /Local only/u })).toBeChecked();
    await storage.getByRole("button", { name: "Continue" }).click();
    const review = page.getByRole("dialog", { name: "Ready for your library." });
    await expect(review.getByText("Not configured")).toBeVisible();
    await review.getByRole("button", { name: "Open Leaflogue" }).click();
    await expect(review).toBeHidden();
    await expect(page.getByRole("status").filter({ hasText: "Saved locally" })).toBeVisible();
  });

  await test.step("create a library: the empty shelf, then a first book and passage", async () => {
    await expect(page.getByRole("heading", { name: "A place for what stays with you." })).toBeVisible();
    await page.getByRole("button", { name: "Add book" }).click();
    const form = page.getByRole("dialog", { name: "Add a book" });
    await form.getByLabel("Title").fill(MANUAL_BOOK);
    await form.getByLabel("Authors").fill("Nell Ashby");
    await form.getByRole("button", { name: "Add book" }).click();
    await expect(page.getByRole("heading", { level: 1, name: MANUAL_BOOK })).toBeVisible();
    await expect(page.getByRole("heading", { name: "No highlights yet" })).toBeVisible();

    await page.getByRole("button", { name: "Add highlight" }).click();
    const keep = page.getByRole("dialog", { name: "Keep a passage" });
    await keep.getByRole("textbox", { name: "Quote" }).fill(MANUAL_PASSAGE);
    await expect(keep.getByLabel("Location")).toHaveCount(0);
    await keep.getByLabel("Note").fill(MANUAL_NOTE);
    await keep.getByRole("button", { name: "Add highlight" }).click();
    await expect(keep).toBeHidden();
    await expect(passage(page, MANUAL_PASSAGE)).toContainText(MANUAL_NOTE);
    const sourceLocation = await page.evaluate(async () => {
      const bookId = window.location.hash.split("/")[2]!.split("?")[0]! as never;
      const { entries } = await window.leaflogue.library.listHighlights({ bookId, offset: 0, limit: 20 });
      return entries.find((entry) => entry.text === "A quiet room is a promise kept by its walls.")?.sourceLocation ?? null;
    });
    expect(sourceLocation).toBeNull();
    expect(existsSync(session.libraryFile)).toBe(true);
  });

  await test.step("import synthetic Kobo, Kindle, and portable files through source review", async () => {
    const kobo = await importFile(session, writeKoboDatabase(profile.files), {
      fileLabel: /KoboReader\.sqlite \(Kobo database\)/u, books: 1, annotations: 2, sourceName: "Kobo Clara", titles: [KOBO_BOOK.title],
    });
    expect(kobo).toMatch(/1 new book/u);
    const kindle = await importFile(session, writeKindleClippings(profile.files), {
      fileLabel: /My Clippings\.txt \(Kindle My Clippings\.txt\)/u, books: 1, annotations: 1, sourceName: "Kindle Paperwhite", titles: [KINDLE_BOOK],
    });
    expect(kindle).toMatch(/1 new book/u);
    const portable = await importFile(session, writePortableExport(profile.files), {
      fileLabel: /reading-export\.json \(Portable JSON\)/u, books: 2, annotations: 2, sourceName: "Reading export", titles: ["The Glass Orchard", "Notes on Tidewater"], separateCopies: ["The Glass Orchard"],
    });
    expect(portable).toMatch(/2 new books/u);
    await openRail(page, "Library");
    await expect(page.getByText("5 books", { exact: true })).toBeVisible();
  });

  await test.step("browse books, passages, and notes", async () => {
    await openBook(page, KOBO_BOOK.title, 2);
    await expect(page.getByRole("region", { name: "About this book" })).toContainText(KOBO_BOOK.author);
    await expect(passage(page, KOBO_PASSAGES[0])).toContainText(KOBO_NOTE);
    await expect(passage(page, KOBO_PASSAGES[1])).toBeVisible();

    await openRail(page, "Highlights");
    await expect(page.getByRole("heading", { level: 1, name: "Your highlights" })).toBeVisible();
    await page.getByRole("searchbox", { name: "Search quotes and notes" }).fill("lighthouse");
    const found = passage(page, KINDLE_PASSAGE);
    await expect(found).toContainText(KINDLE_NOTE);
    await expect(found.getByRole("link", { name: KINDLE_BOOK })).toBeVisible();
    await expect(page.getByRole("article")).toHaveCount(1);
  });

  await test.step("create and revision-safely edit annotations", async () => {
    await openBook(page, MANUAL_BOOK);
    const record = passage(page, MANUAL_PASSAGE);
    await record.getByRole("button", { name: "Add another note" }).click();
    const note = page.getByRole("dialog", { name: "Add a note" });
    await note.getByRole("textbox", { name: "Your note" }).fill("A second thought on walls.");
    await note.getByRole("button", { name: "Add note" }).click();
    await expect(record).toContainText("A second thought on walls.");

    await record.getByRole("complementary", { name: "Your note" }).filter({ hasText: MANUAL_NOTE }).getByRole("button", { name: "Edit note" }).click();
    await record.getByRole("textbox", { name: "Your note" }).fill("First note, revised by hand.");
    await record.getByRole("button", { name: "Save note" }).click();
    await expect(record).toContainText("First note, revised by hand.");

    // Open the editor, then let the same passage change underneath it through
    // the real IPC bridge, as a second window would. Saving the stale form must
    // be refused rather than overwrite the newer text.
    await record.getByRole("button", { name: "Edit quote" }).click();
    await record.getByRole("textbox", { name: "Quote" }).fill("This stale edit must not win.");
    const concurrent = "A quiet room is a promise its walls keep.";
    await page.evaluate(async (text) => {
      const bookId = window.location.hash.split("/")[2]!.split("?")[0]! as never;
      const { entries } = await window.leaflogue.library.listHighlights({ bookId, offset: 0, limit: 20 });
      const current = entries[0]!;
      await window.leaflogue.library.updateHighlight({ id: current.id, bookId, text, expectedRevision: current.revision });
    }, concurrent);
    await record.getByRole("button", { name: "Save changes" }).click();
    await expect(record.getByRole("alert")).toHaveText("This passage changed before it could be saved. Close this form and try again.");
    await record.getByRole("button", { name: "Cancel" }).click();

    await openBook(page, MANUAL_BOOK);
    const refreshed = passage(page, concurrent);
    await expect(refreshed).toBeVisible();
    await expect(page.getByText("This stale edit must not win.")).toHaveCount(0);
    await refreshed.getByRole("button", { name: "Edit quote" }).click();
    await refreshed.getByRole("textbox", { name: "Quote" }).fill(MANUAL_PASSAGE);
    await refreshed.getByRole("button", { name: "Save changes" }).click();
    await expect(passage(page, MANUAL_PASSAGE)).toBeVisible();
  });

  await test.step("archive and restore a book", async () => {
    await openBook(page, MANUAL_BOOK);
    await page.getByLabel("More book actions").click();
    await page.getByRole("menuitem", { name: "Archive book" }).click();
    await confirmDialog(page, /^Archive this book\?$/u, "Archive book");
    await expect(page.getByRole("heading", { level: 1, name: "Your library" })).toBeVisible();
    await expect(page.getByRole("link", { name: `Open ${MANUAL_BOOK}` })).toHaveCount(0);

    await chooseShelf(page, "archived");
    await expect(page.getByRole("heading", { level: 1, name: "Archived books" })).toBeVisible();
    await page.getByRole("link", { name: `Open ${MANUAL_BOOK}` }).click();
    await expect(page.getByText("This book is archived.", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add highlight" })).toHaveCount(0);
    await expect(passage(page, MANUAL_PASSAGE).getByRole("button", { name: "Edit quote" })).toHaveCount(0);
    await page.getByLabel("More book actions").click();
    await page.getByRole("menuitem", { name: "Restore to library" }).click();
    await expect(page.getByRole("button", { name: "Add highlight" })).toBeVisible();

    await openRail(page, "Library");
    await expect(page.getByRole("link", { name: `Open ${MANUAL_BOOK}` })).toBeVisible();
  });

  await test.step("review and merge duplicate books", async () => {
    await openBook(page, KOBO_BOOK.title, 2);
    await page.getByText("Merge duplicate").click();
    await page.getByRole("searchbox", { name: "Find another copy" }).fill("Glass");
    await expect(page.getByRole("combobox", { name: "Duplicate book" })).toContainText(`${KOBO_BOOK.title} — ${KOBO_BOOK.author}`);
    await expect(page.getByRole("combobox", { name: "Merge into" })).toContainText("(this book)");
    await page.getByRole("button", { name: "Merge books" }).click();
    await confirmDialog(page, /^Merge these books\?$/u, "Merge books");
    await expect(page.getByRole("button", { name: "Merging books..." })).toHaveCount(0);
    await expect(passage(page, PORTABLE_PASSAGES.orchard)).toBeVisible();
    await expect(page.getByRole("region", { name: "About this book" }).locator(".ui-tile").filter({ has: page.locator(".ui-label", { hasText: /^Passages$/u }) }).locator(".ui-figure")).toHaveText("3");

    await openRail(page, "Library");
    await expect(page.getByText("4 books", { exact: true })).toBeVisible();
    await chooseShelf(page, "archived");
    await expect(page.getByRole("link", { name: `Open ${KOBO_BOOK.title}` })).toHaveCount(1);
    await chooseShelf(page, "active");
  });

  await test.step("resolve an import conflict after a local edit and a changed source", async () => {
    await openBook(page, "Notes on Tidewater");
    const local = "The tide keeps its own calendar, as I read it.";
    const record = passage(page, PORTABLE_PASSAGES.tide);
    await record.hover();
    await record.getByRole("button", { name: "Edit quote" }).click();
    await record.getByRole("textbox", { name: "Quote" }).fill(local);
    await record.getByRole("button", { name: "Save changes" }).click();
    await expect(passage(page, local)).toBeVisible();

    const revised = writePortableExport(profile.files, true);
    const dialog = await openImport(page);
    await session.chooseFile(revised);
    await dialog.getByRole("button", { name: "Choose file" }).click();
    const source = dialog.getByLabel("Import source");
    await expect(source).toContainText("Reading export (suggested)");
    await expect(dialog.getByLabel("Name this source")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Import highlights and notes" }).click();
    await expect(dialog.getByRole("status")).toContainText("Import complete: 0 added, 0 updated, 2 existing books kept.");
    await dialog.getByRole("status").getByRole("link", { name: "1 conflicting version saved for review" }).click();

    await expect(page.getByRole("heading", { level: 1, name: "Review import changes" })).toBeVisible();
    const conflict = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Notes on Tidewater" }) });
    await expect(conflict).toContainText("Highlight from Reading export");
    await conflict.getByRole("button", { name: "Compare versions" }).click();
    await expect(conflict.getByRole("heading", { name: "Your current version" }).locator("..")).toContainText(local);
    await expect(conflict.getByRole("heading", { name: "Previously accepted source" }).locator("..")).toContainText(PORTABLE_PASSAGES.tide);
    await expect(conflict.getByRole("heading", { name: "Incoming source version" }).locator("..")).toContainText(PORTABLE_PASSAGES.tideRevised);
    await conflict.getByRole("button", { name: "Accept incoming source" }).click();
    await expect(page.getByText("No import conflicts need review.")).toBeVisible();

    await openBook(page, "Notes on Tidewater");
    await expect(passage(page, PORTABLE_PASSAGES.tideRevised)).toBeVisible();
    await expect(page.getByText(local)).toHaveCount(0);
  });

  await test.step("refuse a backup that aliases the open library through a directory symlink", async () => {
    const alias = join(profile.files, "library-alias");
    symlinkSync(dirname(session.libraryFile), alias, "dir");
    await openRail(page, "Settings");
    await session.saveFileAs(join(alias, basename(session.libraryFile)));
    await page.getByRole("button", { name: "Create backup" }).click();
    await expect(page.getByRole("alert")).toContainText("could not");
    await session.chooseFile(join(alias, basename(session.libraryFile)));
    await page.getByRole("button", { name: "Restore backup" }).click();
    await confirmDialog(page, /^Restore this backup\?$/u, "Choose backup");
    await expect(page.getByRole("alert")).toHaveText("That backup could not be restored. Your current library was kept.");
    await openBook(page, MANUAL_BOOK);
    await expect(passage(page, MANUAL_PASSAGE)).toBeVisible();
  });

  const backup = join(profile.files, "leaflogue-backup.sqlite");
  await test.step("create a verified backup", async () => {
    await openRail(page, "Settings");
    await session.saveFileAs(backup);
    await page.getByRole("button", { name: "Create backup" }).click();
    await expect(page.getByText("Backup saved as leaflogue-backup.sqlite.")).toBeVisible();
    expect(readFileSync(backup).subarray(0, 16).toString("latin1")).toBe("SQLite format 3\u0000");
  });

  await test.step("refuse an invalid backup and keep the current library", async () => {
    await openRail(page, "Library");
    await page.getByRole("button", { name: "Add book" }).click();
    const form = page.getByRole("dialog", { name: "Add a book" });
    await form.getByLabel("Title").fill("Added after the backup");
    await form.getByRole("button", { name: "Add book" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Added after the backup" })).toBeVisible();

    await openRail(page, "Settings");
    await session.chooseFile(writeInvalidBackup(profile.files));
    await page.getByRole("button", { name: "Restore backup" }).click();
    await confirmDialog(page, /^Restore this backup\?$/u, "Choose backup");
    await expect(page.getByRole("alert")).toHaveText("That backup could not be restored. Your current library was kept.");
    await openRail(page, "Library");
    await expect(page.getByRole("link", { name: "Open Added after the backup" })).toBeVisible();
  });

  await test.step("restore the verified backup and keep every reviewed change", async () => {
    await openRail(page, "Settings");
    await session.chooseFile(backup);
    await page.getByRole("button", { name: "Restore backup" }).click();
    await confirmDialog(page, /^Restore this backup\?$/u, "Choose backup");
    await expect(page.getByText("Restored 5 books from leaflogue-backup.sqlite.")).toBeVisible();

    await openRail(page, "Library");
    await expect(page.getByText("4 books", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open Added after the backup" })).toHaveCount(0);
    await openBook(page, KOBO_BOOK.title, 3);
    await expect(passage(page, PORTABLE_PASSAGES.orchard)).toBeVisible();
    await openBook(page, "Notes on Tidewater");
    await expect(passage(page, PORTABLE_PASSAGES.tideRevised)).toBeVisible();
  });

  await session.close();

  await test.step("reopen the restored library from disk", async () => {
    const reopened = await launch(profile);
    await expect(reopened.page.getByRole("status").filter({ hasText: "Saved locally" })).toBeVisible();
    await expect(reopened.page.getByRole("dialog")).toHaveCount(0);
    await openBook(reopened.page, MANUAL_BOOK);
    await expect(passage(reopened.page, MANUAL_PASSAGE)).toContainText("First note, revised by hand.");
    await reopened.close();
  });
});
