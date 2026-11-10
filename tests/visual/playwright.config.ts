import { defineConfig, devices } from "@playwright/test";

/**
 * Visual and interaction regression for the renderer, driven against the
 * preview bridge rather than a packaged desktop build: the preview answers
 * every channel from fixed in-memory data, so a page looks the same on every
 * run and a diff means the interface changed.
 *
 * This suite is not part of `npm run check`. It needs a downloaded browser,
 * and its baselines are per-platform, so it runs on demand through
 * `npm run test:visual`.
 */
export default defineConfig({
  testDir: ".",
  snapshotPathTemplate: "{testDir}/baselines/{arg}-{projectName}-{platform}{ext}",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "github" : [["list"]],
  expect: {
    // Text antialiasing differs slightly between machines of the same platform;
    // a real regression moves far more than a few pixels.
    toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: "disabled", caret: "hide" },
  },
  use: {
    baseURL: "http://127.0.0.1:5199",
    colorScheme: "dark",
    timezoneId: "UTC",
    reducedMotion: "reduce",
    deviceScaleFactor: 1,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "wide", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "compact", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: "npm run preview:renderer --workspace @leaflogue/desktop -- --port 5199 --strictPort",
    url: "http://127.0.0.1:5199",
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
    timeout: 120_000,
  },
});
