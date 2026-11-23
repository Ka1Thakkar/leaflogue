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
interface Store {
  global: ReaderPreferences;
  books: Record<string, ReaderPreferences>;
  /** Book settings that are switched off but kept, so switching back on restores them. */
  inactiveBooks: Record<string, ReaderPreferences>;
  presets: { name: string; preferences: ReaderPreferences }[];
}
const KEY = "leaflogue.reader-preferences.v1";
const LEGACY_KEY = "leaflogue.reader-display";
const emptyStore = (): Store => ({ global: { ...DEFAULT_READER_PREFERENCES }, books: {}, inactiveBooks: {}, presets: [] });
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
function readItem(key: string): { present: boolean; value?: unknown; malformed?: boolean } {
  let text: string | null;
  try { text = localStorage.getItem(key); } catch { return { present: false }; }
  if (text === null) return { present: false };
  try { return { present: true, value: JSON.parse(text) as unknown }; } catch { return { present: true, malformed: true }; }
}
function bookSection(value: unknown): Record<string, ReaderPreferences> {
  const books: Record<string, ReaderPreferences> = {};
  // A damaged entry is dropped rather than turned into defaults for that book.
  if (isRecord(value)) for (const [id, entry] of Object.entries(value).slice(0, 500)) if (isRecord(entry)) books[id] = validateReaderPreferences(entry);
  return books;
}
/**
 * Each section is read on its own, so one damaged part never resets the
 * others. The legacy display setting is only a migration source when no
 * current preferences exist.
 */
export function readReaderPreferenceStore(): Store {
  const current = readItem(KEY);
  if (!current.present) {
    const legacy = readItem(LEGACY_KEY);
    return { ...emptyStore(), global: validateReaderPreferences(legacy.malformed ? undefined : legacy.value) };
  }
  if (!isRecord(current.value)) {
    // Keep the unreadable original so nothing is lost when defaults are saved.
    try { const raw = localStorage.getItem(KEY); if (raw !== null) localStorage.setItem(`${KEY}.corrupt`, raw); } catch { /* Storage unavailable. */ }
    return emptyStore();
  }
  const raw = current.value;
  const presets = Array.isArray(raw.presets) ? raw.presets.slice(0, 20).flatMap((value: unknown) => isRecord(value) && typeof value.name === "string" ? [{ name: value.name.slice(0, 40), preferences: validateReaderPreferences(value.preferences) }] : []) : [];
  return { global: validateReaderPreferences(raw.global), books: bookSection(raw.books), inactiveBooks: bookSection(raw.inactiveBooks), presets };
}
export function useReaderPreferences(bookId: string) {
  const [store, setStore] = useState(readReaderPreferenceStore);
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* Remain usable with session-only preferences. */ } }, [store]);
  const override = Object.hasOwn(store.books, bookId);
  const preferences = override ? store.books[bookId]! : store.global;
  const update = (next: ReaderPreferences) => setStore((current) => Object.hasOwn(current.books, bookId) ? { ...current, books: { ...current.books, [bookId]: validateReaderPreferences(next) } } : { ...current, global: validateReaderPreferences(next) });
  return { preferences, update, override, presets: store.presets,
    /** Whether this book has its own settings, switched on or off. */
    savedBookSettings: override || Object.hasOwn(store.inactiveBooks, bookId),
    setOverride: (enabled: boolean) => setStore((current) => {
      const books = { ...current.books }; const inactiveBooks = { ...current.inactiveBooks };
      if (enabled) { books[bookId] = inactiveBooks[bookId] ?? { ...current.global }; delete inactiveBooks[bookId]; }
      else if (books[bookId]) { inactiveBooks[bookId] = books[bookId]; delete books[bookId]; }
      return { ...current, books, inactiveBooks };
    }),
    forgetBookSettings: () => setStore((current) => {
      const books = { ...current.books }; const inactiveBooks = { ...current.inactiveBooks };
      delete books[bookId]; delete inactiveBooks[bookId];
      return { ...current, books, inactiveBooks };
    }),
    savePreset: (name: string) => setStore((current) => ({ ...current, presets: [...current.presets.filter((p) => p.name !== name.trim()), { name: name.trim().slice(0, 40), preferences: { ...preferences } }].slice(-20) })),
    removePreset: (name: string) => setStore((current) => ({ ...current, presets: current.presets.filter((p) => p.name !== name) })),
  };
}

