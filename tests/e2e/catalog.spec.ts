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
