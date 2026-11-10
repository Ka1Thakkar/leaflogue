import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findConnectedReaders, mountRoots, watchConnectedReaders } from "./connected-readers";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "leaflogue-mounts-")); });
afterEach(() => { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });

function volume(name: string, parts: readonly string[]): string {
  const path = join(root, name, ...parts);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x");
  return path;
}

describe("connected readers", () => {
  it("finds a Kobo and a Kindle by their own files and hides their paths behind IDs", () => {
    const kobo = volume("KOBOeReader", [".kobo", "KoboReader.sqlite"]);
    volume("Kindle", ["documents", "My Clippings.txt"]);
    mkdirSync(join(root, "USB stick"));
    const readers = findConnectedReaders([root]);
    expect(readers.map(({ kind, label }) => ({ kind, label }))).toEqual([
      { kind: "kindle", label: "Kindle" },
      { kind: "kobo", label: "KOBOeReader" },
    ]);
    expect(readers.find(({ kind }) => kind === "kobo")?.path).toBe(kobo);
    expect(readers.every(({ id }) => /^[0-9a-f]{32}$/u.test(id))).toBe(true);
  });

  it("finds PocketBook, Tolino, and KOReader, and only offers a notes.txt that reads like Tolino's", () => {
    volume("PB740", ["system", "config", "books.db"]);
    const tolino = volume("tolino", ["notes.txt"]);
    writeFileSync(tolino, "The Glass Orchard (Imogen Vale)\nHighlight on page 12: \"Every pane held a season.\"\nAdded on 13.11.2021 | 18:26\n\n-----------------------------------\n");
    volume("USB stick", ["notes.txt"]);
    mkdirSync(join(root, "KOBOeReader", ".adds", "koreader"), { recursive: true });
    const readers = findConnectedReaders([root]);
    expect(readers.map(({ kind, label }) => ({ kind, label }))).toEqual([
      { kind: "koreader", label: "KOBOeReader" },
      { kind: "pocketbook", label: "PB740" },
      { kind: "tolino", label: "tolino" },
    ]);
    expect(readers.find(({ kind }) => kind === "koreader")?.path).toBe(join(root, "KOBOeReader"));
  });

  it("looks inside MTP devices' storage areas for a Boox notes folder and a newer Kindle", () => {
    volume("mtp:host=Onyx_Note_Air3_C_A1B2C3D4", ["Internal shared storage", "note", "The Glass Orchard.txt"]);
    mkdirSync(join(root, "mtp:host=Onyx_Note_Air3_C_A1B2C3D4", "Internal shared storage", "Notes"), { recursive: true });
    volume("mtp:host=Amazon_Kindle_Colorsoft", ["Internal Storage", "documents", "My Clippings.txt"]);
    mkdirSync(join(root, "mtp:host=Android_Phone", "Internal shared storage", "note"), { recursive: true });
    const readers = findConnectedReaders([root]);
    expect(readers.map(({ kind, label }) => ({ kind, label }))).toEqual([
      { kind: "kindle", label: "Amazon Kindle Colorsoft" },
      { kind: "boox", label: "Onyx Note Air3 C" },
    ]);
    expect(readers.find(({ kind }) => kind === "boox")?.path).toBe(join(root, "mtp:host=Onyx_Note_Air3_C_A1B2C3D4", "Internal shared storage", "note"));
  });

  it("ignores links, directories named like the file, hidden volumes, and missing roots", () => {
    const real = volume("elsewhere", ["KoboReader.sqlite"]);
    mkdirSync(join(root, "Linked", ".kobo"), { recursive: true });
    symlinkSync(real, join(root, "Linked", ".kobo", "KoboReader.sqlite"));
    mkdirSync(join(root, "Odd", ".kobo", "KoboReader.sqlite"), { recursive: true });
    volume(".hidden", [".kobo", "KoboReader.sqlite"]);
    expect(findConnectedReaders([root, join(root, "does-not-exist")])).toEqual([]);
  });

  it("knows where each platform mounts removable drives", () => {
    expect(mountRoots("darwin", "reader")).toEqual(["/Volumes"]);
    expect(mountRoots("linux", "reader")).toEqual(["/run/media/reader", "/media/reader", "/media", "/mnt"]);
    expect(mountRoots("linux", "reader", 1000)).toEqual(["/run/media/reader", "/media/reader", "/media", "/mnt", "/run/user/1000/gvfs"]);
    expect(mountRoots("win32", "reader")).toEqual([]);
  });

  it("reports when a reader is plugged in and unplugged", () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const watch = watchConnectedReaders({ roots: [root], onChange, intervalMs: 1_000 });
    expect(watch.current()).toEqual([]);
    volume("KOBOeReader", [".kobo", "KoboReader.sqlite"]);
    vi.advanceTimersByTime(1_000);
    expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ kind: "kobo", label: "KOBOeReader" })]);
    vi.advanceTimersByTime(3_000);
    expect(onChange).toHaveBeenCalledTimes(1);
    rmSync(join(root, "KOBOeReader"), { recursive: true });
    vi.advanceTimersByTime(1_000);
    expect(onChange).toHaveBeenLastCalledWith([]);
    watch.stop();
  });
});
