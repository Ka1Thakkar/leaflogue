// Renders resources/icon.svg to the 1024-pixel resources/icon.png that the
// Linux and macOS packages use. Run from the repository root after editing the
// SVG: node apps/desktop/scripts/render-icon.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { chromium } from "@playwright/test";

const resources = new URL("../resources/", import.meta.url);
const svg = readFileSync(new URL("icon.svg", resources), "utf8");
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`);
  await page.locator("svg").screenshot({ path: fileURLToPath(new URL("icon.png", resources)), omitBackground: true });
} finally {
  await browser.close();
}
