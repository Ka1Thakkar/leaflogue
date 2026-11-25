/** @vitest-environment happy-dom */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_THEMES } from "@leaflogue/appearance";
import { contrastRatio } from "@leaflogue/ui";
import { highlightColour, highlightPalette, updateHighlightColour, useHighlightPalette } from "./highlight-colours";
const id = "12345678-1234-4234-8234-123456789abc";
afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });
describe("per-highlight theme colours", () => {
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

describe("shared highlight colour", () => {
  it("reads only the shared record and defaults to yellow", () => {
    expect(highlightColour({ colour: "green" })).toBe("green");
    expect(highlightColour({})).toBe("yellow");
  });
  it("updates the record with its revision and reports failures", async () => {
    const highlight = { id, bookId: id, text: "A line", revision: 2 };
    const update = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ ...highlight, colour: "green" });
    vi.stubGlobal("leaflogue", { library: { updateHighlight: update } });
    await expect(updateHighlightColour(highlight as never, "green")).rejects.toThrow("offline");
    await updateHighlightColour(highlight as never, "green");
    expect(update).toHaveBeenLastCalledWith({ id, bookId: id, text: "A line", expectedRevision: 2, colour: "green" });
  });
});

it("shares one theme watcher across passages and releases it after the last subscriber", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const disconnect = vi.fn();
  let changed!: () => void;
  const watch = vi.fn(function (this: object, callback: () => void) { changed = callback; return { observe: vi.fn(), disconnect }; });
  vi.stubGlobal("MutationObserver", watch);
  const palettes: Array<ReturnType<typeof useHighlightPalette>> = [];
  function Probe({ index }: { index: number }) { palettes[index] = useHighlightPalette(); return null; }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(createElement("div", null, createElement(Probe, { index: 0 }), createElement(Probe, { index: 1 }))));
    expect(watch).toHaveBeenCalledTimes(1);
    expect(palettes[0]).toBe(palettes[1]);
    const original = palettes[0]!.green.fill;
    document.documentElement.style.setProperty("--paper", "#121212");
    await act(async () => changed());
    expect(palettes[0]).toBe(palettes[1]);
    expect(palettes[0]!.green.fill).not.toBe(original);
    await act(async () => root.render(createElement("div", null, createElement(Probe, { index: 0 }))));
    expect(disconnect).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    document.documentElement.style.removeProperty("--paper");
  }
  expect(disconnect).toHaveBeenCalledTimes(1);
});
