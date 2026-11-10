import { describe, expect, it } from "vitest";
import { add, customWidgetsBySlot, DEFAULT_LAYOUTS, move, normalize, remove, sameLayout, update } from "./layout";

describe("dashboard layout", () => {
  const layout = [{ widget: "passages" }, { widget: "notes" }, { widget: "activity", width: "half" }, { widget: "series" }] as const;

  it("moves a widget within bounds", () => {
    expect(move(layout, "series", 0).map(({ widget }) => widget)).toEqual(["series", "passages", "notes", "activity"]);
    expect(move(layout, "passages", 99).map(({ widget }) => widget)).toEqual(["notes", "activity", "series", "passages"]);
    expect(move(layout, "passages", 0)).toBe(layout);
  });

  it("resizes panels, never tiles, and keeps the default width implicit", () => {
    expect(update(layout, "activity", { width: "third", tall: true })[2]).toEqual({ widget: "activity", tall: true });
    expect(update(layout, "activity", { tall: false })[2]).toEqual({ widget: "activity", width: "half" });
    expect(update(layout, "notes", { width: "full" })[1]).toEqual({ widget: "notes" });
  });

  it("adds tiles after the other tiles and panels at the end", () => {
    expect(add(layout, "finished").map(({ widget }) => widget)).toEqual(["passages", "notes", "finished", "activity", "series"]);
    expect(add(layout, "daily").at(-1)).toEqual({ widget: "daily" });
    expect(add(layout, "notes")).toBe(layout);
    expect(remove(layout, "notes").map(({ widget }) => widget)).toEqual(["passages", "activity", "series"]);
  });

  it("drops repeated and unknown widgets", () => {
    expect(normalize([{ widget: "notes" }, { widget: "gone" as "notes" }, { widget: "notes" }], "statistics")).toEqual([{ widget: "notes" }]);
  });

  it("keeps the library's books on its page and off every other", () => {
    expect(normalize([{ widget: "notes" }], "library")).toEqual([{ widget: "notes" }, { widget: "shelf" }]);
    expect(normalize([{ widget: "shelf" }, { widget: "notes" }], "library")).toEqual([{ widget: "shelf" }, { widget: "notes" }]);
    expect(normalize([{ widget: "shelf" }, { widget: "notes" }], "statistics")).toEqual([{ widget: "notes" }]);
  });

  it("adds panels above the books", () => {
    expect(add([{ widget: "notes" }, { widget: "shelf" }, { widget: "series" }], "daily").map(({ widget }) => widget)).toEqual(["notes", "daily", "shelf", "series"]);
  });

  it("keeps custom widgets that exist and drops those that are gone", () => {
    const custom = customWidgetsBySlot([{ id: "tags", version: 1, title: "Tags", count: "passages", groupBy: "tag", show: "ranked" }]);
    expect(normalize([{ widget: "custom:tags" }, { widget: "custom:deleted" }, { widget: "notes" }], "statistics", custom)).toEqual([{ widget: "custom:tags" }, { widget: "notes" }]);
    expect(normalize([{ widget: "custom:tags" }], "statistics")).toEqual([]);
  });

  it("treats a custom number as a tile and anything else as a panel", () => {
    const custom = customWidgetsBySlot([
      { id: "count", version: 1, title: "Count", count: "notes", show: "number" },
      { id: "chart", version: 1, title: "Chart", count: "notes", groupBy: "month", show: "bars" },
    ]);
    expect(add(layout, "custom:count", custom).map(({ widget }) => widget)).toEqual(["passages", "notes", "custom:count", "activity", "series"]);
    expect(add(layout, "custom:chart", custom).at(-1)).toEqual({ widget: "custom:chart" });
    expect(update([{ widget: "custom:count" }], "custom:count", { width: "full" }, custom)).toEqual([{ widget: "custom:count" }]);
    expect(update([{ widget: "custom:chart" }], "custom:chart", { width: "full" }, custom)).toEqual([{ widget: "custom:chart", width: "full" }]);
  });

  it("compares layouts by what they show", () => {
    expect(sameLayout([{ widget: "months", width: "third" }], [{ widget: "months" }])).toBe(true);
    expect(sameLayout([{ widget: "months", tall: true }], [{ widget: "months" }])).toBe(false);
    for (const [dashboard, defaults] of Object.entries(DEFAULT_LAYOUTS)) expect(normalize(defaults, dashboard as "library")).toEqual(defaults);
  });
});
