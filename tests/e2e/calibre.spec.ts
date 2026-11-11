import { DatabaseSync } from "node:sqlite";
import { copyFileSync, mkdirSync, readFileSync, renameSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { createProfile, launch, removeProfile } from "./harness";

test("links a Calibre EPUB without copying or changing the catalogue and follows renames", async () => {
  const profile = createProfile();
  try {
    const root = join(profile.files, "Calibre Library"); const folder = join(root, "A Reader", "A quiet beginning (1)"); mkdirSync(folder, { recursive: true });
    const dbPath = join(root, "metadata.db"); const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE library_id(uuid TEXT); CREATE TABLE books(id INTEGER, uuid TEXT, title TEXT, path TEXT, author_sort TEXT); CREATE TABLE data(book INTEGER,format TEXT,name TEXT); CREATE TABLE authors(id INTEGER,name TEXT); CREATE TABLE books_authors_link(book INTEGER,author INTEGER); CREATE TABLE identifiers(book INTEGER,type TEXT,val TEXT);
    INSERT INTO library_id VALUES('11111111-1111-4111-8111-111111111111'); INSERT INTO books VALUES(1,'22222222-2222-4222-8222-222222222222','A quiet beginning','A Reader/A quiet beginning (1)','A Reader'); INSERT INTO data VALUES(1,'EPUB','a-quiet-beginning'); INSERT INTO authors VALUES(1,'A Reader'); INSERT INTO books_authors_link VALUES(1,1); INSERT INTO identifiers VALUES(1,'isbn','9780306406157');`); db.close();
    const original = join(folder, "a-quiet-beginning.epub"); copyFileSync(resolve(__dirname, "../fixtures/local-reader.epub"), original);
    const before = readFileSync(dbPath);
    let session = await launch(profile); let page = session.page;
    await page.getByRole("button", { name: "Set up later" }).click();
    const id = await page.evaluate(async () => (await window.leaflogue.library.createBook({ title: "A quiet beginning", authors: ["A Reader"], isbn13: "9780306406157" })).id);
    await page.evaluate((bookId) => { location.hash = `#/library/${bookId}`; }, id);
    await page.getByRole("button", { name: "Read", exact: true }).click();
    await page.getByRole("button", { name: "Link from Calibre", exact: true }).click();
    await session.chooseFile(root);
    const picker = page.getByRole("dialog", { name: "Calibre library", exact: true });
    await picker.getByRole("button", { name: "Choose Calibre library", exact: true }).click();
    await picker.getByRole("radio", { name: /A quiet beginning A Reader/ }).check();
    await expect(picker).toContainText("ISBN match");
    await picker.getByRole("button", { name: "Link selected EPUB", exact: true }).click();
    await expect(picker).not.toBeVisible();
    await expect(page.frameLocator('iframe[title="EPUB pages"]').getByRole("heading", { name: "A quiet beginning", exact: true })).toBeVisible();
    expect(readFileSync(dbPath)).toEqual(before);
    expect(readdirSync(`${session.libraryFile}.epubs`).filter((file) => file.endsWith(".epub"))).toEqual([]);
    const reference = JSON.parse(readFileSync(join(`${session.libraryFile}.epubs`, `${id}.attachment.json`), "utf8")) as { calibre: { bookUuid: string } };
    expect(reference.calibre.bookUuid).toBe("22222222-2222-4222-8222-222222222222");
    await session.close();
    renameSync(original, join(folder, "renamed.epub"));
    const changed = new DatabaseSync(dbPath); changed.exec("UPDATE data SET name='renamed'"); changed.close();
    session = await launch(profile); page = session.page;
    await page.evaluate((bookId) => { location.hash = `#/library/${bookId}`; }, id);
    await page.getByRole("button", { name: "Read", exact: true }).click();
    await expect(page.frameLocator('iframe[title="EPUB pages"]').getByRole("heading", { name: "A quiet beginning", exact: true })).toBeVisible();
    await session.close();
  } finally { await removeProfile(profile); }
});
