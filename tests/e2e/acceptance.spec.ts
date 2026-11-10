import { selectOption } from "../shared/select";
import { expect, test, type Page } from "@playwright/test";
import { KOREADER_PASSAGE, PORTABLE_PASSAGES, TOLINO_NOTE, TOLINO_PASSAGE, writeKOReaderFolder, writeMalformedPortable, writePortableExport, writeTolinoNotes } from "./fixtures";
import { createProfile, launch, removeProfile, type Profile } from "./harness";
import { chooseShelf, importFile, openBook, openImport, openRail, passage } from "./steps";

/**
 * The accessibility and resilience checks for the `v0.1.0` workflow in the
 * real desktop shell: keyboard-only operation, the names a screen reader
 * announces, the 390px compact window, light and dark appearance, and the
 * empty and error states a new or unlucky reader meets. Every session also
 * runs under the harness's network denial.
 */

let profile: Profile;
test.beforeEach(() => { profile = createProfile(); });
test.afterEach(async () => { await removeProfile(profile); });

async function focusedName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (!active || active === document.body) return "";
    return (active.getAttribute("aria-label") ?? active.textContent ?? "").trim().replace(/\s+/gu, " ");
  });
}

/** Press Tab until the focused control has `name`, failing after `limit` presses. */
async function tabTo(page: Page, name: string | RegExp, limit = 30, key: "Tab" | "Shift+Tab" = "Tab"): Promise<void> {
  const matches = (value: string) => typeof name === "string" ? value === name : name.test(value);
  const reached: string[] = [];
  for (let step = 0; step < limit; step += 1) {
    await page.keyboard.press(key);
    const current = await focusedName(page);
    reached.push(current);
    if (matches(current)) return;
  }
  throw new Error(`${key} never reached ${String(name)}; reached ${reached.join(" | ")}`);
}

async function expectVisibleFocus(page: Page): Promise<void> {
  const ring = await page.evaluate(() => {
    const style = getComputedStyle(document.activeElement!);
    return style.outlineStyle !== "none" && style.outlineWidth !== "0px" ? "outline" : style.boxShadow;
  });
  expect(ring, "the focused control has no visible focus indicator").not.toBe("none");
}

/** Controls a screen reader would announce without a name. */
async function unnamedControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const name = (element: Element): string => (element.getAttribute("aria-label")
      ?? element.getAttribute("title")
      ?? (element.getAttribute("aria-labelledby")
        ? document.getElementById(element.getAttribute("aria-labelledby")!)?.textContent
        : undefined)
      ?? (element.id ? document.querySelector(`label[for="${element.id}"]`)?.textContent : undefined)
      ?? element.closest("label")?.textContent
      ?? element.textContent
      ?? "").trim();
    return [...document.querySelectorAll("button, a[href], select, input:not([type=hidden]), textarea, summary")]
      .filter((element) => element.checkVisibility() && !name(element))
      .map((element) => element.outerHTML.slice(0, 120));
  });
}

