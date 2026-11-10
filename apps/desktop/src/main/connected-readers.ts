import { createHash } from "node:crypto";
import { closeSync, constants, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { basename, join } from "node:path";
import type { ConnectedReader } from "@leaflogue/contracts";
import { looksLikeTolinoNotes } from "@leaflogue/importers";

/**
 * Notices an e-reader mounted as a USB drive (roadmap: reader features),
 * so the import dialog can offer it without a file picker. It only lists the
 * usual mount folders one level deep and checks for the reader's own file;
 * it never writes to the device. The renderer sees an opaque ID and the
 * volume's name, never the path.
 */

export interface DetectedReader extends ConnectedReader {
  /** The annotations file on the device, or the drive for KOReader. Kept in the main process. */
  readonly path: string;
}

const MAX_VOLUMES = 32;
const READER_FILES: readonly { readonly kind: ConnectedReader["kind"]; readonly parts: readonly string[] }[] = [
  { kind: "kobo", parts: [".kobo", "KoboReader.sqlite"] },
  { kind: "kindle", parts: ["documents", "My Clippings.txt"] },
  { kind: "pocketbook", parts: ["system", "config", "books.db"] },
  { kind: "pocketbook", parts: ["system", "profiles", "default", "config", "books.db"] },
  { kind: "tolino", parts: ["notes.txt"] },
];
/** Folders where NeoReader on a Boox saves exported highlights. */
const BOOX_FOLDERS: readonly (readonly string[])[] = [["note"], ["Note"], ["Notes"]];
/** Where KOReader installs itself on Kobo, Kindle, and PocketBook. */
const KOREADER_FOLDERS: readonly (readonly string[])[] = [[".adds", "koreader"], ["koreader"], ["applications", "koreader"]];

/**
 * Folders where the desktop mounts removable drives. On Linux this includes
 * GVFS, which mounts MTP devices (Boox, newer Kindles) at
 * `/run/user/<uid>/gvfs/mtp:host=…`, one folder per storage area inside.
 */
export function mountRoots(platform: NodeJS.Platform, user: string | undefined, uid?: number): string[] {
  if (platform === "darwin") return ["/Volumes"];
  if (platform !== "linux") return [];
  return [
    ...(user ? [join("/run/media", user), join("/media", user)] : []),
    "/media",
    "/mnt",
    ...(uid !== undefined ? [join("/run/user", String(uid), "gvfs")] : []),
  ];
}

/** "mtp:host=Onyx_Note_Air3_C_123" → "Onyx Note Air3 C"; other names are kept. */
function volumeLabel(volume: string): string {
  const name = basename(volume);
  const host = /^mtp:host=(.+)$/u.exec(name)?.[1];
  if (!host) return name;
  return decodeURIComponent(host.replace(/%(?![0-9A-Fa-f]{2})/gu, "%25")).replace(/_[0-9A-Fa-f]{6,}$/u, "").replace(/_/gu, " ").trim() || name;
}

/**
 * Where to look on one mount: the mount itself, and for an MTP device each
 * storage area inside it ("Internal shared storage", "Internal Storage").
 */
function readerRoots(volume: string): string[] {
  if (!basename(volume).startsWith("mtp:")) return [volume];
  return volumes(volume).slice(0, 4);
}

function isRegularFile(path: string): boolean {
  try {
    const info = lstatSync(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    const info = lstatSync(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

/** A notes.txt is only offered when its start reads like Tolino's, so any USB stick with one is not. */
function looksLikeTolinoFile(path: string): boolean {
  let descriptor: number | undefined;
  try {
    // No-follow and non-blocking: an MTP or FUSE mount could otherwise hang the poll.
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const buffer = Buffer.alloc(64 * 1024);
    const read = readSync(descriptor, buffer, 0, buffer.length, 0);
    return looksLikeTolinoNotes(buffer.subarray(0, read).toString("utf8"));
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function hasTextFile(folder: string): boolean {
  try {
    return readdirSync(folder, { withFileTypes: true }).some((entry) => entry.isFile() && /\.txt$/iu.test(entry.name));
  } catch {
    return false;
  }
}

function volumes(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .slice(0, MAX_VOLUMES)
      .map((entry) => join(root, entry.name));
  } catch {
    return [];
  }
}

export function findConnectedReaders(roots: readonly string[]): DetectedReader[] {
  const found = new Map<string, DetectedReader>();
  for (const volume of roots.flatMap(volumes)) {
    const label = volumeLabel(volume);
    for (const root of readerRoots(volume)) {
      for (const { kind, parts } of READER_FILES) {
        const path = join(root, ...parts);
        if (!isRegularFile(path) || found.has(path)) continue;
        if (kind === "tolino" && !looksLikeTolinoFile(path)) continue;
        const id = createHash("sha256").update(path).digest("hex").slice(0, 32);
        found.set(path, { id, kind, label, path });
      }
      // KOReader keeps highlights beside each book, so the whole drive is read.
      if (KOREADER_FOLDERS.some((parts) => isDirectory(join(root, ...parts))) && !found.has(root)) {
        const id = createHash("sha256").update(`koreader:${root}`).digest("hex").slice(0, 32);
        found.set(root, { id, kind: "koreader", label, path: root });
      }
      // A Boox shows up over MTP; its notes folder holds NeoReader's exports.
      const notes = BOOX_FOLDERS.map((parts) => join(root, ...parts)).find((path) => isDirectory(path) && hasTextFile(path));
      if (notes && !found.has(notes)) {
        const id = createHash("sha256").update(`boox:${notes}`).digest("hex").slice(0, 32);
        found.set(notes, { id, kind: "boox", label, path: notes });
      }
    }
  }
  return [...found.values()].sort((a, b) => a.label.localeCompare(b.label) || a.kind.localeCompare(b.kind));
}

/**
 * Check every few seconds and report when the set of connected readers
 * changes. Returns a function that stops watching.
 */
export function watchConnectedReaders(options: {
  readonly roots: readonly string[];
  readonly onChange: (readers: readonly DetectedReader[]) => void;
  readonly intervalMs?: number;
}): { current(): readonly DetectedReader[]; stop(): void } {
  let current = findConnectedReaders(options.roots);
  let signature = current.map(({ id }) => id).join(",");
  const timer = setInterval(() => {
    const next = findConnectedReaders(options.roots);
    const nextSignature = next.map(({ id }) => id).join(",");
    if (nextSignature === signature) return;
    current = next;
    signature = nextSignature;
    options.onChange(next);
  }, options.intervalMs ?? 4_000);
  timer.unref();
  return { current: () => current, stop: () => clearInterval(timer) };
}
