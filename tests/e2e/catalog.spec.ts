import { expect, test } from "@playwright/test";
import { createProfile, launch, removeProfile } from "./harness";

test("searches Google Books through IPC and adds the selected edition with metadata", async () => {
  const profile = createProfile();
  try {
    const session = await launch(profile);
    const { page } = session;
    // Keep this repeatable and offline while exercising the real main-process search.
    await session.app.evaluate(() => {
      globalThis.fetch = async (input) => {
        const url = String(input);
        if (!url.startsWith("https://www.googleapis.com/books/v1/volumes?") || new URL(url).searchParams.get("q") !== "A quiet beginning") throw new Error("Unexpected catalogue request");
        return new Response(JSON.stringify({ items: [{ id: "reader-fixture", volumeInfo: { title: "A quiet beginning", authors: ["A Reader"], publisher: "Quiet Press", description: "A book about reading.", language: "en", industryIdentifiers: [{ type: "ISBN_13", identifier: "9780306406157" }] } }] }), { status: 200 });
      };
    });
    await page.getByRole("button", { name: "Set up later" }).click();
    await page.getByRole("button", { name: "Add book", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add a book", exact: true });
    await dialog.getByRole("textbox", { name: "Search books online" }).fill("A quiet beginning");
    // Results arrive after the debounce without pressing Search or Enter.
    await dialog.getByRole("button", { name: /A quiet beginning A Reader/ }).click();
    await expect(dialog.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("A quiet beginning");
    await dialog.getByRole("button", { name: "Add book", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const books = await page.evaluate(() => window.leaflogue.library.listBooks());
    expect(books).toHaveLength(1);
    expect(books[0]).toMatchObject({ title: "A quiet beginning", authors: ["A Reader"], isbn13: "9780306406157", publisher: "Quiet Press", language: "en", description: "A book about reading." });
    await session.close();
  } finally { await removeProfile(profile); }
});

test("suggests existing series while allowing new names and clearing a series", async () => {
  const profile = createProfile();
  try {
    const session = await launch(profile); const { page } = session;
    await page.getByRole("button", { name: "Set up later" }).click();
    const id = await page.evaluate(async () => {
      const existing = await window.leaflogue.library.createBook({ title: "An existing volume", authors: [] });
      await window.leaflogue.library.updateBookMetadata({ id: existing.id, expectedRevision: existing.revision, title: existing.title, authors: [], series: "Dungeon Crawler Carl" });
      return (await window.leaflogue.library.createBook({ title: "Another volume", authors: [] })).id;
    });
    await page.evaluate((bookId) => { location.hash = `#/library/${bookId}`; }, id);
    const open = async () => {
      await page.getByRole("button", { name: "Edit metadata", exact: true }).click();
      return page.getByRole("dialog", { name: "Edit book metadata", exact: true });
    };
    let dialog = await open();
    const field = () => dialog.getByRole("combobox", { name: "Series", exact: true });
    const publisher = dialog.getByRole("textbox", { name: "Publisher", exact: true });
    const appearance = await publisher.evaluate((input) => { const css = getComputedStyle(input); return { border: css.borderTopStyle, font: css.fontSize, height: input.getBoundingClientRect().height }; });
    await expect(field()).toHaveCSS("border-top-style", appearance.border);
    await expect(field()).toHaveCSS("font-size", appearance.font);
    expect(await field().evaluate((input) => input.getBoundingClientRect().height)).toBe(appearance.height);
    const siblingTop = await dialog.getByRole("textbox", { name: "Series number", exact: true }).evaluate((input) => input.getBoundingClientRect().top);
    expect(await field().evaluate((input) => input.getBoundingClientRect().top)).toBe(siblingTop);
    await dialog.screenshot({ path: test.info().outputPath("series-metadata.png") });
    await field().fill("dun");
    await page.getByRole("option", { name: "Dungeon Crawler Carl", exact: true }).click();
    await expect(field()).toHaveValue("Dungeon Crawler Carl");
    await dialog.getByRole("button", { name: "Save metadata", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect.poll(async () => page.evaluate(async (bookId) => (await window.leaflogue.library.getBookContents(bookId))!.book.series, id)).toBe("Dungeon Crawler Carl");
    dialog = await open(); await field().fill("My own new series");
    await expect(field()).toHaveValue("My own new series");
    await dialog.getByRole("button", { name: "Save metadata", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect.poll(async () => page.evaluate(async (bookId) => (await window.leaflogue.library.getBookContents(bookId))!.book.series, id)).toBe("My own new series");
    dialog = await open(); await field().fill("");
    await dialog.getByRole("button", { name: "Save metadata", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect.poll(async () => page.evaluate(async (bookId) => (await window.leaflogue.library.getBookContents(bookId))!.book.series, id)).toBeUndefined();
    await session.close();
  } finally { await removeProfile(profile); }
});
