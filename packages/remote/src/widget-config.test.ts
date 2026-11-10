import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CustomWidget } from "@leaflogue/contracts";
import { deleteCustomWidget, importCustomWidgetFiles, loadDashboardLayouts, parseDashboardLayout, writeCustomWidget, writeCustomWidgetExport, writeDashboardLayout } from "./config";

let directory: string;
let path: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "leaflogue-widgets-"));
  path = join(directory, "config.json");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

const load = () => loadDashboardLayouts({ defaultConfigPath: path, environment: {}, platform: "linux" });

const tags: CustomWidget = { id: "passages-by-tag", version: 1, title: "Passages by tag", count: "passages", groupBy: "tag", show: "ranked" };
const notes: CustomWidget = { id: "notes", version: 1, title: "Notes this year", count: "notes", where: [{ field: "year", is: "this-year" }], show: "number" };

function file(name: string, contents: unknown): string {
  const target = join(directory, name);
  writeFileSync(target, typeof contents === "string" ? contents : JSON.stringify(contents));
  return target;
}

describe("custom widgets in the settings file", () => {
  it("saves widgets beside the layouts, replacing one with the same ID in place", () => {
    const sync = { provider: "convex", deploymentUrl: "https://quiet-otter-123.convex.cloud" };
    writeFileSync(path, JSON.stringify({ version: 1, sync }), { mode: 0o600 });
    writeCustomWidget(path, tags, "linux");
    writeCustomWidget(path, notes, "linux");
    const renamed = writeCustomWidget(path, { ...tags, title: "Tags" }, "linux");
    expect(renamed.widgets?.map(({ title }) => title)).toEqual(["Tags", "Notes this year"]);
    const document = JSON.parse(readFileSync(path, "utf8")) as { sync: unknown; widgets: unknown };
    expect(document.sync).toEqual(sync);
    expect(document.widgets).toEqual(renamed.widgets);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(load()).toEqual(renamed);
  });

  it("refuses an invalid widget and keeps at most 24", () => {
    expect(() => writeCustomWidget(path, { ...tags, run: "code" }, "linux")).toThrow("unknown fields: run");
    for (let index = 0; index < 24; index += 1) writeCustomWidget(path, { ...notes, id: `w${index}` }, "linux");
    expect(() => writeCustomWidget(path, { ...notes, id: "one-more" }, "linux")).toThrow("up to 24 custom widgets");
    // Replacing one is still allowed at the limit.
    expect(writeCustomWidget(path, { ...notes, id: "w0", title: "Changed" }, "linux").widgets?.[0]?.title).toBe("Changed");
  });

  it("places custom widgets and drops placements of widgets that are gone", () => {
    writeCustomWidget(path, tags, "linux");
    const placed = writeDashboardLayout(path, "statistics", [{ widget: "months" }, { widget: "custom:passages-by-tag", width: "half" }, { widget: "custom:never-made" }], "linux");
    expect(placed.statistics).toEqual([{ widget: "months" }, { widget: "custom:passages-by-tag", width: "half" }]);
    const deleted = deleteCustomWidget(path, "passages-by-tag", "linux");
    expect(deleted).toEqual({ statistics: [{ widget: "months" }] });
    expect(JSON.parse(readFileSync(path, "utf8"))).not.toHaveProperty("widgets");
  });

  it("accepts only well-formed custom placements", () => {
    expect(parseDashboardLayout([{ widget: "custom:a-b" }])).toEqual([{ widget: "custom:a-b" }]);
    expect(() => parseDashboardLayout([{ widget: "custom:Not Valid" }])).toThrow("not a known widget");
    expect(() => parseDashboardLayout([{ widget: "custom:" }])).toThrow("not a known widget");
  });

  it("reports a broken widgets section without losing the layouts", () => {
    writeFileSync(path, JSON.stringify({ version: 1, dashboards: { library: [{ widget: "passages" }, { widget: "custom:tags" }] }, widgets: [{ ...tags, id: "tags", show: "pie" }] }), { mode: 0o600 });
    expect(load()).toEqual({
      library: [{ widget: "passages" }],
      problem: "Your custom widgets were not loaded: Custom widget 1: A widget chart is not one of number, bars, ranked, heatmap, list",
    });
    // Saving a widget from the app replaces the broken section.
    expect(writeCustomWidget(path, tags, "linux").widgets).toEqual([tags]);
  });
});

describe("widget files", () => {
  it("exports a file that imports back as the same widget", () => {
    const target = join(directory, "tags.leaflogue-widget.json");
    writeCustomWidgetExport(target, tags);
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ format: "leaflogue-widget", widget: tags });
    const receipt = importCustomWidgetFiles(path, [target], "linux");
    expect(receipt).toEqual({ layouts: { widgets: [tags] }, added: ["Passages by tag"], unchanged: 0 });
  });

  it("skips a widget already there and renames one whose ID is taken", () => {
    writeCustomWidget(path, tags, "linux");
    const same = file("same.json", { format: "leaflogue-widget", widget: { ...tags, id: "elsewhere" } });
    const clash = file("clash.json", { format: "leaflogue-widget", widget: { ...tags, show: "bars" } });
    const receipt = importCustomWidgetFiles(path, [same, clash], "linux");
    expect(receipt.unchanged).toBe(1);
    expect(receipt.added).toEqual(["Passages by tag"]);
    expect(receipt.layouts.widgets?.map(({ id }) => id)).toEqual(["passages-by-tag", "passages-by-tag-2"]);
  });

  it.each([
    ["not JSON", "{", "not valid JSON"],
    ["another format", { format: "leaflogue-theme", widget: tags }, "not a Leaflogue widget file"],
    ["extra fields", { format: "leaflogue-widget", widget: tags, script: "x" }, "unknown fields"],
    ["an invalid recipe", { format: "leaflogue-widget", widget: { ...tags, groupBy: "colour" } }, "grouping is not one of"],
    ["a large file", JSON.stringify({ format: "leaflogue-widget", widget: tags, pad: "x".repeat(20_000) }), "smaller than 16 KiB"],
  ])("refuses %s and adds nothing", (_name, contents, message) => {
    const good = file("good.json", { format: "leaflogue-widget", widget: notes });
    const bad = file("bad.json", contents);
    expect(() => importCustomWidgetFiles(path, [good, bad], "linux")).toThrow(/^bad\.json: /u);
    expect(() => importCustomWidgetFiles(path, [good, bad], "linux")).toThrow(message);
    expect(load()).toEqual({});
  });

  it("refuses a link to a file", () => {
    const real = file("real.json", { format: "leaflogue-widget", widget: notes });
    const link = join(directory, "link.json");
    symlinkSync(real, link);
    expect(() => importCustomWidgetFiles(path, [link], "linux")).toThrow("rather than a link");
  });

  it("refuses an import that would pass the limit", () => {
    for (let index = 0; index < 24; index += 1) writeCustomWidget(path, { ...notes, id: `w${index}`, title: `W${index}` }, "linux");
    const extra = file("extra.json", { format: "leaflogue-widget", widget: tags });
    expect(() => importCustomWidgetFiles(path, [extra], "linux")).toThrow("up to 24 custom widgets");
  });
});
