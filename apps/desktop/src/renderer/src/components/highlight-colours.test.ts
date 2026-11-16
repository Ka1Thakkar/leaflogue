/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from "vitest";
import { BUILT_IN_THEMES } from "@leaflogue/appearance";
import { contrastRatio } from "@leaflogue/ui";
import { highlightPalette, readHighlightColours, saveHighlightColour } from "./highlight-colours";
const id = "12345678-1234-4234-8234-123456789abc";
afterEach(() => localStorage.clear());
describe("per-highlight theme colours", () => {
  it("persists only supported named colours and resets yellow to the default", () => {
    saveHighlightColour(id, "green");
    expect(readHighlightColours(localStorage.getItem("leaflogue.highlight-colours.v1"))).toEqual({ [id]: "green" });
    saveHighlightColour(id, "purple");
    expect(readHighlightColours(localStorage.getItem("leaflogue.highlight-colours.v1"))).toEqual({ [id]: "purple" });
    saveHighlightColour(id, "yellow");
    expect(readHighlightColours(localStorage.getItem("leaflogue.highlight-colours.v1"))).toEqual({});
    expect(readHighlightColours(JSON.stringify({ version: 1, colours: { [id]: "url(evil)", other: "green" } }))).toEqual({});
    expect(readHighlightColours("broken")).toEqual({});
    expect(() => saveHighlightColour("invalid", "green")).toThrow();
  });
  it("adapts all five colours to every built-in theme with readable dates and highlighted text", () => {
    for (const theme of BUILT_IN_THEMES) for (const dark of [false, true]) {
      const tokens = theme[dark ? "dark" : "light"];
      const palette = highlightPalette(tokens, dark);
      expect(new Set(Object.values(palette).map((item) => item.fill)).size).toBe(5);
      for (const colour of Object.values(palette)) {
        expect(contrastRatio(colour.ink, tokens.paper), `${theme.id} date`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(colour.text, colour.fill), `${theme.id} selection`).toBeGreaterThanOrEqual(4.5);
      }
    }
    const [first, second] = BUILT_IN_THEMES;
    expect(highlightPalette(first!.dark, true).green.fill).not.toBe(highlightPalette(second!.dark, true).green.fill);
  });
});