async function expectNoHorizontalOverflow(page: Page, where: string): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${where} scrolls sideways at compact width`).toBeLessThanOrEqual(0);
}

test("completes setup and core navigation with the keyboard alone", async () => {
  const session = await launch(profile);
  const { page } = session;

  await test.step("first-run setup cannot be dismissed and completes from the keyboard", async () => {
    const welcome = page.getByRole("dialog", { name: "Your library starts on this computer." });
    await expect(welcome).toBeVisible();
    await expect(welcome.getByRole("heading", { level: 1 })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(welcome).toBeVisible();
    await tabTo(page, /^Continue$/u, 6);
    await page.keyboard.press("Enter");
    const storage = page.getByRole("dialog", { name: "Would you like a remote library?" });
    await expect(storage.getByRole("heading", { level: 1 })).toBeFocused();
    // Tab passes through the storage choices; local-only is already chosen.
    await tabTo(page, /^Continue$/u, 6);
    await expect(storage.getByRole("radio", { name: /Local only/u })).toBeChecked();
    await page.keyboard.press("Enter");
    const review = page.getByRole("dialog", { name: "Ready for your library." });
    await tabTo(page, /^Open Leaflogue$/u, 6);
    await page.keyboard.press("Enter");
    await expect(review).toBeHidden();
  });

  await test.step("setup hands focus to the page, and the skip link returns there", async () => {
    await expect(page.locator("#content")).toBeFocused();
    await tabTo(page, "Skip to content", 30, "Shift+Tab");
    await expectVisibleFocus(page);
    await page.keyboard.press("Enter");
    await expect(page.locator("#content")).toBeFocused();
  });

  await test.step("empty states explain what to do next", async () => {
    await expect(page.getByRole("heading", { name: "A place for what stays with you." })).toBeVisible();
    await openRail(page, "Highlights");
    await expect(page.getByRole("heading", { name: "No highlights yet" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Go to your library" })).toBeVisible();
    const imports = await openImport(page);
    await imports.getByText("Import history").click();
    await expect(imports.getByText("No imports on this computer since Leaflogue opened.")).toBeVisible();
    await imports.getByRole("link", { name: "Review import conflicts" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Review import changes" })).toBeVisible();
    await expect(page.getByText("No import conflicts need review.")).toBeVisible();
    await openRail(page, "Library");
    await chooseShelf(page, "archived");
    await expect(page.getByRole("heading", { name: "No archived books" })).toBeVisible();
    await chooseShelf(page, "active");
  });

  await test.step("the rail is reachable in order, shows focus, and search is one shortcut away", async () => {
    await tabTo(page, "Skip to content", 30, "Shift+Tab");
    const order: string[] = [];
    for (let step = 0; step < 12 && !order.includes("Threads"); step += 1) {
      await page.keyboard.press("Tab");
      order.push(await focusedName(page));
    }
    expect(order.indexOf("Library")).toBeGreaterThan(-1);
    expect(order.indexOf("Highlights")).toBeGreaterThan(order.indexOf("Library"));
    expect(order.indexOf("Threads")).toBeGreaterThan(order.indexOf("Highlights"));
    await page.keyboard.press("Shift+Tab");
    expect(await focusedName(page)).toBe("Highlights");
    await expectVisibleFocus(page);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: "Your highlights" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Highlights" })).toHaveAttribute("aria-current", "page");
    await expect(page).toHaveTitle("Highlights | Leaflogue");

    await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
    const palette = page.getByRole("dialog", { name: "Search and commands" });
    await expect(palette.getByRole("combobox", { name: "Search books, passages, settings, and commands" })).toBeFocused();
    await page.keyboard.type("/statis");
    await expect(palette.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
    await expect(palette.getByRole("option").first()).toContainText("Statistics");
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
  });

  await test.step("a dialog opens on its first field, closes on Escape, restores focus, and submits", async () => {
    await openRail(page, "Library");
    const trigger = page.getByRole("button", { name: "Add book" });
    await tabTo(page, "Add book");
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Add a book" });
    await expect(dialog.getByLabel("Title")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    // The dialog's close event is delivered as a separate task; a reader
    // cannot press Enter inside that window, so wait for the form to unmount.
    await expect(page.locator("dialog input[name='title']")).toHaveCount(0);

    await page.keyboard.press("Enter");
    await expect(dialog.getByLabel("Title")).toBeFocused();
    await page.keyboard.type("Keyboard Almanac");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: "Keyboard Almanac" })).toBeVisible();

    await tabTo(page, "Add highlight");
    await page.keyboard.press("Enter");
    const keep = page.getByRole("dialog", { name: "Keep a passage" });
    await expect(keep.getByRole("textbox", { name: "Quote" })).toBeFocused();
    await page.keyboard.type("Typed without a pointer.");
    await tabTo(page, "Add highlight");
    await page.keyboard.press("Enter");
    await expect(keep).toBeHidden();
    await expect(passage(page, "Typed without a pointer.")).toBeVisible();
  });

  await test.step("every visible control has an accessible name", async () => {
    await openImport(page);
    expect(await unnamedControls(page), "import dialog").toEqual([]);
    await openRail(page, "Library");
    for (const [where, open] of [
      ["library", () => openRail(page, "Library")],
      ["book", () => openBook(page, "Keyboard Almanac")],
      ["highlights", () => openRail(page, "Highlights")],
      ["settings", () => openRail(page, "Settings")],
    ] as const) {
      await open();
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      expect(await unnamedControls(page), where).toEqual([]);
    }
  });

  await session.close();
});

test("imports and edits in a compact window and switches light and dark", async () => {
  const session = await launch(profile);
  const { page } = session;
  await page.getByRole("dialog").getByRole("button", { name: "Set up later" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await test.step("an unreadable or cancelled import reports clearly and changes nothing", async () => {
    const dialog = await openImport(page);
    await session.cancelNextFileDialog();
    await dialog.getByRole("button", { name: "Choose file" }).click();
    await expect(dialog.getByRole("button", { name: "Choose file" })).toBeEnabled();
    await expect(dialog.getByRole("alert")).toHaveCount(0);

    await session.chooseFile(writeMalformedPortable(profile.files));
    await dialog.getByRole("button", { name: "Choose file" }).click();
    await expect(dialog.getByRole("alert")).toHaveText(
      "Leaflogue could not read that file. Check that it is one of the files listed under \u201cWhere to find your highlights\u201d.",
    );
    await openRail(page, "Library");
    await expect(page.getByRole("heading", { name: "A place for what stays with you." })).toBeVisible();
  });

  await test.step("the 390px window keeps navigation, import, and editing usable", async () => {
    await session.resize(390, 844);
    await expectNoHorizontalOverflow(page, "empty library");
    // At phone width the rail becomes a labelled tab bar along the bottom.
    const tabs = page.getByRole("navigation", { name: "Main navigation" });
    const tabBox = await tabs.boundingBox();
    expect(tabBox && tabBox.y + tabBox.height >= 844 - 1 && tabBox.width >= 389, "tab bar spans the bottom edge").toBe(true);
    await tabs.getByRole("link", { name: "Highlights" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Your highlights" })).toBeVisible();

    await openCompactRail(page, "Library");
    const dialog = await openImportCompact(page);
    await session.chooseFile(writePortableExport(profile.files));
    await dialog.getByRole("button", { name: "Choose file" }).click();
    await expect(dialog.getByText(/reading-export\.json \(Portable JSON\)/u)).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 390, "import dialog is wider than the window").toBe(true);
    await dialog.getByLabel("Name this source").fill("Compact export");
    await dialog.getByRole("button", { name: "Import highlights and notes" }).click();
    await expect(dialog.getByRole("status")).toContainText("2 new books");
    await openRail(page, "Library");
    await expectNoHorizontalOverflow(page, "library with books");

    await page.getByRole("searchbox", { name: "Search your library" }).fill("Tidewater");
    await page.getByRole("link", { name: "Open Notes on Tidewater" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Notes on Tidewater" })).toBeVisible();
    await expectNoHorizontalOverflow(page, "book page");
    const record = passage(page, PORTABLE_PASSAGES.tide);
    await record.getByRole("button", { name: "Edit quote" }).click();
    await record.getByRole("textbox", { name: "Quote" }).fill("Edited in a narrow window.");
    await record.getByRole("button", { name: "Save changes" }).click();
    await expect(passage(page, "Edited in a narrow window.")).toBeVisible();

    await openCompactRail(page, "Settings");
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    await expectNoHorizontalOverflow(page, "settings");
    await session.resize(1180, 780);
  });

  await test.step("light and dark apply immediately and survive a restart", async () => {
    await openRail(page, "Settings");
    const mode = page.getByRole("combobox", { name: "Appearance mode" });
    await selectOption(mode, "light");
    await expect(page.getByText("Appearance saved to the protected configuration file.")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-appearance", "light");
    const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await selectOption(mode, "dark");
    await expect(page.locator("html")).toHaveAttribute("data-appearance", "dark");
    const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(dark).not.toBe(light);
    expect(await page.evaluate(() => document.documentElement.style.colorScheme)).toBe("dark");
    expect(await session.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("dark");
    expect(await unnamedControls(page), "settings in dark mode").toEqual([]);
  });

  await session.close();

  await test.step("the saved appearance is used on the next launch", async () => {
    const reopened = await launch(profile);
    await expect(reopened.page.locator("html")).toHaveAttribute("data-appearance", "dark");
    await openBook(reopened.page, "Notes on Tidewater");
    await expect(passage(reopened.page, "Edited in a narrow window.")).toBeVisible();
    await reopened.close();
  });
});

/** At compact width the rail is the tab bar along the bottom. */
async function openCompactRail(page: Page, name: "Library" | "Settings") {
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: new RegExp(`^${name}`, "u") }).click();
}

/** In a compact window Import leaves the tab bar; the library's Import button opens the page. */
async function openImportCompact(page: Page) {
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Import" })).toBeVisible();
  return page.locator("main");
}

test("imports Tolino notes and a folder of KOReader highlights", async () => {
  const session = await launch(profile);
  const { page } = session;
  await page.getByRole("dialog").getByRole("button", { name: "Set up later" }).click();
  await test.step("import Tolino notes", async () => {
    const tolino = await importFile(session, writeTolinoNotes(profile.files), {
      fileLabel: /notes\.txt \(Tolino notes\.txt\)/u, books: 1, annotations: 2, sourceName: "Tolino Vision", titles: ["Winter Glass"],
    });
    expect(tolino).toMatch(/1 new book/u);
  });
  await test.step("import a KOReader folder", async () => {
    const koreader = await importFile(session, writeKOReaderFolder(profile.files), {
      fileLabel: /KOReader books \(KOReader highlights\)/u, books: 1, annotations: 1, sourceName: "KOReader", titles: ["The Frost Ledger"], folder: true,
    });
    expect(koreader).toMatch(/1 new book/u);
  });
  await test.step("find the imported passages", async () => {
    await openBook(page, "Winter Glass");
    await expect(passage(page, "She pruned the light.")).toContainText(TOLINO_NOTE);
    await expect(passage(page, TOLINO_PASSAGE)).toBeVisible();
    await openBook(page, "The Frost Ledger");
    await expect(passage(page, KOREADER_PASSAGE)).toBeVisible();
  });
  await session.close();
});

test("reports a rejected book without disturbing the imported shelf", async () => {
  const session = await launch(profile);
  const { page } = session;
  await page.getByRole("dialog").getByRole("button", { name: "Set up later" }).click();
  await importFile(session, writePortableExport(profile.files), {
    fileLabel: /reading-export\.json \(Portable JSON\)/u, books: 2, annotations: 2, sourceName: "Reading export", titles: ["Notes on Tidewater"],
  });
  await page.getByRole("button", { name: "Add book" }).click();
  const form = page.getByRole("dialog", { name: "Add a book" });
  await form.getByLabel("Title").fill("An invalid identifier");
  await form.getByLabel("ISBN").fill("not-an-isbn");
  await form.getByRole("button", { name: "Add book" }).click();
  await expect(form.getByRole("alert")).toHaveText("The book could not be saved. Check its title and ISBN-13, then try again.");
  await form.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("2 books", { exact: true })).toBeVisible();
  await session.close();
});
