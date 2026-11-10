import { describe, expect, it } from "vitest";
import { contrastRatio, toneProperties } from "./tones";

describe("accent tones", () => {
  it("uses an accent as text only where it is readable, falling back to ink", () => {
    const dark = toneProperties({ paper: "#191724", ruled: "#1f1d2e", ink: "#e0def4", pen: "#9ccfd8", highlighter: "#f6c177", stamp: "#eb6f92", chart: "#c4a7e7" });
    expect(dark["--chart"]).toBe("#c4a7e7");
    expect(dark["--ui-tone-mark"]).toBe("#f6c177");
    expect(dark["--ui-tone-good-text"]).toBe("#9ccfd8");
    const light = toneProperties({ paper: "#fbf6ea", ruled: "#fdfbf4", ink: "#2a2521", pen: "#27508c", highlighter: "#ffd84d", stamp: "#bf453a" });
    expect(light["--chart"]).toBe("#27508c");
    // Bright yellow on cream is deepened toward ink until it reads, keeping its hue.
    expect(light["--ui-tone-mark"]).not.toBe("#2a2521");
    expect(light["--ui-tone-mark"]).not.toBe("#ffd84d");
    expect(light["--ui-tone-good"]).toBe("#27508c");
    expect(contrastRatio(light["--ui-tone-mark"]!, "#fbf6ea")).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(light["--ui-tone-mark-text"]!, "#fdfbf4")).toBeGreaterThanOrEqual(4.5);
  });
});
