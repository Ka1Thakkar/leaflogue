import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";

// Workspace packages export TypeScript sources, so the packaged main process
// can only load them if they are bundled rather than left as runtime imports.
describe("main-process bundle policy", () => {
  it("bundles every workspace package the desktop depends on", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const config = readFileSync(new URL("../electron.vite.config.ts", import.meta.url), "utf8");
    const main = /main:\s*\{[\s\S]*?exclude:\s*\[([^\]]*)\]/u.exec(config)?.[1] ?? "";
    const bundled = new Set([...main.matchAll(/"([^"]+)"/gu)].map((match) => match[1]));
    const workspace = Object.keys(manifest.dependencies).filter((name) => name.startsWith("@leaflogue/"));
    expect(workspace.length).toBeGreaterThan(0);
    expect(workspace.filter((name) => !bundled.has(name))).toEqual([]);
  });
});
