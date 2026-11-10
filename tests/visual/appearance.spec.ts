import { selectOption } from "../shared/select";
import { expect, test, type Page } from "@playwright/test";

// Keep date labels stable across runs and developer time zones.
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date("2026-11-09T12:00:00Z") });
});

/**
 * The reader's own appearance workflow, driven through Settings the way they
 * would drive it: choose a theme, choose light or dark, and see the page
 * repaint without a reload.
 */

async function chooseAppearance(page: Page, themeId: string, mode: string): Promise<void> {
  await page.goto("/#/settings");
  await page.locator(`input[type="radio"][name="Theme"][value="${themeId}"]`).check({ force: true });
  await selectOption(page.getByLabel("Appearance mode"), mode);
  await expect(page.locator("html")).toHaveAttribute("data-theme", themeId);
}

test.describe("appearance workflows", () => {
  test("switches to light without reloading and keeps text readable", async ({ page }) => {
    await chooseAppearance(page, "rose-pine", "light");
    await expect(page.locator("html")).toHaveAttribute("data-appearance", "light");

    // A light theme that leaves a dark page background behind is the failure
    // this guards: the tokens must all move together.
    const { background, foreground } = await page.evaluate(() => {
      const style = getComputedStyle(document.body);
      return { background: style.backgroundColor, foreground: style.color };
    });
    const luminance = (color: string) => {
      const [red = 0, green = 0, blue = 0] = color.match(/\d+/gu)!.map(Number);
      return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
    };
    expect(luminance(background)).toBeGreaterThan(0.5);
    expect(luminance(foreground)).toBeLessThan(0.5);

    await page.goto("/#/library");
    await expect(page.getByText("Today's highlight").first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot("library-light.png", { fullPage: true });
  });

  test("returns to dark and keeps the choice across a reload", async ({ page }) => {
    await chooseAppearance(page, "rose-pine", "dark");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-appearance", "dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "rose-pine");
  });

  test("follows the device while the mode is 'Follow this device'", async ({ page }) => {
    await chooseAppearance(page, "rose-pine", "system");
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveAttribute("data-appearance", "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-appearance", "dark");
  });
});
