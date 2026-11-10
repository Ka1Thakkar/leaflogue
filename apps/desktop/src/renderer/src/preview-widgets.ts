import { customWidgetSlot, type BookId, type CustomWidget, type DashboardLayouts, type HighlightId, type LeaflogueBridge, type NoteId, type ReadingStatus } from "@leaflogue/contracts";
import { customWidgetIdFor, evaluateWidget, parseCustomWidget, type WidgetDataset } from "@leaflogue/domain";
import { DEFAULT_LAYOUTS } from "./components/dashboard/layout";

/*
 * Custom widgets for the browser preview: a fixed, made-up library to count,
 * and the bridge calls answered in memory, so the builder and the dashboards
 * draw the same thing on every run.
 */

const BOOKS: readonly { id: string; title: string; authors: string[]; series?: string; publisher: string; status: ReadingStatus; finishedYear?: number }[] = [
  { id: "bd809783-25e1-4d95-80a0-d03442a57d5c", title: "Piranesi", authors: ["Susanna Clarke"], publisher: "Bloomsbury", status: "reading" },
  { id: "ad97b895-7fd8-46af-8de1-c12b1ca284af", title: "Jonathan Strange & Mr Norrell", authors: ["Susanna Clarke"], publisher: "Bloomsbury", status: "finished", finishedYear: 2025 },
  { id: "6b0f0c55-3c1e-4c55-9b63-1f6f0d1e7a01", title: "A Wizard of Earthsea", authors: ["Ursula K. Le Guin"], series: "Earthsea", publisher: "Puffin", status: "finished", finishedYear: 2024 },
  { id: "6b0f0c55-3c1e-4c55-9b63-1f6f0d1e7a02", title: "The Tombs of Atuan", authors: ["Ursula K. Le Guin"], series: "Earthsea", publisher: "Puffin", status: "finished", finishedYear: 2025 },
  { id: "6b0f0c55-3c1e-4c55-9b63-1f6f0d1e7a03", title: "The Left Hand of Darkness", authors: ["Ursula K. Le Guin"], publisher: "Gollancz", status: "paused" },
  { id: "6b0f0c55-3c1e-4c55-9b63-1f6f0d1e7a04", title: "Circe", authors: ["Madeline Miller"], publisher: "Bloomsbury", status: "finished", finishedYear: 2026 },
];
const TAGS = ["Favourite", "Quote", "Craft", "Place"] as const;
const LINES = [
  "The Beauty of the House is immeasurable; its Kindness infinite.",
  "To light a candle is to cast a shadow.",
  "Only in silence the word, only in dark the light, only in dying life.",
  "Light is the left hand of darkness, and darkness the right hand of light.",
  "It is a curious thing, the death of a loved one.",
  "I thought once that gods are the opposite of death, but I see now they are more dead than anything.",
  "Can a magician kill a man by magic? Lord Wellington asked Strange.",
];

