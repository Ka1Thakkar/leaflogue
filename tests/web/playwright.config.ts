import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * The web app end to end: the built client served by apps/server, on an
 * in-memory PostgreSQL without sign-in. Like the visual suite it needs a
 * downloaded browser, so it runs on demand through `npm run test:web`.
 */
const PORT = 8788;
const webRoot = resolve(__dirname, "../../apps/web/dist");

export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "github" : [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run build --workspace @leaflogue/web && npm run dev:local --workspace @leaflogue/server",
    url: `http://localhost:${PORT}/healthz`,
    env: { PORT: String(PORT), LEAFLOGUE_WEB_ROOT: webRoot },
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
