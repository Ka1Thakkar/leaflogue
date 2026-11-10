import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:4330", browserName: "chromium", reducedMotion: "reduce" },
  webServer: {
    command: "npm run preview --workspace @leaflogue/docs -- --host 127.0.0.1 --port 4330 --ignore-lock",
    url: "http://127.0.0.1:4330",
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
    { name: "phone", use: { viewport: { width: 390, height: 844 } } },
    { name: "narrow", use: { viewport: { width: 320, height: 844 } } },
  ],
});
