import { useSyncExternalStore } from "react";
import type { Highlight, ThemeTokens } from "@leaflogue/contracts";
import { contrastRatio } from "@leaflogue/ui";
import { readerColor } from "./reader-colors";
export const HIGHLIGHT_COLOURS = ["yellow", "green", "blue", "pink", "purple"] as const;
export type HighlightColour = typeof HIGHLIGHT_COLOURS[number];
const KEY = "leaflogue.highlight-colours.v1";
const empty: Readonly<Record<string, HighlightColour>> = Object.freeze({});
let snapshot: Readonly<Record<string, HighlightColour>> | undefined;
const listeners = new Set<() => void>();
export function isHighlightColour(value: unknown): value is HighlightColour { return HIGHLIGHT_COLOURS.some((item) => item === value); }
export function readHighlightColours(raw: string | null): Readonly<Record<string, HighlightColour>> {
  try {
    if (!raw || raw.length > 8 * 1024 * 1024) return empty;
    const value = JSON.parse(raw) as { version?: unknown; colours?: unknown };
    if (value.version !== 1 || !value.colours || typeof value.colours !== "object" || Array.isArray(value.colours)) return empty;
    const result: Record<string, HighlightColour> = {};
    for (const [id, colour] of Object.entries(value.colours).slice(0, 100000)) if (/^[\da-f-]{36}$/iu.test(id) && isHighlightColour(colour)) result[id] = colour;
    return result;
  } catch { return empty; }
}
function read() { try { return readHighlightColours(localStorage.getItem(KEY)); } catch { return empty; } }
function publish(next: Readonly<Record<string, HighlightColour>>) { snapshot = next; for (const listener of listeners) listener(); }
function subscribe(listener: () => void) {
  listeners.add(listener);
  const storage = (event: StorageEvent) => { if (event.key === KEY || event.key === null) publish(read()); };
  const theme = () => publish({ ...(snapshot ?? read()) });
  const observer = new MutationObserver(theme); observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme", "data-appearance"] });
  window.addEventListener("storage", storage);
  const media = window.matchMedia?.("(prefers-color-scheme: dark)"); media?.addEventListener("change", theme);
  return () => { listeners.delete(listener); observer.disconnect(); window.removeEventListener("storage", storage); media?.removeEventListener("change", theme); if (!listeners.size) snapshot = undefined; };
}
export function useHighlightColours() { return useSyncExternalStore(subscribe, () => snapshot ?? (snapshot = read()), () => empty); }
export function saveHighlightColour(id: string, colour: HighlightColour) {
  if (!/^[\da-f-]{36}$/iu.test(id) || !isHighlightColour(colour)) throw new Error("Choose a supported highlight colour.");
  const next = { ...read() }; if (colour === "yellow") delete next[id]; else next[id] = colour;
  const raw = JSON.stringify({ version: 1, colours: next });
  if (raw.length > 8 * 1024 * 1024) throw new Error("Highlight colour preferences are full.");
  localStorage.setItem(KEY, raw); publish(next);
}
/** The shared record wins over old per-device preferences, including explicit yellow. */
export function highlightColour(highlight: Pick<Highlight, "id" | "colour">, legacy: Readonly<Record<string, HighlightColour>>) {
  return highlight.colour ?? legacy[highlight.id] ?? "yellow";
}
export async function updateHighlightColour(highlight: Highlight, colour: HighlightColour) {
  const result = await window.leaflogue.library.updateHighlight({
    id: highlight.id, bookId: highlight.bookId, text: highlight.text,
    ...(highlight.sourceLocation !== undefined ? { sourceLocation: highlight.sourceLocation } : {}),
    expectedRevision: highlight.revision, colour,
  });
  // Only clear the old preference after a durable save. A failed request is retryable.
  try { saveHighlightColour(highlight.id, "yellow"); } catch { /* shared record is authoritative */ }
  window.dispatchEvent(new Event("leaflogue:annotations-changed"));
  return result;
}
let migrating: Promise<void> | undefined;
export function migrateHighlightColours(): Promise<void> {
  if (migrating) return migrating;
  migrating = (async () => {
    const legacy = read();
    if (!Object.keys(legacy).length) return;
    for (let offset = 0; ; offset += 100) {
      const page = await window.leaflogue.library.listHighlights({ offset, limit: 100, sort: "oldest" });
      for (const highlight of page.entries) {
        const colour = legacy[highlight.id];
        if (!colour) continue;
        if (highlight.colour !== undefined) {
          try { saveHighlightColour(highlight.id, "yellow"); } catch { /* retry next time */ }
        } else {
          // Revision checks prevent overwriting a choice made elsewhere during migration.
          try { await updateHighlightColour(highlight, colour); } catch { /* keep legacy for retry */ }
        }
      }
      if (!page.hasMore) return;
    }
  })().finally(() => { migrating = undefined; });
  return migrating;
}
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
