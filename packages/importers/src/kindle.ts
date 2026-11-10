import type { ImportAnnotation, ImportBook, ImportPreview, ImportWarning } from "@leaflogue/contracts";
import { assertUniqueImportIds, normalizeBookText } from "@leaflogue/domain";

const RECORD_SEPARATOR = /^={10}\s*$/m;
const MAX_CLIPPINGS_BYTES = 16 * 1024 * 1024;
const MAX_RECORDS = 50_000;
const MAX_TITLE_LENGTH = 1_000;
const MAX_METADATA_LENGTH = 2_000;
const MAX_BODY_LENGTH = 200_000;
const HIGHLIGHT_MARKERS = [
  /\bhighlight\b/iu,
  /\bmarkierung\b/iu,
  /\bsubrayado\b/iu,
  /\bsurlignement\b/iu,
  /\bevidenziazione\b/iu,
  /\bdestaque\b/iu,
  /\bmarkering\b/iu,
  /ハイライト/u,
  /(?:标注|標註|荧光标注|螢光標示)/u,
] as const;
const NOTE_MARKERS = [
  /\bnote\b/iu,
  /\bnotiz\b/iu,
  /\bnota\b/iu,
  /\bnotitie\b/iu,
  /メモ/u,
  /(?:笔记|筆記)/u,
] as const;
const LOCATION_PATTERN =
  /(?:\blocation\b|\bposition\b|\bposición\b|\bemplacement\b|\bposizione\b|\bposição\b|\blocatie\b|位置(?:\s*no\.?)?)\s*(?:#|n[º°.]?)?\s*(\d+)(?:\s*[-–—]\s*(\d+))?/iu;
const ENGLISH_DATE_PATTERN =
  /^(?:Added on\s+)?(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+)?(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(AM|PM)$/u;
const MONTH_INDEX = new Map([
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
].map((month, index) => [month, index] as const));

interface ParsedClipping {
  readonly kind: "highlight" | "note";
  readonly bookTitle: string;
  readonly body: string;
  readonly location?: { readonly start: number; readonly end: number };
  readonly identityLocation?: { readonly start: number; readonly end: number };
  readonly createdAt?: number;
}

export async function parseKindleClippings(source: string): Promise<ImportPreview> {
  if (new TextEncoder().encode(source).byteLength > MAX_CLIPPINGS_BYTES) {
    throw new Error("Kindle clippings file exceeds the 16 MiB limit");
  }
  if (containsUnsupportedControlCharacter(source)) {
    throw new Error("Kindle clippings file contains unsupported control characters");
  }

  const rawRecords = source.split(RECORD_SEPARATOR).map((record) => record.trim()).filter(Boolean);
  if (rawRecords.length > MAX_RECORDS) {
    throw new Error(`Kindle import exceeds ${MAX_RECORDS.toLocaleString("en-US")} records`);
  }

  const parsed: ParsedClipping[] = [];
  let skippedRecords = 0;
  for (const rawRecord of rawRecords) {
    const item = parseRecord(rawRecord);
    if (item) parsed.push(item);
    else skippedRecords += 1;
  }
  if (parsed.length === 0) throw new Error("No supported Kindle highlights or notes were found");

  const bookIdByTitle = new Map<string, string>();
  const books: ImportBook[] = [];
  for (const item of parsed) {
    const normalized = normalizeBookText(item.bookTitle);
    if (!normalized || bookIdByTitle.has(normalized)) continue;
    const id = `kindle-book:${await sha256Hex(normalized)}`;
    bookIdByTitle.set(normalized, id);
    books.push({ providerRecordId: id, title: item.bookTitle, authors: [] });
  }

  const annotations: ImportAnnotation[] = [];
  const warnings: ImportWarning[] = skippedRecords === 0
    ? []
    : [{
        code: "skipped-records",
        message: `${skippedRecords} unsupported or malformed Kindle ${skippedRecords === 1 ? "record was" : "records were"} skipped.`,
      }];
  const occurrence = new Map<string, number>();
  let ambiguousNotes = 0;
  let firstAmbiguousNoteId: string | undefined;
  for (const item of parsed) {
    const bookId = bookIdByTitle.get(normalizeBookText(item.bookTitle));
    if (!bookId) continue;
    const fingerprint = await sha256Hex(
      JSON.stringify([item.kind, normalizeBookText(item.bookTitle), item.identityLocation, item.body]),
    );
    const ordinal = (occurrence.get(fingerprint) ?? 0) + 1;
    occurrence.set(fingerprint, ordinal);
    const providerRecordId = `kindle:${fingerprint}:${ordinal}`;

    if (item.kind === "note") {
      const previous = annotations.at(-1);
      const previousParsed = parsedHighlightLocation(previous?.location);
      const canAttach =
        previous?.text !== undefined &&
        previous.note === undefined &&
        previous.bookProviderRecordId === bookId &&
        item.location !== undefined &&
        previousParsed !== undefined &&
        item.location.start >= previousParsed.start &&
        item.location.end <= previousParsed.end;

      if (canAttach && previous) {
        annotations[annotations.length - 1] = { ...previous, note: item.body };
      } else {
        annotations.push({
          providerRecordId,
          bookProviderRecordId: bookId,
          note: item.body,
          ...(item.location ? { location: displayLocation(item.location) } : {}),
          ...(item.createdAt !== undefined ? { createdAt: item.createdAt } : {}),
        });
        ambiguousNotes += 1;
        firstAmbiguousNoteId ??= providerRecordId;
      }
      continue;
    }

    annotations.push({
      providerRecordId,
      bookProviderRecordId: bookId,
      text: item.body,
      ...(item.location ? { location: displayLocation(item.location) } : {}),
      ...(item.createdAt !== undefined ? { createdAt: item.createdAt } : {}),
    });
  }
  if (ambiguousNotes > 0) {
    warnings.push({
      code: "ambiguous-note",
      message: `${ambiguousNotes} Kindle ${ambiguousNotes === 1 ? "note was" : "notes were"} kept separate because the matching highlights could not be identified safely.`,
      ...(firstAmbiguousNoteId ? { providerRecordId: firstAmbiguousNoteId } : {}),
    });
  }

  const document = { formatVersion: 1 as const, books, annotations };
  assertUniqueImportIds(document);
  return { document, warnings };
}

function containsUnsupportedControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) return true;
  }
  return false;
}

