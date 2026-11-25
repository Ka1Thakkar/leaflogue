import { useSyncExternalStore } from "react";
import { HIGHLIGHT_COLOURS, type HighlightColour, type Highlight, type ThemeTokens } from "@leaflogue/contracts";
import { contrastRatio } from "@leaflogue/ui";
import { readerColor } from "./reader-colors";
export function highlightColour(highlight: Pick<Highlight, "colour">): HighlightColour { return highlight.colour ?? "yellow"; }
export async function updateHighlightColour(highlight: Highlight, colour: HighlightColour) {
  const result = await window.leaflogue.library.updateHighlight({
    id: highlight.id, bookId: highlight.bookId, text: highlight.text,
    ...(highlight.sourceLocation !== undefined ? { sourceLocation: highlight.sourceLocation } : {}),
    expectedRevision: highlight.revision, colour,
  });
  window.dispatchEvent(new Event("leaflogue:annotations-changed"));
  return result;
}
type Palette = ReturnType<typeof currentHighlightPalette>;
let paletteSnapshot: Palette | undefined;
let stopPaletteWatch: (() => void) | undefined;
const paletteListeners = new Set<() => void>();
const getPaletteSnapshot = () => paletteSnapshot ??= currentHighlightPalette();
function subscribePalette(listener: () => void) {
  paletteListeners.add(listener);
  if (!stopPaletteWatch) {
    const changed = () => {
      paletteSnapshot = currentHighlightPalette();
      for (const notify of paletteListeners) notify();
    };
    const observer = new MutationObserver(changed);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme", "data-appearance"] });
    const media = window.matchMedia?.("(prefers-color-scheme: dark)"); media?.addEventListener("change", changed);
    stopPaletteWatch = () => { observer.disconnect(); media?.removeEventListener("change", changed); };
  }
  return () => {
    paletteListeners.delete(listener);
    if (!paletteListeners.size) { stopPaletteWatch?.(); stopPaletteWatch = undefined; paletteSnapshot = undefined; }
  };
}
export function useHighlightPalette() { return useSyncExternalStore(subscribePalette, getPaletteSnapshot); }
const seeds: Record<HighlightColour, string> = { yellow: "#ffd84d", green: "#62bb78", blue: "#669ee8", pink: "#eb83b4", purple: "#ac89dc" };
function blend(a: string, b: string) { return `#${[1, 3, 5].map((offset) => Math.round(parseInt(a.slice(offset, offset + 2), 16) * 0.55 + parseInt(b.slice(offset, offset + 2), 16) * 0.45).toString(16).padStart(2, "0")).join("")}`; }
export function highlightPalette(tokens: ThemeTokens, dark: boolean) {
  return Object.fromEntries(HIGHLIGHT_COLOURS.map((name) => {
    const base = readerColor(seeds[name], "border-color", dark, tokens, 20);
    const fill = blend(tokens.paper.slice(0, 7), base);
    return [name, { ink: readerColor(seeds[name], "color", dark, tokens, 20), fill, text: contrastRatio("#000000", fill) >= contrastRatio("#ffffff", fill) ? "#000000" : "#ffffff" }];
  })) as Record<HighlightColour, { ink: string; fill: string; text: string }>;
}
export function currentHighlightPalette() {
  const style = getComputedStyle(document.documentElement);
  const colour = (key: string, fallback: string) => { const value = style.getPropertyValue(key).trim(); return /^#[\da-f]{6}(?:[\da-f]{2})?$/iu.test(value) ? value : fallback; };
  const paper = colour("--paper", "#ffffff"), ink = colour("--ink", "#222222"), pen = colour("--pen", "#4477aa");
  const tokens: ThemeTokens = { paper, ink, pen, dot: ink, pencil: ink, highlighter: colour("--highlighter", "#ffd84d"), highlighterWash: "#ffd84d", ruled: paper, ruledLine: ink, kraft: colour("--kraft", "#c9a97d"), kraftInk: ink, stamp: colour("--stamp", "#bf453a"), hairline: ink, edge: ink, drop: ink, muted: colour("--muted", paper), border: ink, controlBorder: ink, chart: colour("--chart", pen) };
  const dark = [1, 3, 5].reduce((sum, offset) => sum + parseInt(paper.slice(offset, offset + 2), 16), 0) < 384;
  return highlightPalette(tokens, dark);
}
