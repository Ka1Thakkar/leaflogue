import { describe, expect, it } from "vitest";
import { parseDashboardLayout } from "./dashboards";

describe("dashboard layouts", () => {
  it("keeps a panel's width and height, and drops them from tiles and the books", () => {
    expect(parseDashboardLayout([{ widget: "recent", width: "two-thirds", tall: true }, { widget: "passages", width: "full" }, { widget: "shelf", tall: true }]))
      .toEqual([{ widget: "recent", width: "two-thirds", tall: true }, { widget: "passages" }, { widget: "shelf" }]);
  });

  it("accepts custom widgets unless they are turned off", () => {
    expect(parseDashboardLayout([{ widget: "custom:my-count" }])).toEqual([{ widget: "custom:my-count" }]);
    expect(() => parseDashboardLayout([{ widget: "custom:my-count" }], { customWidgets: false })).toThrow("not a known widget");
    expect(parseDashboardLayout([{ widget: "on-this-day" }, { widget: "pick-up" }], { customWidgets: false })).toEqual([{ widget: "on-this-day" }, { widget: "pick-up" }]);
  });
});
