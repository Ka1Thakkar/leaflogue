import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ["@leaflogue/ai", "@leaflogue/appearance", "@leaflogue/contracts", "@leaflogue/domain", "@leaflogue/importers", "@leaflogue/remote", "@leaflogue/storage", "@leaflogue/ui"],
      }),
    ],
    build: {
      rollupOptions: {
        output: {
          format: "es",
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["@leaflogue/contracts"] })],
    build: {
      rollupOptions: {
        output: {
          entryFileNames: "[name].cjs",
          format: "cjs",
        },
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src"),
      },
    },
    plugins: [react()],
  },
});