/** Preferences that change how text is set. Display-only choices (clock, colours) are excluded. */
export type ReaderTypography = Pick<ReaderPreferences, "size" | "weight" | "alignment" | "line" | "paragraph" | "indent" | "letter" | "word" | "hyphenation" | "horizontal" | "vertical">;
interface Original { element: HTMLElement; size: number; weight: number; inlineWeight: string; priority: string; prose: boolean; inline: Map<string, [string, string]> }
const originals = new WeakMap<Document, Original[]>();
const applied = new WeakMap<Document, ReaderTypography>();
/** Publisher inline declarations that a user choice replaces, by preference. */
const INLINE_OVERRIDES = {
  alignment: ["text-align"], line: ["line-height"], indent: ["text-indent"],
  paragraph: ["margin", "margin-top", "margin-bottom", "margin-block", "margin-block-start", "margin-block-end"],
} as const;
const userSet = (p: ReaderTypography, key: keyof typeof INLINE_OVERRIDES) => key === "alignment" ? p.alignment !== "publisher" : key === "line" ? p.line > 0 : p[key] >= 0;
/**
 * Size/weight overrides preserve publisher hierarchy and relative emphasis.
 * Only values that changed since the last call are written, so a repeated
 * call costs nothing per element.
 */
export function applyReaderTypography(doc: Document, p: ReaderTypography) {
  let values = originals.get(doc);
  if (!values) {
    values = Array.from(doc.querySelectorAll<HTMLElement>("#reader-pages, #reader-pages *")).map((element) => {
      const css = doc.defaultView!.getComputedStyle(element);
      if (element.matches("p,li,blockquote") && (["center", "right", "end"].includes(css.textAlign) || css.whiteSpace.startsWith("pre") || element.closest("figcaption,pre"))) element.dataset.publisherSpecial = "true";
      const prose = element.matches("#reader-pages :is(p,li,blockquote)") && !element.dataset.publisherSpecial;
      const inline = new Map<string, [string, string]>();
      if (prose) for (const property of Object.values(INLINE_OVERRIDES).flat()) {
        const value = element.style.getPropertyValue(property);
        if (value) inline.set(property, [value, element.style.getPropertyPriority(property)]);
      }
      return { element, prose, inline, inlineWeight: element.style.getPropertyValue("font-weight"), priority: element.style.getPropertyPriority("font-weight"), size: parseFloat(css.fontSize) || 18, weight: parseInt(css.fontWeight) || 400 };
    }); originals.set(doc, values);
  }
  const previous = applied.get(doc);
  const sizeChanged = previous?.size !== p.size; const weightChanged = previous?.weight !== p.weight;
  const overrides = (Object.keys(INLINE_OVERRIDES) as (keyof typeof INLINE_OVERRIDES)[]).filter((key) => !previous || userSet(previous, key) !== userSet(p, key));
  for (const { element, size, weight, inlineWeight, priority, inline } of values) {
    if (sizeChanged) element.style.setProperty("font-size", `${size * p.size / 18}px`, "important");
    if (weightChanged) {
      if (p.weight) element.style.setProperty("font-weight", String(Math.min(950, weight + p.weight)), "important");
      else if (inlineWeight) element.style.setProperty("font-weight", inlineWeight, priority);
      else element.style.removeProperty("font-weight");
    }
    // Publisher inline !important would beat the reader's rules, so while the
    // reader chooses a value those declarations drop to normal priority.
    for (const key of overrides) for (const property of INLINE_OVERRIDES[key]) {
      const original = inline.get(property);
      if (original?.[1] === "important") element.style.setProperty(property, original[0], userSet(p, key) ? "" : "important");
    }
  }
  let style = doc.getElementById("reader-typography");
  if (!style) { style = doc.createElement("style"); style.id = "reader-typography"; doc.head.append(style); }
  // Do not flatten title/caption/verse alignment or typographic emphasis.
  const prose = '#reader-pages :is(p,li,blockquote):not([data-publisher-special])';
  const rules = `${prose}{${p.alignment !== "publisher" ? `text-align:${p.alignment}!important;` : ""}${p.line ? `line-height:${p.line}!important;` : ""}${p.paragraph >= 0 ? `margin-block:0 ${p.paragraph}em!important;` : ""}${p.indent >= 0 ? `text-indent:${p.indent}em!important;` : ""}${p.letter ? `letter-spacing:${p.letter}em!important;` : ""}${p.word ? `word-spacing:${p.word}em!important;` : ""}${p.hyphenation !== "publisher" ? `hyphens:${p.hyphenation}!important;` : ""}}`;
  if (style.textContent !== rules) style.textContent = rules;
  if (doc.body.style.getPropertyValue("font-size") !== `${p.size}px`) doc.body.style.setProperty("font-size", `${p.size}px`);
  const padding = `${p.vertical}px ${p.horizontal}px`;
  if (doc.body.style.getPropertyValue("padding") !== padding || doc.body.style.getPropertyPriority("padding") !== "important") doc.body.style.setProperty("padding", padding, "important");
  applied.set(doc, { ...p });
}
