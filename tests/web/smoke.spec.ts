import { expect, test } from "@playwright/test";

/** One reader's first visit: an empty library, a book, a passage and its note, and the parts a browser leaves out. */
test("keeps a first book and passage in the hosted library", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");
  await expect(page.getByRole("status").filter({ hasText: "Saved online" })).toBeVisible();

  await page.getByRole("button", { name: "Add book" }).click();
  const form = page.getByRole("dialog", { name: "Add a book" });
  await form.getByLabel("Title").fill("The Quiet Room");
  await form.getByLabel("Authors").fill("Nell Ashby");
  await form.getByRole("button", { name: "Add book" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "The Quiet Room" })).toBeVisible();

  await page.getByRole("button", { name: "Add highlight" }).click();
  const keep = page.getByRole("dialog", { name: "Keep a passage" });
  await keep.getByRole("textbox", { name: "Quote" }).fill("A quiet room is a promise kept by its walls.");
  await keep.getByLabel("Note").fill("Rooms as promises.");
  await keep.getByRole("button", { name: "Add highlight" }).click();
  await expect(keep).toBeHidden();
  const passage = page.getByRole("article").filter({ hasText: "A quiet room is a promise kept by its walls." });
  await expect(passage).toContainText("Rooms as promises.");

  // A reload reads everything back from the server.
  await page.reload();
  await expect(page.getByRole("article").filter({ hasText: "A quiet room is a promise kept by its walls." })).toContainText("Rooms as promises.");

  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: /^Highlights/u }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Your highlights" })).toBeVisible();
  await expect(page.getByRole("article").filter({ hasText: "A quiet room is a promise kept by its walls." })).toBeVisible();

  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: /^Settings/u }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  await expect(page.getByText("Signed in as reader@localhost.")).toBeVisible();
  const sections = page.getByRole("navigation", { name: "Settings sections" });
  await expect(sections.getByRole("button")).toHaveText(["Appearance", "Account", "Optional AI"]);
  for (const hidden of ["Backups and your data", "Themes folder", "Storage locations", "Check for updates"]) {
    await expect(page.getByText(hidden, { exact: true })).toHaveCount(0);
  }

  expect(errors).toEqual([]);
});

/** The library and statistics pages rearranged, kept on the server for this reader, with Leaflogue's own widgets only. */
test("customises a dashboard and keeps it across a reload", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // An empty library has nothing to arrange yet; add a passage first.
  await page.goto("/");
  await page.getByRole("button", { name: "Add book" }).click();
  const form = page.getByRole("dialog", { name: "Add a book" });
  await form.getByLabel("Title").fill("Harbour of Small Lights");
  await form.getByRole("button", { name: "Add book" }).click();
  await page.getByRole("button", { name: "Add highlight" }).click();
  const keep = page.getByRole("dialog", { name: "Keep a passage" });
  await keep.getByRole("textbox", { name: "Quote" }).fill("Every lamp in the harbour kept its own small hour.");
  await keep.getByRole("button", { name: "Add highlight" }).click();
  await expect(keep).toBeHidden();

  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: /^Statistics/u }).click();
  await page.getByRole("button", { name: "Customise" }).click();
  const tray = page.getByRole("region", { name: "Add widgets" });
  await expect(tray).toBeVisible();
  await expect(tray.getByRole("button", { name: "New widget" })).toHaveCount(0);
  await expect(tray.getByRole("button", { name: "Import widgets" })).toHaveCount(0);
  const removed = page.getByRole("button", { name: /^Remove / }).first();
  const label = (await removed.getAttribute("aria-label"))!.replace(/^Remove /u, "");
  await removed.click();
  await expect(tray.getByRole("button", { name: label, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(tray).toBeHidden();

  await page.reload();
  await page.getByRole("button", { name: "Customise" }).click();
  await expect(page.getByRole("region", { name: "Add widgets" }).getByRole("button", { name: label, exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
