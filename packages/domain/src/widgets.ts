import {
  CUSTOM_WIDGET_FILE_FORMAT,
  CUSTOM_WIDGET_VERSION,
  normalizeOrganizationName,
  WIDGET_CHARTS,
  WIDGET_COUNTS,
  WIDGET_FIELDS,
  WIDGET_FIELDS_BY_COUNT,
  WIDGET_LIMITS,
  WIDGET_SORTS,
  type BookId,
  type CustomWidget,
  type CustomWidgetFile,
  type HighlightId,
  type LibraryExportDocument,
  type NoteId,
  type ReadingStatus,
  type ReadingStatusEvent,
  type WidgetChart,
  type WidgetCount,
  type WidgetField,
  type WidgetFilter,
  type WidgetGroup,
  type WidgetItem,
  type WidgetResult,
  type WidgetSort,
} from "@leaflogue/contracts";

/*
 * Custom dashboard widgets: validating a recipe, and counting it over a
 * library. Pure and platform-free, so the desktop and the web app evaluate a
 * shared widget file the same way.
 */

/** What a widget can count, flattened from a library. */
export interface WidgetDataset {
  /** Every book, archived ones too: their passages are part of the reader's history. */
  readonly books: readonly WidgetDatasetBook[];
  readonly passages: readonly WidgetDatasetPassage[];
  readonly notes: readonly WidgetDatasetNote[];
}

export interface WidgetDatasetBook {
  readonly id: BookId;
  readonly title: string;
  readonly authors: readonly string[];
  readonly series?: string;
  readonly publisher?: string;
  readonly language?: string;
  readonly status: ReadingStatus;
  /** Only when actually known: a completion date, or a finish the reader marked themselves. */
  readonly finishedYear?: number;
  /** Not on the shelf, so not counted as a book; its passages and notes still count. */
  readonly archived: boolean;
}

export interface WidgetDatasetPassage {
  readonly id: HighlightId;
  readonly bookId: BookId;
  readonly text: string;
  /** When it was kept: highlighted, if the device said so, else added. Epoch milliseconds. */
  readonly at: number;
  /** Whether `at` is the device's own time, and so has a meaningful hour. */
  readonly timed: boolean;
  readonly notes: number;
  readonly tags: readonly string[];
  readonly threads: readonly string[];
}

export interface WidgetDatasetNote {
  readonly id: NoteId;
  readonly bookId: BookId;
  readonly highlightId?: HighlightId;
  readonly text: string;
  readonly at: number;
  readonly timed: boolean;
}

export interface WidgetValue {
  readonly key: string;
  readonly label: string;
}

const LENGTHS: readonly (WidgetValue & { readonly max: number })[] = [
  { key: "short", label: "Up to 100", max: 100 },
  { key: "medium", label: "101–300", max: 300 },
  { key: "long", label: "301–600", max: 600 },
  { key: "longest", label: "Over 600", max: Infinity },
];
const WEEKDAYS: readonly WidgetValue[] = [
  { key: "mon", label: "Mon" }, { key: "tue", label: "Tue" }, { key: "wed", label: "Wed" }, { key: "thu", label: "Thu" },
  { key: "fri", label: "Fri" }, { key: "sat", label: "Sat" }, { key: "sun", label: "Sun" },
];
const MONTHS: readonly WidgetValue[] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  .map((label) => ({ key: label.toLowerCase(), label }));
const HOURS: readonly WidgetValue[] = Array.from({ length: 24 }, (_, hour) => ({ key: String(hour), label: String(hour) }));
const HAS_NOTE: readonly WidgetValue[] = [{ key: "yes", label: "With a note" }, { key: "no", label: "Without a note" }];
const STATUSES: readonly WidgetValue[] = [
  { key: "unread", label: "Unread" }, { key: "reading", label: "Reading" }, { key: "finished", label: "Finished" }, { key: "paused", label: "Paused" },
];
/** Relative years, so a shared widget means the same thing next year. */
const RELATIVE_YEARS: readonly WidgetValue[] = [{ key: "this-year", label: "This year" }, { key: "last-year", label: "Last year" }];

