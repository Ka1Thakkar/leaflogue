import { defineConfig } from "@playwright/test";

/**
 * End-to-end acceptance of the built desktop application: real Electron, the
 * real preload bridge, IPC, SQLite, importers, and backup files. Each test
 * owns a throwaway profile, answers native dialogs from the main process, and
 * fails if any request leaves the machine.
 *
 * Like the visual suite, this is not part of `npm run check`: it needs the
 * Electron binary and a display. Run it through `npm run test:e2e`, which
 * rebuilds the desktop app first.
 */
export default defineConfig({
  testDir: ".",
  // One Electron at a time keeps timing honest on small CI runners; each test
  // still has its own profile, so order does not matter.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? "github" : [["list"]],
  outputDir: "../../test-results/e2e",
});
