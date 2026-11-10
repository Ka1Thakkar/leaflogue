import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The web app is the desktop's interface over a hosted library, so it builds
// the desktop renderer's source directly rather than a copy of it.
const renderer = fileURLToPath(new URL("../desktop/src/renderer/src", import.meta.url));
// In development, API and sign-in requests go to a local apps/server.
const server = process.env.LEAFLOGUE_DEV_SERVER ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@leaflogue/renderer": renderer } },
  server: {
    port: 5180,
    strictPort: true,
    proxy: { "/api": server, "/auth": server, "/config.json": server },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
