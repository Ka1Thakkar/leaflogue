import { useEffect, useState } from "react";

export const DEFAULT_READER_PREFERENCES = {
  dark: true, theme: false, size: 18, weight: 0, alignment: "publisher", line: 0, paragraph: -1, indent: -1,
  horizontal: 32, vertical: 32, width: 68, columns: "auto", letter: 0, word: 0,
  hyphenation: "publisher", palette: "default", surround: "page",
  progress: false, chapter: false, clock: false,
} as const;
export type ReaderPreferences = { -readonly [K in keyof typeof DEFAULT_READER_PREFERENCES]: typeof DEFAULT_READER_PREFERENCES[K] extends number ? number : typeof DEFAULT_READER_PREFERENCES[K] extends boolean ? boolean : string };
const limits: Partial<Record<keyof ReaderPreferences, [number, number]>> = {
  size: [12, 48], weight: [0, 400], line: [0, 2.6], paragraph: [-1, 2], indent: [-1, 3],
  horizontal: [8, 96], vertical: [8, 96], width: [30, 120], letter: [-0.03, 0.15], word: [-0.05, 0.5],
};
const choices: Partial<Record<keyof ReaderPreferences, readonly string[]>> = {
  alignment: ["publisher", "left", "justify"], columns: ["auto", "one", "two"],
  hyphenation: ["publisher", "auto", "none"], palette: ["default", "sepia"], surround: ["page", "app"],
};
export function validateReaderPreferences(input: unknown): ReaderPreferences {
  const result: ReaderPreferences = { ...DEFAULT_READER_PREFERENCES };
  if (!input || typeof input !== "object" || Array.isArray(input)) return result;
  const source = input as Record<string, unknown>;
  for (const key of Object.keys(result) as (keyof ReaderPreferences)[]) {
    const value = source[key]; const range = limits[key]; const options = choices[key];
    if (range && typeof value === "number" && Number.isFinite(value)) Object.assign(result, { [key]: Math.max(range[0], Math.min(range[1], value)) });
    else if (options && typeof value === "string" && options.includes(value)) Object.assign(result, { [key]: value });
    else if (typeof result[key] === "boolean" && typeof value === "boolean") Object.assign(result, { [key]: value });
  }
  if (result.line > 0) result.line = Math.max(1, result.line);
  if (result.paragraph < 0) result.paragraph = -1;
  if (result.indent < 0) result.indent = -1;
  return result;
}
interface Store { global: ReaderPreferences; books: Record<string, ReaderPreferences>; presets: { name: string; preferences: ReaderPreferences }[] }
const KEY = "leaflogue.reader-preferences.v1";
function readStore(): Store {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as { books?: unknown; global?: unknown; presets?: unknown } | null;
    const books: Record<string, ReaderPreferences> = {};
    if (raw?.books && typeof raw.books === "object") for (const [id, value] of Object.entries(raw.books).slice(0, 500)) books[id] = validateReaderPreferences(value);
    const legacy = JSON.parse(localStorage.getItem("leaflogue.reader-display") ?? "null");
    return { global: validateReaderPreferences(raw?.global ?? legacy), books, presets: Array.isArray(raw?.presets) ? raw.presets.slice(0, 20).flatMap((value: unknown) => { const p = value as { name?: unknown; preferences?: unknown } | null; return typeof p?.name === "string" ? [{ name: p.name.slice(0, 40), preferences: validateReaderPreferences(p.preferences) }] : []; }) : [] };
  } catch { return { global: { ...DEFAULT_READER_PREFERENCES }, books: {}, presets: [] }; }
}
export function useReaderPreferences(bookId: string) {
  const [store, setStore] = useState(readStore);
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* Remain usable with session-only preferences. */ } }, [store]);
  const override = Object.hasOwn(store.books, bookId);
  const preferences = override ? store.books[bookId]! : store.global;
  const update = (next: ReaderPreferences) => setStore((current) => Object.hasOwn(current.books, bookId) ? { ...current, books: { ...current.books, [bookId]: validateReaderPreferences(next) } } : { ...current, global: validateReaderPreferences(next) });
  return { preferences, update, override, presets: store.presets,
    setOverride: (enabled: boolean) => setStore((current) => {
      const books = { ...current.books }; if (enabled) books[bookId] = { ...current.global }; else delete books[bookId];
      return { ...current, books };
    }),
    savePreset: (name: string) => setStore((current) => ({ ...current, presets: [...current.presets.filter((p) => p.name !== name.trim()), { name: name.trim().slice(0, 40), preferences: { ...preferences } }].slice(-20) })),
    removePreset: (name: string) => setStore((current) => ({ ...current, presets: current.presets.filter((p) => p.name !== name) })),
  };
}
const originals = new WeakMap<Document, { element: HTMLElement; size: number; weight: number; inlineWeight: string; priority: string }[]>();
/** Size/weight overrides preserve publisher hierarchy and relative emphasis. */
export function applyReaderTypography(doc: Document, p: ReaderPreferences) {
  let values = originals.get(doc);
  if (!values) {
    values = Array.from(doc.querySelectorAll<HTMLElement>("#reader-pages, #reader-pages *")).map((element) => {
      const css = doc.defaultView!.getComputedStyle(element);
      if (element.matches("p,li,blockquote") && (["center", "right", "end"].includes(css.textAlign) || css.whiteSpace.startsWith("pre") || element.closest("figcaption,pre"))) element.dataset.publisherSpecial = "true";
      return { element, inlineWeight: element.style.getPropertyValue("font-weight"), priority: element.style.getPropertyPriority("font-weight"), size: parseFloat(css.fontSize) || 18, weight: parseInt(css.fontWeight) || 400 };
    }); originals.set(doc, values);
  }
  for (const { element, size, weight, inlineWeight, priority } of values) {
    element.style.setProperty("font-size", `${size * p.size / 18}px`, "important");
    if (p.weight) element.style.setProperty("font-weight", String(Math.min(950, weight + p.weight)), "important");
    else if (inlineWeight) element.style.setProperty("font-weight", inlineWeight, priority);
    else element.style.removeProperty("font-weight");
  }
  let style = doc.getElementById("reader-typography");
  if (!style) { style = doc.createElement("style"); style.id = "reader-typography"; doc.head.append(style); }
  // Do not flatten title/caption/verse alignment or typographic emphasis.
  const prose = '#reader-pages :is(p,li,blockquote):not([data-publisher-special])';
  style.textContent = `${prose}{${p.alignment !== "publisher" ? `text-align:${p.alignment}!important;` : ""}${p.line ? `line-height:${p.line}!important;` : ""}${p.paragraph >= 0 ? `margin-block:0 ${p.paragraph}em!important;` : ""}${p.indent >= 0 ? `text-indent:${p.indent}em!important;` : ""}${p.letter ? `letter-spacing:${p.letter}em!important;` : ""}${p.word ? `word-spacing:${p.word}em!important;` : ""}${p.hyphenation !== "publisher" ? `hyphens:${p.hyphenation}!important;` : ""}}`;
  doc.body.style.setProperty("font-size", `${p.size}px`);
  doc.body.style.setProperty("padding", `${p.vertical}px ${p.horizontal}px`, "important");
}
