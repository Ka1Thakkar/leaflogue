import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalLibrary } from "@leaflogue/storage";
import { describe, expect, it } from "vitest";
import { migrateDesktopLibrary, prepareDesktopDirectories, resolveDesktopPaths, type DesktopPaths } from "./desktop-paths";

describe("desktop filesystem layout", () => {
  it("uses absolute XDG roots and ignores invalid relative overrides", () => {
    const value = resolveDesktopPaths({
      platform: "linux",
      homeDirectory: "/home/reader",
      legacyUserDataDirectory: "/home/reader/.config/@leaflogue/desktop",
      environment: {
        XDG_CONFIG_HOME: "/mnt/config",
        XDG_DATA_HOME: "relative-data",
        XDG_CACHE_HOME: "/mnt/cache",
        XDG_STATE_HOME: "/mnt/state",
      },
    });
    expect(value).toMatchObject({
      defaultConfigFile: "/mnt/config/leaflogue/config.json",
      libraryFile: "/home/reader/.local/share/leaflogue/library.sqlite",
      cacheDirectory: "/mnt/cache/leaflogue",
      logsDirectory: "/mnt/state/leaflogue/logs",
    });
  });

  it("snapshots committed WAL data and preserves the device identity without deleting legacy data", async () => {
    const fixture = desktopFixture();
    try {
      const legacyPath = join(fixture.paths.legacyUserDataDirectory, "library.sqlite");
      const legacy = new LocalLibrary(legacyPath);
      const created = legacy.createBook({ title: "The Left Hand of Darkness" });
      const pending = legacy.listPendingSyncChanges();
      const identity = readFileSync(`${legacyPath}.device-id`, "utf8");
      expect(existsSync(`${legacyPath}-wal`)).toBe(true);

      expect(await migrateDesktopLibrary(fixture.paths)).toEqual([
        "library.sqlite.device-id",
        "library.sqlite",
      ]);

      const migrated = new LocalLibrary(fixture.paths.libraryFile);
      expect(migrated.listBooks()).toEqual([created]);
      expect(migrated.listPendingSyncChanges()).toEqual(pending);
      expect(readFileSync(`${fixture.paths.libraryFile}.device-id`, "utf8")).toBe(identity);
      migrated.close();
      expect(existsSync(legacyPath)).toBe(true);
      expect(statSync(fixture.paths.libraryFile).mode & 0o777).toBe(0o600);
      expect(await migrateDesktopLibrary(fixture.paths)).toEqual([]);
      legacy.close();
    } finally {
      fixture.cleanup();
    }
  });

  it("allows concurrent migration attempts to publish only one complete snapshot", async () => {
    const fixture = desktopFixture();
    try {
      const legacyPath = join(fixture.paths.legacyUserDataDirectory, "library.sqlite");
      const legacy = new LocalLibrary(legacyPath);
      const created = legacy.createBook({ title: "The Dispossessed" });

      await Promise.all([
        migrateDesktopLibrary(fixture.paths),
        migrateDesktopLibrary(fixture.paths),
      ]);

      const migrated = new LocalLibrary(fixture.paths.libraryFile);
      expect(migrated.listBooks()).toEqual([created]);
      expect(readFileSync(`${fixture.paths.libraryFile}.device-id`, "utf8"))
        .toBe(readFileSync(`${legacyPath}.device-id`, "utf8"));
      migrated.close();
      legacy.close();
    } finally {
      fixture.cleanup();
    }
  });

  it("resumes safely when identity publication completed before database publication", async () => {
    const fixture = desktopFixture();
    try {
      const legacyPath = join(fixture.paths.legacyUserDataDirectory, "library.sqlite");
      const legacy = new LocalLibrary(legacyPath);
      const created = legacy.createBook({ title: "Piranesi" });
      legacy.close();
      writeFileSync(
        `${fixture.paths.libraryFile}.device-id`,
        readFileSync(`${legacyPath}.device-id`),
        { mode: 0o600 },
      );

      expect(await migrateDesktopLibrary(fixture.paths)).toEqual(["library.sqlite"]);
      const migrated = new LocalLibrary(fixture.paths.libraryFile);
      expect(migrated.listBooks()).toEqual([created]);
      migrated.close();
    } finally {
      fixture.cleanup();
    }
  });

  it("migrates the last activated library after an interrupted legacy restore", async () => {
    const fixture = desktopFixture();
    try {
      const legacyPath = join(fixture.paths.legacyUserDataDirectory, "library.sqlite");
      const legacy = new LocalLibrary(legacyPath);
      const created = legacy.createBook({ title: "Kindred" });
      legacy.close();
      renameSync(legacyPath, `${legacyPath}.previous`);
      writeFileSync(legacyPath, "unverified replacement", { mode: 0o600 });
      writeFileSync(`${legacyPath}.restore-state.json`, JSON.stringify({ version: 1, hadOriginal: true }), { mode: 0o600 });

      await migrateDesktopLibrary(fixture.paths);

      const migrated = new LocalLibrary(fixture.paths.libraryFile);
      expect(migrated.listBooks()).toEqual([created]);
      migrated.close();
    } finally {
      fixture.cleanup();
    }
  });

  it("ignores unrecognized and unsafe legacy files", async () => {
    const fixture = desktopFixture();
    try {
      const legacyConfig = join(fixture.paths.legacyUserDataDirectory, "config.json");
      writeFileSync(legacyConfig, "legacy config", { mode: 0o600 });
      symlinkSync(legacyConfig, join(fixture.paths.legacyUserDataDirectory, "library.sqlite"));
      writeFileSync(join(fixture.paths.legacyUserDataDirectory, "Cookies"), "browser state", { mode: 0o600 });

      expect(await migrateDesktopLibrary(fixture.paths)).toEqual([]);
      expect(existsSync(fixture.paths.defaultConfigFile)).toBe(false);
      expect(existsSync(fixture.paths.libraryFile)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });
});

function desktopFixture(): { readonly root: string; readonly paths: DesktopPaths; readonly cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "leaflogue-paths-"));
  const legacy = join(root, "legacy");
  const paths = resolveDesktopPaths({
    platform: "linux",
    homeDirectory: join(root, "home"),
    legacyUserDataDirectory: legacy,
    environment: {
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_STATE_HOME: join(root, "state"),
    },
  });
  prepareDesktopDirectories(paths);
  mkdirSync(legacy, { mode: 0o700 });
  return { root, paths, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
