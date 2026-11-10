import type { ImportAnnotation, ImportBook, ImportWarning } from "@leaflogue/contracts";

/** Shared limits and helpers for the KOReader, PocketBook, Tolino, and Boox importers. */

export const MAX_TEXT_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_EXTRACTED_BYTES = 64 * 1024 * 1024;
export const MAX_ANNOTATIONS = 100_000;
export const MAX_ANNOTATION_TEXT = 200_000;
export const MAX_LOCATION = 1_000;

export function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Shorten an over-long field instead of rejecting the whole import. */
export function clip(value: string | undefined, max: number): string | undefined {
  return value === undefined || value.length <= max ? value : value.slice(0, max);
}

/** A time is kept only when it is after 1970 and at most a day ahead of now. */
export function plausibleTime(value: number | undefined, now = Date.now()): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value <= now + 86_400_000 ? value : undefined;
}

/** Parse "YYYY-MM-DD HH:MM[:SS]" as local time, refusing impossible dates. */
export function localDateTime(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return undefined;
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(hour, minute, second, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return undefined;
  return plausibleTime(date.getTime());
}

export function containsUnsupportedControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) return true;
  }
  return false;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Counts extracted bytes so a small file cannot expand into a huge import. */
export class ExtractionBudget {
  #bytes = 0;
  constructor(private readonly label: string) {}
  add(value: ImportBook | ImportAnnotation): void {
    this.#bytes += new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (this.#bytes > MAX_EXTRACTED_BYTES) throw new Error(`Extracted ${this.label} data exceeds the 64 MiB limit`);
  }
}

/** Split an author field on separators that never appear inside one name. */
export function splitAuthors(value: string | undefined, max: number, maxLength: number): string[] {
  return (value?.split(/\s*[;&]\s*|\r?\n/u) ?? [])
    .map((author) => author.trim())
    .filter(Boolean)
    .slice(0, max)
    .map((author) => clip(author, maxLength)!);
}

export function skippedWarning(count: number, label: string, plural = `${label}s`): ImportWarning[] {
  return count ? [{ code: "skipped-records", message: `Skipped ${count} ${count === 1 ? label : plural}.` }] : [];
}