export interface WidgetFieldInfo {
  readonly label: string;
  /** The values it can take, in their own order; absent for names drawn from the library. */
  readonly values?: readonly WidgetValue[];
  /** A year: filters also accept `this-year` and `last-year`. */
  readonly year?: boolean;
}

export const WIDGET_FIELD_INFO: Readonly<Record<WidgetField, WidgetFieldInfo>> = {
  length: { label: "Length", values: LENGTHS.map(({ key, label }) => ({ key, label: `${label} characters` })) },
  hour: { label: "Hour of the day", values: HOURS },
  weekday: { label: "Weekday", values: WEEKDAYS },
  month: { label: "Month", values: MONTHS },
  year: { label: "Year", year: true },
  "has-note": { label: "Has a note", values: HAS_NOTE },
  tag: { label: "Tag" },
  thread: { label: "Thread" },
  book: { label: "Book" },
  author: { label: "Author" },
  series: { label: "Series" },
  publisher: { label: "Publisher" },
  language: { label: "Language" },
  status: { label: "Reading status", values: STATUSES },
  "finished-year": { label: "Year finished", year: true },
};

/** Charts that draw groups, and so need a field to group by. */
export const GROUPED_CHARTS: readonly WidgetChart[] = ["bars", "ranked"];

export const widgetFieldsFor = (count: WidgetCount): readonly WidgetField[] => WIDGET_FIELDS_BY_COUNT[count];

/** Defaults a recipe leaves out. */
export function widgetDefaults(widget: Pick<CustomWidget, "show">): { readonly limit: number; readonly sort: WidgetSort } {
  switch (widget.show) {
    case "bars": return { limit: 24, sort: "label" };
    case "ranked": return { limit: 6, sort: "count" };
    case "list": return { limit: 4, sort: "count" };
    default: return { limit: 1, sort: "count" };
  }
}

// --- Validation ---------------------------------------------------------

const ID = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
// Control characters, including bidirectional overrides that could disguise text.
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/u;
const YEAR = /^[0-9]{4}$/u;
const KEYS: ReadonlySet<string> = new Set(["id", "version", "title", "description", "count", "groupBy", "where", "show", "limit", "sort"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be text`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is empty`);
  if ([...trimmed].length > max) throw new Error(`${label} is longer than ${max} characters`);
  if (UNSAFE_TEXT.test(trimmed)) throw new Error(`${label} contains control characters`);
  return trimmed;
}

function oneOf<T extends string>(value: unknown, options: readonly T[], label: string): T {
  if (typeof value !== "string" || !(options as readonly string[]).includes(value)) throw new Error(`${label} is not one of ${options.join(", ")}`);
  return value as T;
}

/** A filter value for a field, in its canonical form. */
export function parseWidgetValue(field: WidgetField, value: unknown): string {
  const info = WIDGET_FIELD_INFO[field];
  const label = `The ${info.label.toLowerCase()} filter`;
  const given = text(value, `${label} value`, WIDGET_LIMITS.value);
  if (info.values) {
    if (!info.values.some(({ key }) => key === given)) throw new Error(`${label} value is not one of ${info.values.map(({ key }) => key).join(", ")}`);
    return given;
  }
  if (info.year) {
    if (!YEAR.test(given) && !RELATIVE_YEARS.some(({ key }) => key === given)) throw new Error(`${label} value must be a year, this-year, or last-year`);
    return given;
  }
  return given;
}

function parseFilter(value: unknown, index: number, count: WidgetCount): WidgetFilter {
  const position = `Filter ${index + 1}`;
  if (!isRecord(value)) throw new Error(`${position} is invalid`);
  const { field, is, isNot, ...rest } = value;
  if (Object.keys(rest).length > 0) throw new Error(`${position} has unknown fields`);
  const parsed = oneOf(field, WIDGET_FIELDS, `${position} field`);
  if (!widgetFieldsFor(count).includes(parsed)) throw new Error(`${position} uses a field ${count} do not have`);
  if ((is === undefined) === (isNot === undefined)) throw new Error(`${position} needs exactly one of is or isNot`);
  return is !== undefined ? { field: parsed, is: parseWidgetValue(parsed, is) } : { field: parsed, isNot: parseWidgetValue(parsed, isNot) };
}

