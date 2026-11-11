import { selectOption } from "../shared/select";
import { expect, test, type Page } from "@playwright/test";

// Keep date labels stable across runs and developer time zones.
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date("2026-11-09T12:00:00Z") });
});

/**
 * One screenshot per destination at a wide and a compact width, in Rosé Pine
 * Main (dark) — the preview's default theme, and the one the roadmap pins for
 * visual tests.
 */

const DESTINATIONS = [
  { name: "library", hash: "#/library", settled: "Today's highlight" },
  { name: "highlights", hash: "#/highlights", settled: "Your highlights" },
  { name: "threads", hash: "#/threads", settled: "Your threads" },
  { name: "statistics", hash: "#/statistics", settled: "Most highlighted authors" },
  { name: "settings", hash: "#/settings", settled: "Storage locations" },
] as const;

async function open(page: Page, hash: string, settled: string): Promise<void> {
  await page.goto(`/${hash}`);
  await expect(page.getByText(settled).first()).toBeVisible();
  // Fonts and cover images finish after the first paint; without waiting for
  // them, one run disagrees with the next over hundreds of pixels.
  await page.evaluate(() => document.fonts.ready);
  await expect
    .poll(() => page.evaluate(() => [...document.images].every((image) => image.complete)))
    .toBe(true);
}

test.describe("appearance regression", () => {
  for (const { name, hash, settled } of DESTINATIONS) {
    test(`renders ${name} in Rosé Pine Main`, async ({ page }) => {
      await open(page, hash, settled);
      await expect(page.locator("html")).toHaveAttribute("data-theme", "rose-pine");
      await expect(page.locator("html")).toHaveAttribute("data-appearance", "dark");
      await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: true });
    });
  }

  test("keeps the navigation rail usable at a compact width", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "compact", "Compact-width behavior only");
    await open(page, "#/library", "Today's highlight");
    // Compact widths turn the rail into a labelled tab bar along the bottom.
    await expect(page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Highlights" })).toBeVisible();
    await expect(page).toHaveScreenshot("library-navigation.png");
  });

  test("shows no horizontal overflow at any destination", async ({ page }) => {
    for (const { hash, settled } of DESTINATIONS) {
      await open(page, hash, settled);
      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${hash} overflows horizontally`).toBeLessThanOrEqual(0);
    }
  });

  test("uses rounded scrollbars that follow the active palette", async ({ page }) => {
    await open(page, "#/settings", "Storage locations");
    const scrollbar = () => page.evaluate(() => {
      const thumb = getComputedStyle(document.documentElement, "::-webkit-scrollbar-thumb");
      const gutter = getComputedStyle(document.documentElement, "::-webkit-scrollbar");
      return {
        color: thumb.backgroundColor,
        radius: thumb.borderRadius,
        clip: thumb.backgroundClip,
        width: gutter.width,
      };
    });

    const dark = await scrollbar();
    expect(dark).toMatchObject({ radius: "999px", clip: "padding-box", width: "12px" });
    await selectOption(page.getByRole("combobox", { name: "Appearance mode" }), "light");
    await expect(page.locator("html")).toHaveAttribute("data-appearance", "light");
    const light = await scrollbar();
    expect(light).toMatchObject({ radius: "999px", clip: "padding-box", width: "12px" });
    expect(light.color).not.toBe(dark.color);
  });

  test("keeps the book cover outside the scrolling details panel", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "wide", "Desktop book details only");
    await open(page, "#/library/bd809783-25e1-4d95-80a0-d03442a57d5c", "Piranesi");
    const cover = page.locator('[class*="heroCover"]').first();
    const details = page.getByRole("complementary", { name: "Book details", exact: true });
    const before = await cover.boundingBox();
    const layout = await details.evaluate((panel) => {
      panel.scrollTop = panel.scrollHeight;
      const style = getComputedStyle(panel);
      return { top: panel.getBoundingClientRect().top, overflow: style.overflowY, maxHeight: style.maxHeight };
    });
    expect(before).not.toBeNull();
    expect(layout.top).toBeGreaterThanOrEqual(before!.y + before!.height);
    expect(await cover.boundingBox()).toEqual(before);
    expect(layout.overflow).toBe("auto");
    expect(layout.maxHeight).not.toBe("none");
  });

  test("reads a long AI explanation in the tabbed context panel", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "wide", "Desktop companion sheet only");
    await page.setViewportSize({ width: 1440, height: 400 });
    await open(page, "#/settings", "Storage locations");
    await page.locator("#settings-ai summary").click();
    await page.getByRole("switch", { name: "Enable AI features" }).check();
    await page.getByRole("button", { name: "Save AI settings" }).click();
    await expect(page.getByText("AI preferences saved.", { exact: false })).toBeVisible();
    page.on("dialog", (dialog) => dialog.accept());
    await page.evaluate(() => { window.location.hash = "#/library/bd809783-25e1-4d95-80a0-d03442a57d5c"; });
    await page.getByRole("heading", { name: "Piranesi", exact: true }).waitFor();
    await page.getByRole("article", { name: "Highlight from Piranesi" }).first().hover();
    await page.getByRole("button", { name: "Explain this passage" }).first().click();
    const companion = page.getByRole("complementary", { name: "Reading context" });
    const consent = companion.getByRole("button", { name: /Send to / });
    if (await consent.isVisible()) await consent.click();
    await expect(companion.getByText(/living presence/u)).toBeVisible();
    const layout = await companion.evaluate((dialog) => {
      const answer = dialog.querySelector<HTMLElement>("#context-assistant")!;
      const bounds = dialog.getBoundingClientRect();
      answer.scrollTop = answer.scrollHeight;
      return {
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
        answerOverflow: getComputedStyle(answer).overflowY,
        scrolled: answer.scrollTop > 0,
        finalParagraph: answer.textContent?.includes("curiosity about what it may conceal"),
      };
    });
    expect(layout.right).toBe(1440);
    expect(layout.top).toBe(44);
    expect(layout.bottom).toBe(400);
    expect(layout.answerOverflow).toBe("auto");
    expect(layout.scrolled).toBe(true);
    expect(layout.finalParagraph).toBe(true);
  });

  test("keeps every statistics tooltip on screen at the narrowest phone width", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    await open(page, "#/statistics", "Most highlighted authors");
    // A tapped bar stays "hovered" on a phone, so every tooltip must fit.
    await page.addStyleTag({ content: "[role=listitem] > span:first-child { display: block !important; }" });
    const result = await page.evaluate(() => {
      const width = document.documentElement.clientWidth;
      const offscreen = [...document.querySelectorAll("[role=listitem][aria-label]")]
        .filter((column) => {
          const box = column.firstElementChild!.getBoundingClientRect();
          return box.left < 0 || box.right > width;
        })
        .map((column) => column.getAttribute("aria-label"));
      return { offscreen, overflow: document.documentElement.scrollWidth - width };
    });
    expect(result).toEqual({ offscreen: [], overflow: 0 });
  });
});
