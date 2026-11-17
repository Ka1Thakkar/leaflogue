/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_THEMES } from "@leaflogue/appearance";
import { contrastRatio } from "@leaflogue/ui";
import { highlightColour, highlightPalette, migrateHighlightColours, readHighlightColours, saveHighlightColour } from "./highlight-colours";
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

describe("legacy colour migration", () => {
  it("copies an old local choice to the record only after a successful save", async () => {
    saveHighlightColour(id, "green");
    const highlight = { id, bookId: id, text: "A line", revision: 2, createdAt: 1, updatedAt: 1, notes: [] };
    const update = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ ...highlight, colour: "green" });
    window.leaflogue = { library: { listHighlights: vi.fn().mockResolvedValue({ entries: [highlight], hasMore: false }), updateHighlight: update } } as never;
    await migrateHighlightColours();
    expect(readHighlightColours(localStorage.getItem("leaflogue.highlight-colours.v1"))[id]).toBe("green");
    await migrateHighlightColours();
    expect(update).toHaveBeenLastCalledWith({ id, bookId: id, text: "A line", expectedRevision: 2, colour: "green" });
    expect(readHighlightColours(localStorage.getItem("leaflogue.highlight-colours.v1"))).toEqual({});
  });
  it("keeps a shared choice authoritative over a stale local preference", async () => {
    saveHighlightColour(id, "pink");
    const highlight = { id, colour: "yellow" as const };
    expect(highlightColour(highlight as never, { [id]: "pink" })).toBe("yellow");
    const update = vi.fn();
    window.leaflogue = { library: { listHighlights: vi.fn().mockResolvedValue({ entries: [highlight], hasMore: false }), updateHighlight: update } } as never;
    await migrateHighlightColours();
    expect(update).not.toHaveBeenCalled();
    expect(readHighlightColours(localStorage.getItem("leaflogue.highlight-colours.v1"))).toEqual({});
  });
});