/**
 * Validate a widget recipe from anywhere: the settings file, a shared file,
 * or the builder. Unknown fields are refused, never ignored, so a recipe
 * means exactly what it says.
 */
export function parseCustomWidget(value: unknown): CustomWidget {
  if (!isRecord(value)) throw new Error("A widget must be an object");
  const unknown = Object.keys(value).filter((key) => !KEYS.has(key));
  if (unknown.length > 0) throw new Error(`A widget has unknown fields: ${unknown.slice(0, 3).join(", ")}`);
  if (value.version !== CUSTOM_WIDGET_VERSION) throw new Error("This widget was made for a newer Leaflogue");
  if (typeof value.id !== "string" || value.id.length > WIDGET_LIMITS.id || !ID.test(value.id)) throw new Error("A widget ID must be lowercase letters, digits and dashes");
  const title = text(value.title, "A widget title", WIDGET_LIMITS.title);
  const description = value.description === undefined ? undefined : text(value.description, "A widget description", WIDGET_LIMITS.description);
  const count = oneOf(value.count, WIDGET_COUNTS, "What a widget counts");
  const show = oneOf(value.show, WIDGET_CHARTS, "A widget chart");
  const grouped = GROUPED_CHARTS.includes(show);

  let groupBy: WidgetField | undefined;
  if (value.groupBy !== undefined) {
    if (!grouped) throw new Error(`A ${show} widget is not grouped`);
    groupBy = oneOf(value.groupBy, WIDGET_FIELDS, "A widget's grouping");
    if (!widgetFieldsFor(count).includes(groupBy)) throw new Error(`${count[0]!.toUpperCase()}${count.slice(1)} cannot be grouped by ${WIDGET_FIELD_INFO[groupBy].label.toLowerCase()}`);
  } else if (grouped) {
    throw new Error(`A ${show} widget needs something to group by`);
  }
  if (show === "heatmap" && count === "books") throw new Error("Books have no day to show on a calendar");

  let where: WidgetFilter[] | undefined;
  if (value.where !== undefined) {
    if (!Array.isArray(value.where)) throw new Error("A widget's filters must be a list");
    if (value.where.length > WIDGET_LIMITS.filters) throw new Error(`A widget has more than ${WIDGET_LIMITS.filters} filters`);
    where = value.where.map((filter, index) => parseFilter(filter, index, count));
  }

  let limit: number | undefined;
  if (value.limit !== undefined) {
    if (show === "number" || show === "heatmap") throw new Error(`A ${show} widget has no limit`);
    if (typeof value.limit !== "number" || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > WIDGET_LIMITS.shown) {
      throw new Error(`A widget's limit must be a whole number from 1 to ${WIDGET_LIMITS.shown}`);
    }
    limit = value.limit;
  }

  let sort: WidgetSort | undefined;
  if (value.sort !== undefined) {
    if (!grouped) throw new Error(`A ${show} widget has no sort`);
    sort = oneOf(value.sort, WIDGET_SORTS, "A widget's sort");
  }

  return {
    id: value.id,
    version: CUSTOM_WIDGET_VERSION,
    title,
    ...(description !== undefined ? { description } : {}),
    count,
    ...(groupBy ? { groupBy } : {}),
    ...(where && where.length > 0 ? { where } : {}),
    show,
    ...(limit !== undefined ? { limit } : {}),
    ...(sort ? { sort } : {}),
  };
}

