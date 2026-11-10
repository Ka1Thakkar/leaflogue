import { expect, test, type Page } from "@playwright/test";

/**
 * Keyboard and screen-reader workflows in a real browser: focus order, visible
 * focus, and the accessible names a screen reader would announce. These need
 * layout and live focus, which is why they belong here rather than in the
 * component tests.
 */

async function focusedName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (!active || active === document.body) return "";
    return (active.getAttribute("aria-label")
      ?? active.textContent?.trim()
      ?? active.getAttribute("placeholder")
      ?? "").replace(/\s+/gu, " ");
  });
}

test.describe("keyboard and screen-reader workflows", () => {
  test("opens the library from the skip link without touching the rail", async ({ page }) => {
    await page.goto("/#/library");
    await page.keyboard.press("Tab");
    expect(await focusedName(page)).toBe("Skip to content");
    await page.keyboard.press("Enter");
    // The skip link moves focus, not only scroll: a screen reader that only
    // scrolls would keep reading from the navigation rail.
    await expect(page.locator("#content")).toBeFocused();
    await expect(page.locator("#content main")).toBeVisible();
  });

  test("reaches every destination in reading order with visible focus", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "wide", "The compact tab bar comes after the page in reading order");
    await page.goto("/#/library");
    const reached: string[] = [];
    for (let step = 0; step < 12 && !reached.includes("Settings Local library controls"); step += 1) {
      await page.keyboard.press("Tab");
      reached.push(await focusedName(page));
    }
    expect(reached).toContain("Library");
    expect(reached.indexOf("Highlights")).toBeGreaterThan(reached.indexOf("Library"));
    expect(reached.indexOf("Threads")).toBeGreaterThan(reached.indexOf("Highlights"));

    // Whatever holds focus must show it: an invisible focus ring strands a
    // keyboard reader with no idea where they are.
    const outline = await page.evaluate(() => {
      const style = getComputedStyle(document.activeElement!);
      return { width: style.outlineWidth, style: style.outlineStyle, shadow: style.boxShadow };
    });
    expect(outline.style !== "none" && outline.width !== "0px" ? "ring" : outline.shadow)
      .not.toBe("none");
  });

  test("closes a dialog with Escape and returns focus to its trigger", async ({ page }) => {
    await page.goto("/#/library");
    const trigger = page.getByRole("button", { name: "Add book" });
    await trigger.click();
    const dialog = page.locator("dialog[open]");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("names every control a screen reader would announce", async ({ page }) => {
    for (const hash of ["#/library", "#/highlights", "#/threads", "#/settings"]) {
      await page.goto(`/${hash}`);
      await expect(page.locator("main")).toBeVisible();
      const unnamed = await page.evaluate(() => {
        const name = (element: Element): string => (element.getAttribute("aria-label")
          ?? element.getAttribute("title")
          ?? (element.getAttribute("aria-labelledby")
            ? document.getElementById(element.getAttribute("aria-labelledby")!)?.textContent
            : undefined)
          ?? (element.id ? document.querySelector(`label[for="${element.id}"]`)?.textContent : undefined)
          ?? element.closest("label")?.textContent
          ?? element.textContent
          ?? "").trim();
        return [...document.querySelectorAll("button, a[href], select, input:not([type=hidden]), textarea")]
          .filter((element) => element.checkVisibility() && !name(element))
          .map((element) => `${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).split(" ")[0]}` : ""}`);
      });
      expect(unnamed, `${hash} has controls with no accessible name`).toEqual([]);
    }
  });
});
