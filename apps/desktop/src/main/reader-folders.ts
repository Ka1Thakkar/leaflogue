import { closeSync, constants, fstatSync, lstatSync, opendirSync, openSync, readSync, type Dir, type Dirent } from "node:fs";
import { join, relative } from "node:path";
import type { KOReaderSidecar } from "@leaflogue/importers";

/**
 * Folders of reader highlights: KOReader's per-book sidecars, and the
 * per-book text files Boox's NeoReader exports.
 *
 * Collect KOReader sidecars (`<book>.sdr/metadata.<ext>.lua`) under a folder
 * the reader chose, or under a plugged-in device. The walk is bounded: it never
 * follows symbolic links, stops at a fixed depth and entry count, reads only
 * regular files through a checked descriptor, and caps every file and the
 * total. KOReader's own `docsettings` and `hashdocsettings` folders hold the
 * same `.sdr` folders, so one rule finds all three locations.
 */

export const KOREADER_LIMITS: Readonly<Record<"depth" | "entries" | "sidecars" | "fileBytes" | "totalBytes", number>> = Object.freeze({
  depth: 12,
  entries: 200_000,
  sidecars: 5_000,
  fileBytes: 8 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
});

const SIDECAR_NAME = /^metadata\.[A-Za-z0-9]{1,12}\.lua$/u;
/** Hidden folders are skipped except where KOReader lives on a Kobo. */
const HIDDEN_ALLOWED = new Set([".adds"]);

/** Open without following a link and without blocking on a slow or special file. */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** A folder's entries, counted as they are read, so a huge folder is refused before it is loaded. */
function entriesOf(folder: string, budget: { remaining: number }): Dirent[] {
  let directory: Dir;
  try {
    directory = opendirSync(folder);
  } catch {
    return [];
  }
  const entries: Dirent[] = [];
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      if (--budget.remaining < 0) throw new Error("That folder has too many files to search");
      entries.push(entry);
    }
  } finally {
    directory.closeSync();
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export function collectKOReaderSidecars(root: string, limits = KOREADER_LIMITS): KOReaderSidecar[] {
  const sidecars: KOReaderSidecar[] = [];
  const budget = { remaining: limits.entries };
  const bytes = { read: 0, limit: limits.totalBytes, message: "KOReader sidecar files exceed the 64 MiB limit" };
  const pending: { path: string; depth: number }[] = [{ path: root, depth: 0 }];
  while (pending.length) {
    const { path, depth } = pending.pop()!;
    for (const child of entriesOf(path, budget)) {
      const childPath = join(path, child.name);
      if (child.isDirectory()) {
        if (depth + 1 >= limits.depth) continue;
        if (child.name.startsWith(".") && !HIDDEN_ALLOWED.has(child.name)) continue;
        pending.push({ path: childPath, depth: depth + 1 });
      } else if (child.isFile() && SIDECAR_NAME.test(child.name) && /\.sdr$/iu.test(path)) {
        const source = readSmallTextFile(childPath, limits.fileBytes, bytes);
        if (source === undefined) continue;
        sidecars.push({ path: relative(root, childPath), source });
        if (sidecars.length > limits.sidecars) throw new Error("That folder has too many KOReader books");
      }
    }
  }
  return sidecars.sort((a, b) => a.path.localeCompare(b.path));
}

export const BOOX_LIMITS: Readonly<Record<"files" | "fileBytes" | "totalBytes", number>> = Object.freeze({
  files: 2_000,
  fileBytes: 16 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
});
const SNIFF_BYTES = 4 * 1024;

/**
 * The Boox exports directly inside a folder: `.txt` files whose first line is
 * NeoReader's "Reading Notes | <<Title>>" header. Only the first 4 KiB of each
 * text file is read to check; other text files are left alone. Every byte
 * read counts toward the total, and subfolders are not read.
 */
export function collectBooxExports(folder: string, isExport: (source: string) => boolean, limits = BOOX_LIMITS): string[] {
  const texts = entriesOf(folder, { remaining: limits.files * 10 }).filter((child) => child.isFile() && /\.txt$/iu.test(child.name));
  if (texts.length > limits.files) throw new Error("That folder has too many text files");
  const bytes = { read: 0, limit: limits.totalBytes, message: "Boox exports exceed the 64 MiB limit" };
  const exports: string[] = [];
  for (const child of texts) {
    const path = join(folder, child.name);
    const head = readSmallTextFile(path, limits.fileBytes, bytes, SNIFF_BYTES);
    if (head === undefined || !isExport(head)) continue;
    const source = readSmallTextFile(path, limits.fileBytes, bytes);
    if (source !== undefined) exports.push(source);
  }
  return exports;
}

/**
 * Read a regular UTF-8 file (or its first `prefix` bytes) through a no-follow,
 * non-blocking descriptor, counting the bytes against a shared budget.
 */
function readSmallTextFile(path: string, maximum: number, bytes: { read: number; limit: number; message: string }, prefix?: number): string | undefined {
  let descriptor: number | undefined;
  let buffer: Buffer;
  let length = 0;
  try {
    if (lstatSync(path).isSymbolicLink()) return undefined;
    descriptor = openSync(path, OPEN_FLAGS);
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > maximum) return undefined;
    buffer = Buffer.alloc(Math.min(info.size, prefix ?? info.size));
    while (length < buffer.length) {
      const read = readSync(descriptor, buffer, length, buffer.length - length, length);
      if (read === 0) break;
      length += read;
    }
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  bytes.read += length;
  if (bytes.read > bytes.limit) throw new Error(bytes.message);
  try {
    // A prefix may end inside a character; only a whole file must be valid UTF-8.
    return new TextDecoder("utf-8", { fatal: prefix === undefined }).decode(buffer.subarray(0, length));
  } catch {
    return undefined;
  }
}