/** The reader's widgets, as stored: each valid, with no repeated ID, and not too many. */
export function parseCustomWidgets(value: unknown): CustomWidget[] {
  if (!Array.isArray(value)) throw new Error("Custom widgets must be a list");
  if (value.length > WIDGET_LIMITS.widgets) throw new Error(`There are more than ${WIDGET_LIMITS.widgets} custom widgets`);
  const seen = new Set<string>();
  return value.map((entry, index) => {
    let widget: CustomWidget;
    try {
      widget = parseCustomWidget(entry);
    } catch (error) {
      // Preserve the cause without the ES2022 Error constructor overload: Convex checks ES2021.
      throw Object.assign(new Error(`Custom widget ${index + 1}: ${error instanceof Error ? error.message : "it is invalid"}`), { cause: error });
    }
    if (seen.has(widget.id)) throw new Error(`Custom widget ${index + 1} repeats the ID "${widget.id}"`);
    seen.add(widget.id);
    return widget;
  });
}

/** A `.leaflogue-widget.json` file's contents. */
export function parseCustomWidgetFile(value: unknown): CustomWidget {
  if (!isRecord(value) || value.format !== CUSTOM_WIDGET_FILE_FORMAT) throw new Error("This is not a Leaflogue widget file");
  if (Object.keys(value).some((key) => key !== "format" && key !== "widget")) throw new Error("This widget file has unknown fields");
  return parseCustomWidget(value.widget);
}

export function customWidgetFile(widget: CustomWidget): CustomWidgetFile {
  return { format: CUSTOM_WIDGET_FILE_FORMAT, widget: parseCustomWidget(widget) };
}

