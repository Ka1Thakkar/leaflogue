import { describe, expect, it } from "vitest";
import { BUILT_IN_THEMES } from "@leaflogue/appearance";
import { contrastRatio } from "@leaflogue/ui";
import { readerColor } from "./reader-colors";

describe("reader colour mapping", () => {
  it("provides black and white independent of publisher colours", () => {
    expect(readerColor("rgb(0, 128, 0)", "color", true)).toBe("#ffffff");
    expect(readerColor("rgb(255, 255, 255)", "background-color", true)).toBe("transparent");
    expect(readerColor("rgb(0, 128, 0)", "color", false)).toBe("#111111");
  });
  it("maps greens to the theme green when available", () => {
    const theme = BUILT_IN_THEMES.find((theme) => theme.id === "leaflogue")!;
    expect(readerColor("rgb(0, 128, 0)", "color", false, theme.light)).toBe(theme.light.chart);
  });
  it("keeps mapped coloured text readable across light and dark themes", () => {
    for (const theme of BUILT_IN_THEMES) for (const mode of ["dark", "light"] as const) {
      for (const original of ["rgb(0, 128, 0)", "rgb(255, 0, 0)", "rgb(0, 0, 255)", "rgb(255, 255, 0)"]) {
        expect(contrastRatio(readerColor(original, "color", mode === "dark", theme[mode]), theme[mode].paper)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
