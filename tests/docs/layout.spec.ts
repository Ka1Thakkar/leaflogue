import { expect, test } from "@playwright/test";

for (const mode of ["light", "dark"] as const) {
  test(`marketing and guides share the UI in ${mode}`, async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: mode });
    for (const path of ["/", "/start/install/", "/widgets/plugins/", "/web/convex/"]) {
      await page.goto(path);
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), path).toBe(true);
      const header = page.locator("header").first();
      if (path !== "/") expect(await header.evaluate(element => element.getBoundingClientRect().height)).toBe(info.project.name === "desktop" ? 64 : 56);
      expect(await page.locator("h1").evaluate(element => getComputedStyle(element).fontFamily)).toContain("Gloock");
      if (path === "/") {
        expect(await page.locator("main img:visible").count()).toBeGreaterThan(4);
        for (const image of await page.locator("main img:visible").all()) {
          await image.scrollIntoViewIfNeeded();
          await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
          expect(await image.getAttribute("alt")).toBeTruthy();

        }
      }
      await page.screenshot({ path: `/tmp/leaflogue-docs-${info.project.name}-${mode}-${path.replaceAll("/", "_") || "home"}.png`, fullPage: false, animations: "disabled" });
    }
  });
}

test("guide search and theme selection remain usable", async ({ page }) => {
  await page.goto("/start/install/");
  await page.getByRole("button", { name: /Search/ }).click();
  const search = page.getByRole("textbox", { name: "Search", exact: true });
  await search.fill("Convex");
  await expect(page.getByRole("dialog", { name: "Search", exact: true }).getByRole("link", { name: /Convex/ }).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Switch to light mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});
