import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { createProfile, launch, removeProfile } from "./harness";

test("attaches an inert local EPUB and resumes the same edition after restart", async () => {
  const profile = createProfile();
  try {
    let session = await launch(profile);
    let page = session.page;
    await page.getByRole("button", { name: "Set up later" }).click();
    const id = await page.evaluate(async () => (await window.leaflogue.library.createBook({ title: "Reader fixture", authors: [] })).id);
    await page.evaluate((bookId) => { location.hash = `#/library/${bookId}`; }, id);
    await page.getByRole("button", { name: "Open context panel", exact: true }).click();
    await expect(page.getByRole("button", { name: "Attach EPUB", exact: true })).toBeEnabled();
    await session.cancelNextFileDialog();
    await page.getByRole("button", { name: "Attach EPUB", exact: true }).click();
    await expect(page.getByRole("button", { name: "Attach EPUB", exact: true })).toBeEnabled();
    await session.chooseFile(resolve(__dirname, "../fixtures/local-reader.epub"));
    await page.getByRole("button", { name: "Attach EPUB", exact: true }).click();
    await expect(page.frameLocator('iframe[title="EPUB pages"]').getByRole("article", { name: "A quiet beginning" })).toContainText("We read deliberately.");
    await expect(page.getByRole("article").locator("script, img, iframe")).toHaveCount(0);
    await page.locator("#context-reader").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("PageDown");
    await expect(page.frameLocator('iframe[title="EPUB pages"]').getByRole("article", { name: "A second chapter" })).toBeInViewport();
    await expect(page.getByRole("status").filter({ hasText: "Position saved" })).toContainText("Position saved");
    const panel = page.getByRole("complementary", { name: "Reading context" });
    await expect(page.locator("#content")).toHaveCSS("overflow-y", "auto");
    const panelTop = (await panel.boundingBox())!.y;
    await page.locator("#content").evaluate((element) => { element.scrollTop = element.scrollHeight; });
    expect((await panel.boundingBox())!.y).toBe(panelTop);
    await page.getByRole("tab", { name: "Assistant", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Think through a passage" })).toBeVisible();
    await page.getByRole("tab", { name: "Assistant", exact: true }).press("ArrowLeft");
    await expect(page.getByRole("tab", { name: "Reader", exact: true })).toBeFocused();
    await expect(page.frameLocator('iframe[title="EPUB pages"]').getByRole("article", { name: "A second chapter" })).toBeInViewport();
    const separator = page.getByRole("separator", { name: "Resize context panel" });
    const width = Number(await separator.getAttribute("aria-valuenow"));
    await separator.press("ArrowLeft");
    await expect(separator).toHaveAttribute("aria-valuenow", String(width + 24));
    await page.getByRole("button", { name: "Expand context panel", exact: true }).click();
    await expect(page.locator("#content")).toBeHidden();
    await page.getByRole("button", { name: "Restore split view", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Reader fixture", exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Collapse context panel", exact: true }).click();
    await expect(panel).toBeHidden();
    await page.getByRole("button", { name: "Open context panel", exact: true }).click();
    await expect(page.frameLocator('iframe[title="EPUB pages"]').getByRole("article", { name: "A second chapter" })).toBeInViewport();
    await session.resize(600, 800);
    await expect(panel).toBeVisible();
    const bounds = await panel.boundingBox();
    expect(bounds!.width).toBeLessThanOrEqual(600);
    await expect(page.getByRole("button", { name: "Collapse context panel", exact: true })).toBeInViewport();
    await session.close();
    session = await launch(profile);
    page = session.page;
    await page.evaluate((bookId) => { location.hash = `#/library/${bookId}`; }, id);
    await page.getByRole("button", { name: "Read", exact: true }).click();
    await expect(page.frameLocator('iframe[title="EPUB pages"]').getByRole("article", { name: "A second chapter" })).toBeInViewport();
    const position = await page.evaluate(async (bookId) => (await window.leaflogue.epub!.open(bookId))?.position, id);
    expect(position).toEqual({ chapter: 1, paragraph: 0 });
    await session.close();
  } finally { await removeProfile(profile); }
});

test("turns pages inside a long chapter and restores the exact text after restart", async () => {
  const profile = createProfile();
  try {
    let session = await launch(profile);
    let page = session.page;
    await page.getByRole("button", { name: "Set up later" }).click();
    const id = await page.evaluate(async () => (await window.leaflogue.library.createBook({ title: "Paged reader fixture", authors: [] })).id);
    await page.evaluate((bookId) => { location.hash = `#/library/${bookId}`; }, id);
    await page.getByRole("button", { name: "Read", exact: true }).click();
    await session.chooseFile(resolve(__dirname, "../fixtures/paged-reader.epub"));
    await page.getByRole("button", { name: "Attach EPUB", exact: true }).click();
    let reading = page.getByRole("region", { name: "Book pages", exact: true });
    await page.locator("#context-reader").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("PageDown");
    await expect(page.getByRole("status").filter({ hasText: "Position saved" })).toContainText("Position saved");
    const position = await page.evaluate(async (bookId) => (await window.leaflogue.epub!.open(bookId))?.position, id);
    expect(position?.chapter).toBe(0);
    expect(position?.offset).toBeGreaterThan(0);
    await session.close();
    session = await launch(profile); page = session.page;
    await page.evaluate((bookId) => { location.hash = `#/library/${bookId}`; }, id);
    await page.getByRole("button", { name: "Read", exact: true }).click();
    reading = page.getByRole("region", { name: "Book pages", exact: true });
    await expect(reading).toBeVisible();
    const anchoredCharacterVisible = await reading.evaluate((view, anchor) => {
      const frame = view.querySelector<HTMLIFrameElement>("iframe")!;
      const reader = frame.contentDocument!;
      const node = reader.querySelector(`[data-chapter="${anchor!.chapter}"][data-paragraph="${anchor!.paragraph}"]`)!.firstChild!;
      const range = reader.createRange(); range.setStart(node, anchor!.offset!); range.setEnd(node, anchor!.offset! + 1);
      const character = range.getBoundingClientRect(); const bounds = reader.getElementById("reader-scroll")!.getBoundingClientRect();
      return character.left >= bounds.left - 1 && character.right <= bounds.right + 1;
    }, position);
    expect(anchoredCharacterVisible).toBe(true);
    await page.locator("#context-reader").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("End");
    await expect(page.frameLocator('iframe[title="EPUB pages"]').getByRole("article", { name: "A second chapter" })).toBeInViewport();
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+F10");
    const readerOptions = page.getByRole("dialog", { name: "Reader options", exact: true });
    await expect(readerOptions).toBeVisible();
    await expect(readerOptions).toContainText("Page 1 of");
    await expect(readerOptions.getByRole("button", { name: "Previous page", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(readerOptions).not.toBeVisible();
    await session.close();
  } finally { await removeProfile(profile); }
});

test("preserves publisher formatting and offers in-app reader options on right click", async () => {
  const profile = createProfile();
  try {
    const session = await launch(profile); const { page } = session;
    await page.getByRole("button", { name: "Set up later" }).click();
    const id = await page.evaluate(async () => {
      const book = await window.leaflogue.library.createBook({ title: "Styled fixture", authors: [] });
      await window.leaflogue.library.createHighlight({ bookId: book.id, text: "We read deliberately." });
      return book.id;
    });
    await page.evaluate((bookId) => { location.hash = `#/library/${bookId}`; }, id);
    await page.getByRole("button", { name: "Read", exact: true }).click();
    await session.chooseFile(resolve(__dirname, "../fixtures/styled-reader.epub"));
    await page.getByRole("button", { name: "Attach EPUB", exact: true }).click();
    const reader = page.frameLocator('iframe[title="EPUB pages"]');
    const heading = reader.getByRole("heading", { name: "A quiet beginning", exact: true });
    await expect(heading).toHaveCSS("text-align", "center");
    await expect(reader.locator("em")).toHaveCSS("font-style", "italic");
    await expect(reader.getByRole("listitem")).toContainText("A list item");
    await expect(reader.getByRole("img", { name: "Publisher illustration" })).toBeVisible();
    await expect(reader.locator("script,[onclick],[onerror]")).toHaveCount(0);
    await expect(page.locator('iframe[title="EPUB pages"]')).toHaveAttribute("sandbox", "allow-same-origin");
    await expect(page.getByRole("combobox", { name: "Chapter", exact: true })).toHaveCount(0);
    await heading.click({ button: "right" });
    const options = page.getByRole("dialog", { name: "Reader options", exact: true });
    await expect(options).toBeVisible();
    await expect(options.getByRole("combobox", { name: "Text size", exact: true })).toBeVisible();
    const body = reader.locator("body");
    await expect(body).toHaveCSS("background-color", "rgb(0, 0, 0)");
    await expect(body).toHaveCSS("color", "rgb(255, 255, 255)");
    await options.getByRole("switch", { name: "Dark mode", exact: true }).uncheck();
    await expect(body).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await options.getByRole("switch", { name: "Use theme colours", exact: true }).check();
    const paper = await page.evaluate(async () => { const appearance = await window.leaflogue.appearance.describe(); return appearance.themes.find((theme) => theme.id === appearance.themeId)!.light.paper; });
    const expected = `rgb(${[1, 3, 5].map((offset) => parseInt(paper.slice(offset, offset + 2), 16)).join(", ")})`;
    await expect(body).toHaveCSS("background-color", expected);
    await options.getByRole("switch", { name: "Use theme colours", exact: true }).uncheck();
    await options.getByRole("switch", { name: "Dark mode", exact: true }).check();
    await page.keyboard.press("Escape");
    await expect(options).not.toBeVisible();
    const marks = () => page.locator('iframe[title="EPUB pages"]').evaluate((frame) => {
      const inner = (frame as HTMLIFrameElement).contentWindow as Window & typeof globalThis;
      return inner.CSS.highlights.get("leaflogue-saved")?.size ?? 0;
    });
    await expect.poll(marks).toBe(1);
    await heading.click();
    await page.keyboard.press("ArrowRight");
    await expect(reader.getByRole("article", { name: "A second chapter" })).toBeInViewport();
    await page.keyboard.press("ArrowLeft");
    await expect(heading).toBeInViewport();
    const selectWord = async () => {
      await reader.locator("em").evaluate((element) => {
        const doc = element.ownerDocument; const range = doc.createRange(); range.selectNodeContents(element);
        const selected = doc.getSelection()!; selected.removeAllRanges(); selected.addRange(range);
        element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      });
    };
    await selectWord();
    const selectionTools = page.getByRole("toolbar", { name: "Selected text actions", exact: true });
    await expect(selectionTools).toBeVisible();
    expect((await page.evaluate(async (bookId) => (await window.leaflogue.library.getBookContents(bookId))?.highlights.length, id))).toBe(1);
    await reader.locator("em").evaluate((element) => element.ownerDocument.getSelection()?.removeAllRanges());
    await expect(selectionTools).not.toBeVisible();
    await selectWord();
    await page.keyboard.press("PageDown");
    await expect(selectionTools).not.toBeVisible();
    await expect(reader.getByRole("article", { name: "A second chapter" })).toBeInViewport();
    await page.keyboard.press("Home");
    await selectWord();
    await selectionTools.getByRole("button", { name: "Highlight", exact: true }).click();
    await expect.poll(marks).toBe(2);
    const saved = await page.evaluate(async (bookId) => (await window.leaflogue.library.getBookContents(bookId))?.highlights, id);
    expect(saved).toHaveLength(2);
    expect(saved!.find((highlight) => highlight.text === "deliberately")?.sourceLocation).toMatch(/^epub:/u);
    await selectWord();
    await selectionTools.getByRole("button", { name: "Add note", exact: true }).click();
    const note = page.getByRole("dialog", { name: "Note for selected text", exact: true });
    await note.getByRole("textbox", { name: "Note", exact: true }).fill("A reader note.");
    await note.getByRole("button", { name: "Save highlight and note", exact: true }).click();
    await expect(note).not.toBeVisible();
    const withNotes = await page.evaluate(async (bookId) => (await window.leaflogue.library.getBookContents(bookId))?.highlights, id);
    expect(withNotes).toHaveLength(2);
    expect(withNotes?.some((highlight) => highlight.notes.some((note) => note.markdown === "A reader note."))).toBe(true);
    await page.evaluate(async ({ bookId, highlightId }) => {
      const highlight = (await window.leaflogue.library.getBookContents(bookId))!.highlights.find((item) => item.id === highlightId)!;
      await window.leaflogue.library.deleteHighlight({ bookId, id: highlight.id, expectedRevision: highlight.revision });
      window.dispatchEvent(new Event("leaflogue:annotations-changed"));
    }, { bookId: id, highlightId: saved!.find((highlight) => highlight.text === "deliberately")!.id });
    await expect.poll(marks).toBe(1);
    await session.close();
  } finally { await removeProfile(profile); }
});

test("keeps line ends inside each page with publisher padding and fractional widths", async () => {
  const profile = createProfile();
  try {
    const session = await launch(profile); const { page } = session;
    await page.getByRole("button", { name: "Set up later" }).click();
    const id = await page.evaluate(async () => (await window.leaflogue.library.createBook({ title: "Layout fixture", authors: [] })).id);
    await page.evaluate((bookId) => { location.hash = `#/library/${bookId}`; }, id);
    await page.getByRole("button", { name: "Read", exact: true }).click();
    await session.chooseFile(resolve(__dirname, "../fixtures/layout-reader.epub"));
    await page.getByRole("button", { name: "Attach EPUB", exact: true }).click();
    await expect(page.frameLocator('iframe[title="EPUB pages"]').getByRole("heading", { name: "A quiet beginning" })).toBeVisible();
    await page.getByRole("button", { name: "Expand context panel", exact: true }).click();
    await page.locator('iframe[title="EPUB pages"]').evaluate((frame) => (frame as HTMLIFrameElement).contentDocument!.getElementById("reader-scroll")!.style.setProperty("max-width", "311.375px", "important"));
    await session.resize(1319, 901);
    await page.locator("#context-reader").click({ position: { x: 5, y: 5 } });
    for (let index = 0; index < 6; index++) {
      const metrics = await page.locator('iframe[title="EPUB pages"]').evaluate((frame) => {
        const doc = (frame as HTMLIFrameElement).contentDocument!; const view = doc.getElementById("reader-scroll")!;
        const bounds = view.getBoundingClientRect(); const walker = doc.createTreeWalker(doc.getElementById("reader-pages")!, NodeFilter.SHOW_TEXT);
        const visible: DOMRect[] = []; let node: Node | null;
        while ((node = walker.nextNode())) { const range = doc.createRange(); range.selectNodeContents(node); for (const rect of range.getClientRects()) if (rect.right > bounds.left + 1 && rect.left < bounds.right - 1 && rect.bottom > bounds.top && rect.top < bounds.bottom) visible.push(rect); }
        return { width: bounds.width, visible: visible.length, clipped: visible.filter((rect) => rect.left < bounds.left - 0.5 || rect.right > bounds.right + 0.5).length };
      });
      expect(metrics.width % 1).toBe(0); expect(metrics.visible).toBeGreaterThan(5); expect(metrics.clipped).toBe(0);
      await page.keyboard.press("PageDown");
    }
    await session.close();
  } finally { await removeProfile(profile); }
});

test("navigates both ways between a highlight and its reader entity, including notes", async () => {
  const profile = createProfile();
  try {
    const session = await launch(profile); const { page } = session;
    await page.getByRole("button", { name: "Set up later" }).click();
    const saved = await page.evaluate(async () => {
      const book = await window.leaflogue.library.createBook({ title: "Context fixture", authors: [] });
      const highlight = await window.leaflogue.library.createHighlight({ bookId: book.id, text: "Return to this paragraph.", noteMarkdown: "A note in context." });
      return { bookId: book.id, highlightId: highlight.id };
    });
    await page.evaluate(({ bookId }) => { location.hash = `#/library/${bookId}`; }, saved);
    await page.getByRole("button", { name: "Read in context", exact: true }).click();
    await session.chooseFile(resolve(__dirname, "../fixtures/local-reader.epub"));
    await page.getByRole("button", { name: "Attach EPUB", exact: true }).click();
    const reader = page.frameLocator('iframe[title="EPUB pages"]');
    await expect(reader.getByRole("article", { name: "A second chapter" })).toBeInViewport();
    const marker = page.getByRole("button", { name: "1 note: Return to this paragraph.", exact: true });
    await expect(marker).toBeVisible();
    await reader.getByText("Return to this paragraph.", { exact: true }).click();
    const actions = page.getByRole("dialog", { name: "Saved highlight actions", exact: true });
    await expect(actions).toBeVisible(); await expect(actions).toContainText("A note in context.");
    await actions.getByRole("button", { name: "Open in book", exact: true }).click();
    await expect(page.locator(`#highlight-${saved.highlightId}`)).toHaveAttribute("data-focused", "");
    await page.locator("#context-reader").click({ position: { x: 5, y: 5 } }); await page.keyboard.press("Home");
    await expect(reader.getByRole("article", { name: "A quiet beginning" })).toBeInViewport();
    await page.getByRole("button", { name: "Read in context", exact: true }).click();
    await expect(reader.getByRole("article", { name: "A second chapter" })).toBeInViewport();
    await marker.click(); await expect(actions).toBeVisible();
    await actions.getByRole("button", { name: "Remove highlight", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "Remove highlight?", exact: true });
    await expect(confirmation).toContainText("1 attached note");
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    expect((await page.evaluate(async (id) => (await window.leaflogue.library.getBookContents(id))!.highlights.length, saved.bookId))).toBe(1);
    await actions.getByRole("button", { name: "Remove highlight", exact: true }).click();
    await confirmation.getByRole("button", { name: "Remove highlight", exact: true }).click();
    await expect(marker).not.toBeVisible();
    expect((await page.evaluate(async (id) => (await window.leaflogue.library.getBookContents(id))!.highlights.length, saved.bookId))).toBe(0);
    await session.close();
  } finally { await removeProfile(profile); }
});
