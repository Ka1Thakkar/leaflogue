import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createProfile, launch, removeProfile } from "./harness";
import { KOBO_BOOK, writeKoboDatabase } from "./fixtures";
import { importFile, openImport } from "./steps";
import { selectOption } from "../shared/select";

for (const ambiguous of [false, true]) test(`reconciles Kobo on a replica without import history (${ambiguous ? "ambiguous destinations" : "unique destination"})`, async () => {
  const profile = createProfile();
  try {
    let session = await launch(profile);
    await session.page.getByRole("button", { name: "Set up later" }).click();
    const file = writeKoboDatabase(profile.files);
    await importFile(session, file, { fileLabel: /KoboReader\.sqlite \(Kobo database\)/u, books: 1, annotations: 2, sourceName: "My Kobo", titles: [KOBO_BOOK.title] });
    const original = await session.page.evaluate(async () => {
      const book = (await window.leaflogue.library.listBooks())[0]!;
      return (await window.leaflogue.library.getBookContents(book.id))!;
    });
    const duplicate = ambiguous ? await session.page.evaluate(async (book) => (await window.leaflogue.library.createBook({ title: book.title, authors: book.authors })).id, original.book) : undefined;
    await session.close();
    // Sync currently transfers content but not these local import mappings.
    // Keep content unchanged while simulating a fresh synced replica.
    const db = new DatabaseSync(session.libraryFile);
    db.exec("PRAGMA foreign_keys=ON; BEGIN; DELETE FROM import_conflicts; DELETE FROM import_runs; DELETE FROM source_annotations; DELETE FROM source_books; DELETE FROM import_sources; COMMIT;");
    if (duplicate) for (const highlight of original.highlights) db.prepare("INSERT INTO highlights(id,book_id,text,source_location,source_created_at,created_at,updated_at) SELECT ?,?,text,source_location,source_created_at,created_at,updated_at FROM highlights WHERE id=?").run(randomUUID(), duplicate, highlight.id);
    db.close();
    session = await launch(profile);
    const review = await openImport(session.page);
    await session.chooseFile(file);
    await review.getByRole("button", { name: /^Choose file$/u }).click();
    const destination = review.getByRole("combobox", { name: `Import ${KOBO_BOOK.title} into`, exact: true });
    await expect(destination).toBeVisible();
    const commit = review.getByRole("button", { name: "Import highlights and notes", exact: true });
    await review.getByLabel("Name this source").fill("Same Kobo, laptop");
    if (ambiguous) {
      await expect(commit).toBeDisabled();
      await selectOption(destination, original.book.id);
    } else await expect(destination).toContainText("Keep existing:");
    await commit.click();
    await expect(review.getByRole("status")).toContainText("0 added, 0 updated, 1 existing book kept");
    const after = await session.page.evaluate(async (id) => ({ count: (await window.leaflogue.library.listBooks()).length, contents: await window.leaflogue.library.getBookContents(id) }), original.book.id);
    expect(after.count).toBe(ambiguous ? 2 : 1);
    expect(after.contents).toEqual(original);
    await session.chooseFile(file);
    await review.getByRole("button", { name: /^Choose file$/u }).click();
    await expect(review.getByLabel("Name this source")).not.toBeVisible();
    await expect(review.getByText("Keep existing book", { exact: true })).toBeVisible();
    await commit.click();
    await expect(review.getByRole("status")).toContainText("0 added, 0 updated, 1 existing book kept");
    await session.close();
  } finally { await removeProfile(profile); }
});