/** An ID for a new widget from its title, unlike any taken. */
export function customWidgetIdFor(title: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = title.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, WIDGET_LIMITS.id - 4).replace(/-+$/u, "") || "widget";
  if (!used.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

// --- The dataset --------------------------------------------------------

/**
 * The year a finished book was finished, when it is actually known: its
 * completion date, else the last time the reader marked it finished here. An
 * import's mark records when the file was read, so it says nothing about when
 * the book was finished and is not used.
 */
export function knownFinishedYear(events: readonly ReadingStatusEvent[], bookId: BookId, completedOn: string | undefined): number | undefined {
  const year = (value: number) => (Number.isInteger(value) ? value : undefined);
  if (completedOn) return year(Number(completedOn.slice(0, 4)));
  const marked = events
    .filter((event) => event.bookId === bookId && event.status === "finished")
    .sort((a, b) => b.changedAt - a.changedAt)[0];
  if (!marked) return undefined;
  if (marked.completedOn) return year(Number(marked.completedOn.slice(0, 4)));
  return marked.source === "reader" ? new Date(marked.changedAt).getUTCFullYear() : undefined;
}

/**
 * Flatten a library export into what widgets count. Tags and threads are
 * carried by name, so a shared widget that filters by a tag finds it in any
 * library that uses the same name.
 */
export function widgetDataset(document: LibraryExportDocument): WidgetDataset {
  const tagNames = new Map(document.tags.map((tag) => [tag.id, tag.name]));
  const passageTags = new Map<string, string[]>();
  for (const organization of document.organizations) {
    for (const { highlightId, tagIds } of organization.highlightTags) {
      passageTags.set(highlightId, tagIds.flatMap((tagId) => tagNames.get(tagId) ?? []));
    }
  }
  const threadNames = new Map(document.threads.map((thread) => [thread.id, thread.name]));
  const passageThreads = new Map<string, string[]>();
  for (const { threadId, highlightId } of document.threadHighlightMemberships) {
    const name = threadNames.get(threadId);
    if (name) passageThreads.set(highlightId, [...(passageThreads.get(highlightId) ?? []), name]);
  }

  const books: WidgetDatasetBook[] = [];
  const passages: WidgetDatasetPassage[] = [];
  const notes: WidgetDatasetNote[] = [];
  for (const { book, highlights, standaloneNotes } of document.books) {
    const finishedYear = book.status === "finished" ? knownFinishedYear(document.readingStatusEvents, book.id, book.completedOn) : undefined;
    books.push({
      id: book.id,
      title: book.title,
      authors: book.authors,
      ...(book.series?.trim() ? { series: book.series.trim() } : {}),
      ...(book.publisher?.trim() ? { publisher: book.publisher.trim() } : {}),
      ...(book.language?.trim() ? { language: book.language.trim() } : {}),
      status: book.status,
      ...(finishedYear !== undefined ? { finishedYear } : {}),
      archived: book.archived,
    });
    for (const highlight of highlights) {
      // Kept when highlighted, if the device said so; else when it was added.
      const timed = highlight.sourceCreatedAt !== undefined;
      const at = highlight.sourceCreatedAt ?? highlight.createdAt;
      passages.push({
        id: highlight.id,
        bookId: book.id,
        text: highlight.text,
        at,
        timed,
        notes: highlight.notes.length,
        tags: passageTags.get(highlight.id) ?? [],
        threads: passageThreads.get(highlight.id) ?? [],
      });
      // An imported note was written with its passage; its own time is when the file was read.
      for (const note of highlight.notes) {
        const imported = note.origin === "import";
        notes.push({ id: note.id, bookId: book.id, highlightId: highlight.id, text: note.markdown, at: imported ? at : note.createdAt, timed: imported ? timed : true });
      }
    }
    for (const note of standaloneNotes) {
      notes.push({ id: note.id, bookId: book.id, text: note.markdown, at: note.createdAt, timed: note.origin !== "import" });
    }
  }
  return { books, passages, notes };
}

/** Whether two recipes say the same thing, whatever their IDs. */
export function sameRecipe(a: CustomWidget, b: CustomWidget): boolean {
  const recipe = (widget: CustomWidget) => JSON.stringify({ ...parseCustomWidget(widget), id: "" });
  return recipe(a) === recipe(b);
}

// --- Evaluation ---------------------------------------------------------

export interface EvaluateWidgetOptions {
  /** The reader's time zone, e.g. `Europe/Berlin`: hours, weekdays and years are theirs. */
  readonly timeZone: string;
  /** For `this-year` and `last-year`; defaults to now. */
  readonly now?: number;
}

/** Long passages and notes are cut here; the book page has the rest. */
const EXCERPT = 280;

function excerpt(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= EXCERPT) return trimmed;
  const cut = trimmed.slice(0, EXCERPT);
  const space = cut.lastIndexOf(" ");
  return `${(space > EXCERPT * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

interface LocalTime {
  readonly year: number;
  /** 0–11 */
  readonly month: number;
  /** 0 = Monday */
  readonly weekday: number;
  readonly hour: number;
  readonly day: string;
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
/** Every time zone offset in use is a whole number of quarter hours. */
const QUARTER_HOUR = 15 * 60 * 1000;

function localClock(timeZone: string): (at: number) => LocalTime {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" });
  } catch {
    throw new Error("Time zone is invalid");
  }
  const cache = new Map<number, LocalTime>();
  return (at) => {
    const bucket = Math.floor(at / QUARTER_HOUR);
    const known = cache.get(bucket);
    if (known) return known;
    const parts = Object.fromEntries(format.formatToParts(new Date(bucket * QUARTER_HOUR)).map(({ type, value }) => [type, value]));
    const time: LocalTime = {
      year: Number(parts.year),
      month: Number(parts.month) - 1,
      weekday: WEEKDAY_INDEX[parts.weekday ?? ""] ?? 0,
      hour: Number(parts.hour) % 24,
      day: `${parts.year}-${parts.month}-${parts.day}`,
    };
    cache.set(bucket, time);
    return time;
  };
}

/** One thing being counted, with what the filters and grouping can ask of it. */
interface Subject {
  readonly book: WidgetDatasetBook | undefined;
  readonly at?: number;
  readonly timed?: boolean;
  readonly length?: number;
  readonly notes?: number;
  readonly tags?: readonly string[];
  readonly threads?: readonly string[];
  readonly item: () => WidgetItem;
}

function named(value: string | undefined): WidgetValue[] {
  const trimmed = value?.trim();
  return trimmed ? [{ key: normalizeOrganizationName(trimmed), label: trimmed }] : [];
}

function namedAll(values: readonly string[] | undefined): WidgetValue[] {
  const seen = new Map<string, WidgetValue>();
  for (const value of values ?? []) for (const entry of named(value)) if (!seen.has(entry.key)) seen.set(entry.key, entry);
  return [...seen.values()];
}

function lengthBand(length: number): WidgetValue {
  return LENGTHS.find(({ max }) => length <= max)!;
}

/** The values a subject has for a field: none when unknown, several for authors, tags and threads. */
function valuesOf(subject: Subject, field: WidgetField, clock: (at: number) => LocalTime): WidgetValue[] {
  const { book } = subject;
  switch (field) {
    case "length": return subject.length === undefined ? [] : [lengthBand(subject.length)];
    case "hour": return subject.at === undefined || !subject.timed ? [] : [HOURS[clock(subject.at).hour]!];
    case "weekday": return subject.at === undefined ? [] : [WEEKDAYS[clock(subject.at).weekday]!];
    case "month": return subject.at === undefined ? [] : [MONTHS[clock(subject.at).month]!];
    case "year": {
      if (subject.at === undefined) return [];
      const year = String(clock(subject.at).year);
      return [{ key: year, label: year }];
    }
    case "has-note": return subject.notes === undefined ? [] : [HAS_NOTE[subject.notes > 0 ? 0 : 1]!];
    case "tag": return namedAll(subject.tags);
    case "thread": return namedAll(subject.threads);
    case "book": return book ? [{ key: book.id, label: book.title }] : [];
    case "author": return namedAll(book?.authors);
    case "series": return named(book?.series);
    case "publisher": return named(book?.publisher);
    case "language": return named(book?.language);
    case "status": return book ? [STATUSES.find(({ key }) => key === book.status)!] : [];
    case "finished-year": {
      if (book?.status !== "finished" || book.finishedYear === undefined) return [];
      const year = String(book.finishedYear);
      return [{ key: year, label: year }];
    }
  }
}

/** What a filter value matches, in the form `valuesOf` gives keys. */
function filterKey(field: WidgetField, value: string, thisYear: number): string {
  const info = WIDGET_FIELD_INFO[field];
  if (info.year) {
    if (value === "this-year") return String(thisYear);
    if (value === "last-year") return String(thisYear - 1);
    return value;
  }
  if (info.values) return value;
  // A book is grouped by its ID, but a shared filter names it by title.
  return normalizeOrganizationName(value);
}

function subjects(dataset: WidgetDataset, count: WidgetCount, clock: (at: number) => LocalTime): Subject[] {
  const books = new Map(dataset.books.map((book) => [book.id, book]));
  switch (count) {
    case "books":
      return dataset.books.filter(({ archived }) => !archived).map((book) => ({
        book,
        item: () => ({ kind: "book", bookId: book.id, title: book.title, authors: book.authors, status: book.status }),
      }));
    case "passages":
      return dataset.passages.map((passage) => {
        const book = books.get(passage.bookId);
        return {
          book,
          at: passage.at,
          timed: passage.timed,
          length: passage.text.length,
          notes: passage.notes,
          tags: passage.tags,
          threads: passage.threads,
          item: () => ({ kind: "passage", bookId: passage.bookId, highlightId: passage.id, title: book?.title ?? "", text: excerpt(passage.text), day: clock(passage.at).day }),
        };
      });
    case "notes":
      return dataset.notes.map((note) => {
        const book = books.get(note.bookId);
        return {
          book,
          at: note.at,
          timed: note.timed,
          length: note.text.length,
          item: () => ({ kind: "note", bookId: note.bookId, ...(note.highlightId ? { highlightId: note.highlightId } : {}), title: book?.title ?? "", text: excerpt(note.text), day: clock(note.at).day }),
        };
      });
  }
}

function matches(subject: Subject, filter: WidgetFilter, clock: (at: number) => LocalTime, thisYear: number): boolean {
  const target = "is" in filter ? filter.is : filter.isNot;
  const values = valuesOf(subject, filter.field, clock);
  // A book matches its title as well as its ID, so a shared filter can name it.
  const key = filterKey(filter.field, target, thisYear);
  const found = values.some((value) => value.key === key || (filter.field === "book" && normalizeOrganizationName(value.label) === key));
  return "is" in filter ? found : !found;
}

function naturalOrder(field: WidgetField): ((a: WidgetGroup, b: WidgetGroup) => number) {
  const info = WIDGET_FIELD_INFO[field];
  if (info.values) {
    const order = new Map(info.values.map(({ key }, index) => [key, index]));
    return (a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0);
  }
  if (info.year) return (a, b) => Number(a.key) - Number(b.key);
  return (a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }) || a.key.localeCompare(b.key);
}

function group(matched: readonly Subject[], widget: CustomWidget, clock: (at: number) => LocalTime): WidgetResult {
  const field = widget.groupBy!;
  const info = WIDGET_FIELD_INFO[field];
  const groups = new Map<string, { label: string; value: number }>();
  // Fixed sets show every value, so a chart of weekdays always has seven days.
  for (const { key, label } of info.values ?? []) groups.set(key, { label: field === "length" ? LENGTHS.find((band) => band.key === key)!.label : label, value: 0 });
  let missing = 0;
  for (const subject of matched) {
    const values = valuesOf(subject, field, clock);
    if (values.length === 0) missing += 1;
    for (const { key, label } of values) {
      const entry = groups.get(key) ?? { label, value: 0 };
      entry.value += 1;
      groups.set(key, entry);
    }
  }
  // Years run without gaps, so a quiet year shows as a quiet year.
  if (info.year && groups.size > 0) {
    const years = [...groups.keys()].map(Number);
    for (let year = Math.min(...years); year <= Math.max(...years); year += 1) if (!groups.has(String(year))) groups.set(String(year), { label: String(year), value: 0 });
  }
  const defaults = widgetDefaults(widget);
  const sort = widget.sort ?? defaults.sort;
  const limit = widget.limit ?? defaults.limit;
  const natural = naturalOrder(field);
  const all = [...groups].map(([key, { label, value }]) => ({ key, label, value }));
  all.sort(sort === "count" ? (a, b) => b.value - a.value || natural(a, b) : natural);
  // In their own order, the latest years are the ones worth keeping.
  const shown = sort === "label" && info.year ? all.slice(-limit) : all.slice(0, limit);
  return { kind: "groups", groups: shown, total: matched.length, missing, hidden: all.length - shown.length };
}

/**
 * Count a widget's recipe over a library. The same dataset and recipe give
 * the same result anywhere, given the reader's time zone.
 */
export function evaluateWidget(dataset: WidgetDataset, widget: CustomWidget, options: EvaluateWidgetOptions): WidgetResult {
  const clock = localClock(options.timeZone);
  const thisYear = clock(options.now ?? Date.now()).year;
  const matched = subjects(dataset, widget.count, clock)
    .filter((subject) => (widget.where ?? []).every((filter) => matches(subject, filter, clock, thisYear)));

  switch (widget.show) {
    case "number":
      return { kind: "number", value: matched.length };
    case "heatmap": {
      const days = new Map<string, number>();
      for (const { at } of matched) {
        if (at === undefined) continue;
        const { day } = clock(at);
        days.set(day, (days.get(day) ?? 0) + 1);
      }
      return { kind: "days", days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, value]) => ({ day, value })), total: matched.length };
    }
    case "list": {
      const limit = widget.limit ?? widgetDefaults(widget).limit;
      const ordered = widget.count === "books"
        ? [...matched].sort((a, b) => (a.book?.title ?? "").localeCompare(b.book?.title ?? "", undefined, { sensitivity: "base" }))
        : [...matched].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
      return { kind: "items", items: ordered.slice(0, limit).map(({ item }) => item()), total: matched.length };
    }
    case "bars":
    case "ranked":
      return group(matched, widget, clock);
  }
}