function parseRecord(raw: string): ParsedClipping | undefined {
  const lines = raw.split(/\r?\n/);
  const bookTitle = lines[0]?.replace(/^\uFEFF/u, "").trim();
  const metadata = lines[1]?.trim();
  const body = lines.slice(2).join("\n").trim();
  if (!bookTitle || !metadata || !body) return undefined;
  if (
    bookTitle.length > MAX_TITLE_LENGTH ||
    metadata.length > MAX_METADATA_LENGTH ||
    body.length > MAX_BODY_LENGTH
  ) return undefined;

  const kind = NOTE_MARKERS.some((pattern) => pattern.test(metadata))
    ? "note"
    : HIGHLIGHT_MARKERS.some((pattern) => pattern.test(metadata))
      ? "highlight"
      : undefined;
  if (!kind) return undefined;

  const locationMatch = metadata.match(LOCATION_PATTERN);
  const parsedStart = locationMatch?.[1] ? Number(locationMatch[1]) : undefined;
  const parsedEnd = locationMatch?.[2] ? Number(locationMatch[2]) : parsedStart;
  const hasSafeLocation =
    parsedStart !== undefined &&
    parsedEnd !== undefined &&
    Number.isSafeInteger(parsedStart) &&
    Number.isSafeInteger(parsedEnd) &&
    parsedStart >= 0 &&
    parsedEnd >= parsedStart;
  const dateText = metadata.includes("|") ? metadata.slice(metadata.lastIndexOf("|") + 1).trim() : "";
  const timestamp = parseEnglishKindleDate(dateText) ?? parseLocalizedKindleDate(dateText);

  return {
    kind,
    bookTitle,
    body,
    ...(hasSafeLocation ? { location: { start: parsedStart, end: parsedEnd } } : {}),
    ...legacyIdentityLocation(metadata),
    ...(timestamp !== undefined ? { createdAt: timestamp } : {}),
  };
}

