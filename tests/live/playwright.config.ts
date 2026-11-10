import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "packaged-convex.spec.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  outputDir: "../../test-results/packaged-convex-live",
  use: { trace: "off", screenshot: "off", video: "off" },
});