function dataset(): WidgetDataset {
  const passages: WidgetDataset["passages"][number][] = [];
  const notes: WidgetDataset["notes"][number][] = [];
  // About 160 passages over two years, busier in the evening and at weekends.
  for (let index = 0; index < 160; index += 1) {
    const book = BOOKS[(index * 7 + Math.floor(index / 9)) % BOOKS.length]!;
    const day = new Date(2026, 9, 28 - ((index * 37) % 700));
    day.setHours([21, 22, 20, 7, 13, 23, 19, 8][index % 8]!, (index * 13) % 60);
    const text = Array.from({ length: 1 + (index % 3) }, (_, line) => LINES[(index + line) % LINES.length]!).join(" ");
    const tagged = index % 3 === 0 ? [TAGS[index % TAGS.length]!] : index % 5 === 0 ? ["Favourite"] : [];
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` as HighlightId;
    passages.push({ id, bookId: book.id as BookId, text, at: day.getTime(), timed: index % 6 !== 0, notes: index % 4 === 0 ? 1 : 0, tags: tagged, threads: index % 11 === 0 ? ["Light and dark"] : [] });
    if (index % 4 === 0) notes.push({ id: `00000000-0000-4000-9000-${String(index).padStart(12, "0")}` as NoteId, bookId: book.id as BookId, highlightId: id, text: "Worth coming back to.", at: day.getTime(), timed: true });
  }
  return {
    books: BOOKS.map((book) => ({ ...book, id: book.id as BookId, language: "en", archived: false })),
    passages,
    notes,
  };
}

/** A few widgets of the kind the docs' gallery offers, shown with ?custom-widgets. */
export const PREVIEW_WIDGETS: readonly CustomWidget[] = [
  { id: "favourites", version: 1, title: "Favourite passages", count: "passages", where: [{ field: "tag", is: "favourite" }], show: "number" },
  { id: "night-owl", version: 1, title: "When you highlight", description: "Passages by the hour of the day", count: "passages", groupBy: "hour", show: "bars", sort: "label", limit: 24 },
  { id: "authors", version: 1, title: "Authors you keep", count: "passages", groupBy: "author", show: "ranked", limit: 6 },
];

export function previewDashboards(query: URLSearchParams): DashboardLayouts {
  if (!query.has("custom-widgets")) return {};
  return {
    widgets: PREVIEW_WIDGETS,
    statistics: [
      ...DEFAULT_LAYOUTS.statistics.slice(0, 5),
      { widget: customWidgetSlot("favourites") },
      { widget: customWidgetSlot("night-owl"), width: "two-thirds" },
      { widget: customWidgetSlot("authors") },
      ...DEFAULT_LAYOUTS.statistics.slice(6),
    ],
  };
}

const IMPORTED: CustomWidget = { id: "notes-by-month", version: 1, title: "Notes by month", count: "notes", groupBy: "month", show: "bars", sort: "label", limit: 12 };

export function previewWidgetsBridge(layouts: { get(): DashboardLayouts; set(next: DashboardLayouts): void }): LeaflogueBridge["widgets"] {
  const data = dataset();
  const strip = (current: DashboardLayouts, widgets: readonly CustomWidget[]): DashboardLayouts => {
    const known = new Set(widgets.map(({ id }) => customWidgetSlot(id)));
    const keep = (layout: DashboardLayouts["library"]) => layout?.filter(({ widget }) => !widget.startsWith("custom:") || known.has(widget as `custom:${string}`));
    const library = keep(current.library);
    const statistics = keep(current.statistics);
    return { ...(library ? { library } : {}), ...(statistics ? { statistics } : {}), ...(widgets.length > 0 ? { widgets } : {}) };
  };
  return Object.freeze({
    save: async (widget: CustomWidget) => {
      const parsed = parseCustomWidget(widget);
      const widgets = layouts.get().widgets ?? [];
      const next = widgets.some(({ id }) => id === parsed.id) ? widgets.map((entry) => (entry.id === parsed.id ? parsed : entry)) : [...widgets, parsed];
      layouts.set(strip(layouts.get(), next));
      return layouts.get();
    },
    delete: async (id: string) => {
      layouts.set(strip(layouts.get(), (layouts.get().widgets ?? []).filter((widget) => widget.id !== id)));
      return layouts.get();
    },
    evaluate: async (widgets: readonly CustomWidget[]) => {
      const { timeZone } = Intl.DateTimeFormat().resolvedOptions();
      return widgets.map((widget) => evaluateWidget(data, parseCustomWidget(widget), { timeZone }));
    },
    export: async (id: string) => {
      const widget = layouts.get().widgets?.find((entry) => entry.id === id);
      return widget ? { fileName: `${id}.leaflogue-widget.json`, title: widget.title } : undefined;
    },
    import: async () => {
      const widgets = layouts.get().widgets ?? [];
      if (widgets.some(({ title }) => title === IMPORTED.title)) return { layouts: layouts.get(), added: [], unchanged: 1 };
      const id = customWidgetIdFor(IMPORTED.title, widgets.map((widget) => widget.id));
      layouts.set(strip(layouts.get(), [...widgets, { ...IMPORTED, id }]));
      return { layouts: layouts.get(), added: [IMPORTED.title], unchanged: 0 };
    },
  });
}