function legacyIdentityLocation(metadata: string): Pick<ParsedClipping, "identityLocation"> {
  // This reproduces the original English/ASCII parser exactly. Keep it frozen so
  // safer display parsing cannot duplicate annotations imported by older builds.
  const match = metadata.match(/\bLocation\s+(\d+)(?:-(\d+))?/i);
  const start = match?.[1] ? Number(match[1]) : undefined;
  const end = match?.[2] ? Number(match[2]) : start;
  return start !== undefined && end !== undefined
    ? { identityLocation: { start, end } }
    : {};
}

function parseEnglishKindleDate(value: string): number | undefined {
  const match = value.match(ENGLISH_DATE_PATTERN);
  const month = match?.[1] ? MONTH_INDEX.get(match[1]) : undefined;
  const day = match?.[2] ? Number(match[2]) : undefined;
  const year = match?.[3] ? Number(match[3]) : undefined;
  const hour = match?.[4] ? Number(match[4]) : undefined;
  const minute = match?.[5] ? Number(match[5]) : undefined;
  const second = match?.[6] ? Number(match[6]) : undefined;
  const meridiem = match?.[7];
  if (
    month === undefined || day === undefined || year === undefined || hour === undefined ||
    minute === undefined || second === undefined || !meridiem || year < 1970 ||
    hour < 1 || hour > 12 || minute > 59 || second > 59
  ) return undefined;

  const hour24 = (hour % 12) + (meridiem === "PM" ? 12 : 0);
  const parsed = new Date(0);
  parsed.setFullYear(year, month, day);
  parsed.setHours(hour24, minute, second, 0);
  if (
    parsed.getFullYear() !== year || parsed.getMonth() !== month || parsed.getDate() !== day ||
    parsed.getHours() !== hour24 || parsed.getMinutes() !== minute || parsed.getSeconds() !== second
  ) return undefined;
  return parsed.getTime();
}

/**
 * Month names in the languages whose clipping markers are recognised above,
 * lowercased with accents removed. Short forms cover abbreviated devices.
 */
const LOCALIZED_MONTHS: ReadonlyMap<string, number> = new Map(([
  ["january", "jan"], ["february", "feb"], ["march", "mar"], ["april", "apr"], ["may"], ["june", "jun"],
  ["july", "jul"], ["august", "aug"], ["september", "sep", "sept"], ["october", "oct"], ["november", "nov"], ["december", "dec"],
  // Spanish
  ["enero"], ["febrero"], ["marzo"], ["abril"], ["mayo"], ["junio"], ["julio"], ["agosto"], ["septiembre", "setiembre"], ["octubre"], ["noviembre"], ["diciembre"],
  // German
  ["januar", "janner"], ["februar"], ["marz"], [], ["mai"], ["juni"], ["juli"], [], [], ["oktober", "okt"], [], ["dezember", "dez"],
  // French
  ["janvier"], ["fevrier"], ["mars"], ["avril"], [], ["juin"], ["juillet"], ["aout"], ["septembre"], ["octobre"], ["novembre"], ["decembre"],
  // Italian
  ["gennaio"], ["febbraio"], [], ["aprile"], ["maggio"], ["giugno"], ["luglio"], [], ["settembre"], ["ottobre"], [], ["dicembre"],
  // Portuguese
  ["janeiro"], ["fevereiro"], ["marco"], [], ["maio"], ["junho"], ["julho"], [], ["setembro"], ["outubro"], ["novembro"], ["dezembro"],
  // Dutch
  ["januari"], ["februari"], ["maart"], [], ["mei"], [], ["juli"], ["augustus"], [], [], [], [],
] as string[][]).flatMap((names, index) => names.map((name) => [name, index % 12] as const)));
const DAY_MONTH_YEAR = /(\d{1,2})\.?\s+(?:de\s+)?(\p{L}+)\.?,?\s+(?:de\s+)?(\d{4})/u;
const YEAR_MONTH_DAY = /(\d{4})\s*[年년]\s*(\d{1,2})\s*[月월]\s*(\d{1,2})\s*[日일]/u;
const CLOCK = /(上午|下午|午前|午後|오전|오후)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AP])\.?\s?M\.?)?/iu;

