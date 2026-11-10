import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDashboardLayouts, parseDashboardLayout, writeDashboardLayout } from "./config";

let directory: string;
let path: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "leaflogue-dashboards-"));
  path = join(directory, "config.json");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

const load = () => loadDashboardLayouts({ defaultConfigPath: path, environment: {}, platform: "linux" });

describe("dashboard layouts", () => {
  it("uses the defaults when nothing is saved", () => {
    expect(load()).toEqual({});
  });

  it("saves one dashboard without touching other settings or the other dashboard", () => {
    const sync = { provider: "convex", deploymentUrl: "https://quiet-otter-123.convex.cloud" };
    writeFileSync(path, JSON.stringify({ version: 1, sync, appearance: { themeId: "nord", mode: "dark" } }), { mode: 0o600 });
    writeDashboardLayout(path, "statistics", [{ widget: "months" }], "linux");
    const saved = writeDashboardLayout(path, "library", [{ widget: "passages" }, { widget: "activity", width: "full", tall: true }], "linux");
    expect(saved).toEqual({
      statistics: [{ widget: "months" }],
      library: [{ widget: "passages" }, { widget: "activity", width: "full", tall: true }],
    });
    const document = JSON.parse(readFileSync(path, "utf8")) as { sync: unknown; appearance: unknown };
    expect(document.sync).toEqual(sync);
    expect(document.appearance).toEqual({ themeId: "nord", mode: "dark" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(load()).toEqual(saved);
  });

  it("removes a layout to return to the default, and drops the empty section", () => {
    writeDashboardLayout(path, "library", [{ widget: "series" }], "linux");
    expect(writeDashboardLayout(path, "library", null, "linux")).toEqual({});
    expect(JSON.parse(readFileSync(path, "utf8"))).not.toHaveProperty("dashboards");
  });

  it("drops a tile's width and height, which tiles do not have", () => {
    expect(parseDashboardLayout([{ widget: "notes", width: "full", tall: true }])).toEqual([{ widget: "notes" }]);
  });

  it("keeps where the library's books go, always full width", () => {
    expect(parseDashboardLayout([{ widget: "shelf", width: "half", tall: true }, { widget: "months" }])).toEqual([{ widget: "shelf" }, { widget: "months" }]);
  });

  it.each([
    [{ widget: "nope" }, "not a known widget"],
    [{ widget: "months", width: "wide" }, "invalid width"],
    [{ widget: "months", tall: "yes" }, "invalid height"],
    [{ widget: "months", colour: "red" }, "unknown fields"],
    ["months", "is invalid"],
  ])("rejects %j", (entry, message) => {
    expect(() => parseDashboardLayout([entry])).toThrow(message);
    expect(() => writeDashboardLayout(path, "library", [entry], "linux")).toThrow(message);
  });

  it("rejects a repeated widget and a layout that is not a list", () => {
    expect(() => parseDashboardLayout([{ widget: "months" }, { widget: "months" }])).toThrow('repeats "months"');
    expect(() => parseDashboardLayout({ widget: "months" })).toThrow("must be a list");
  });

  it("reports a hand-edited layout that does not parse and falls back to the default", () => {
    writeFileSync(path, JSON.stringify({ version: 1, dashboards: { library: [{ widget: "nope" }] } }), { mode: 0o600 });
    expect(load()).toEqual({ problem: "Your saved dashboard layout was not used: Dashboard widget 1 is not a known widget" });
    // Saving from the app replaces the broken section instead of failing.
    expect(writeDashboardLayout(path, "statistics", [{ widget: "lengths" }], "linux")).toEqual({ statistics: [{ widget: "lengths" }] });
  });
});
