import { expect, test } from "@playwright/test";

test("changes a passage colour in one click and keeps its date and hover bar after reload", async ({ page, browser }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add book", exact: true }).click();
  const book = page.getByRole("dialog", { name: "Add a book", exact: true });
  await book.getByLabel("Title", { exact: true }).fill("Colour acceptance fixture");
  await book.getByRole("button", { name: "Add book", exact: true }).click();
  await page.getByRole("button", { name: "Add highlight", exact: true }).click();
  const passage = page.getByRole("dialog", { name: "Keep a passage", exact: true });
  await passage.getByRole("textbox", { name: "Quote", exact: true }).fill("A colourful line kept for later.");
  await passage.getByRole("button", { name: "Add highlight", exact: true }).click();
  await expect(passage).not.toBeVisible();
  const card = page.getByRole("article").filter({ hasText: "A colourful line kept for later." });
  await card.hover();
  const before = await card.locator("time").evaluate((node) => getComputedStyle(node).color);
  await card.getByRole("radio", { name: "green", exact: true }).check();
  await expect.poll(() => card.locator("time").evaluate((node) => getComputedStyle(node).color)).not.toBe(before);
  const ink = await card.locator("time").evaluate((node) => getComputedStyle(node).color);
  await expect(card).toHaveCSS("box-shadow", `${ink} 2px 0px 0px 0px inset`);
  await expect(card.getByRole("radiogroup")).toHaveAttribute("aria-busy", "false");
  // A different browser profile has none of the first device's local storage.
  const other = await browser.newContext();
  try {
    const second = await other.newPage();
    await second.goto(page.url());
    const secondCard = second.getByRole("article").filter({ hasText: "A colourful line kept for later." });
    await expect(secondCard.getByRole("radio", { name: "green", exact: true })).toBeChecked();
    await secondCard.hover();
    await secondCard.getByRole("radio", { name: "blue", exact: true }).check();
    await expect(secondCard.getByRole("radio", { name: "blue", exact: true })).toBeChecked();
    await expect(secondCard.getByRole("radiogroup")).toHaveAttribute("aria-busy", "false");
  } finally { await other.close(); }
  await page.reload();
  await expect(card.getByRole("radio", { name: "blue", exact: true })).toBeChecked();
  await expect(card.locator("time")).not.toHaveCSS("color", ink);
});