/**
 * Dates as non-English Kindles write them, for example
 * "Hinzugefügt am Samstag, 4. Mai 2024 19:42:00" or
 * "添加于 2024年5月6日星期一 下午3:15:00". Weekday names are ignored; anything
 * that does not resolve to one real local time is left undated.
 */
function parseLocalizedKindleDate(value: string): number | undefined {
  if (!value) return undefined;
  let year: number;
  let month: number | undefined;
  let day: number;
  let rest: string;
  const numeric = value.match(YEAR_MONTH_DAY);
  if (numeric?.[1] && numeric[2] && numeric[3]) {
    year = Number(numeric[1]);
    month = Number(numeric[2]) - 1;
    day = Number(numeric[3]);
    rest = value.slice((numeric.index ?? 0) + numeric[0].length);
  } else {
    const named = value.match(DAY_MONTH_YEAR);
    if (!named?.[1] || !named[2] || !named[3]) return undefined;
    day = Number(named[1]);
    month = LOCALIZED_MONTHS.get(named[2].normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("en"));
    year = Number(named[3]);
    rest = value.slice((named.index ?? 0) + named[0].length);
  }
  const clock = rest.match(CLOCK);
  if (month === undefined || month < 0 || month > 11 || !clock?.[2] || !clock[3]) return undefined;
  let hour = Number(clock[2]);
  const minute = Number(clock[3]);
  const second = clock[4] ? Number(clock[4]) : 0;
  const afternoon = clock[1] ? ["下午", "午後", "오후"].includes(clock[1]) : clock[5] ? clock[5].toUpperCase() === "P" : undefined;
  if (afternoon !== undefined) {
    if (hour < 1 || hour > 12) {
      // A 24-hour clock after a meridiem word (some Chinese builds) is taken as written.
      if (hour > 23) return undefined;
    } else {
      hour = (hour % 12) + (afternoon ? 12 : 0);
    }
  }
  return localTime(year, month, day, hour, minute, second);
}

function localTime(year: number, month: number, day: number, hour: number, minute: number, second: number): number | undefined {
  if (year < 1970 || hour > 23 || minute > 59 || second > 59) return undefined;
  const parsed = new Date(0);
  parsed.setFullYear(year, month, day);
  parsed.setHours(hour, minute, second, 0);
  if (
    parsed.getFullYear() !== year || parsed.getMonth() !== month || parsed.getDate() !== day ||
    parsed.getHours() !== hour || parsed.getMinutes() !== minute || parsed.getSeconds() !== second
  ) return undefined;
  return parsed.getTime();
}

function displayLocation(location: { readonly start: number; readonly end: number }): string {
  return location.start === location.end ? `${location.start}` : `${location.start}-${location.end}`;
}

function parsedHighlightLocation(value: string | undefined): { start: number; end: number } | undefined {
  const match = value?.match(/^(\d+)(?:-(\d+))?$/);
  if (!match?.[1]) return undefined;
  return { start: Number(match[1]), end: Number(match[2] ?? match[1]) };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
