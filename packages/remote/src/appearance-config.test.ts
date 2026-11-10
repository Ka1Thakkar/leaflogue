import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILT_IN_THEMES, exportableThemeManifest, parseThemeManifest, themeContrastProblems } from "@leaflogue/appearance";
import { canonicalConfigPath, importThemeFile, loadAppearanceConfig, resolveAppearanceFiles, writeAppearanceConfig, writeThemeExport } from "./config";

describe("desktop appearance configuration", () => {
  it("defaults safely and reports invalid config without activating it", () => {
    expect(loadAppearanceConfig({ defaultConfigPath: "/does/not/exist", environment: {}, platform: "linux" }))
      .toMatchObject({ themeId: "leaflogue", mode: "system" });
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-appearance-invalid-"));
    const path = join(directory, "config.json");
    try {
      writeFileSync(path, JSON.stringify({ version: 1, appearance: { themeId: "removed", mode: "dark" } }), { mode: 0o600 });
      expect(loadAppearanceConfig({ defaultConfigPath: path, environment: {}, platform: "linux" }))
        .toMatchObject({ themeId: "leaflogue", mode: "system", problem: "Theme is unavailable" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("atomically persists only validated appearance settings", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-appearance-write-"));
    const path = join(directory, "config.json");
    try {
      const sync = { provider: "convex", deploymentUrl: "https://quiet-otter-123.convex.cloud" };
      writeFileSync(path, JSON.stringify({ version: 1, sync }), { mode: 0o600 });
      expect(writeAppearanceConfig(path, { themeId: "rose-pine", mode: "dark" }))
        .toMatchObject({ themeId: "rose-pine", mode: "dark" });
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ version: 1, sync, appearance: { themeId: "rose-pine", mode: "dark" } });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(() => writeAppearanceConfig(path, { themeId: "unknown", mode: "dark" })).toThrow(/unavailable/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("loads and preserves an explicitly referenced custom theme", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-appearance-custom-"));
    const path = join(directory, "config.json");
    const themePath = join(directory, "quiet-library.json");
    try {
      writeFileSync(themePath, JSON.stringify(customManifest()), { mode: 0o600 });
      writeFileSync(path, JSON.stringify({
        version: 1,
        sync: { provider: "convex", deploymentUrl: "https://quiet-otter-123.convex.cloud" },
        appearance: { themeId: "quiet-library", mode: "dark", themeFile: "quiet-library.json" },
      }), { mode: 0o600 });

      expect(loadAppearanceConfig({ defaultConfigPath: path, environment: {}, platform: "linux" }))
        .toMatchObject({ themeId: "quiet-library", mode: "dark", themes: expect.arrayContaining([expect.objectContaining({ id: "quiet-library" })]) });
      expect(resolveAppearanceFiles({ defaultConfigPath: path, environment: {}, platform: "linux" }))
        .toEqual({ configPath: join(realpathSync(directory), "config.json"), themesDirectory: join(realpathSync(directory), "themes"), themePath: join(realpathSync(directory), "quiet-library.json") });
      expect(writeAppearanceConfig(path, { themeId: "quiet-library", mode: "light" }))
        .toMatchObject({ themeId: "quiet-library", mode: "light" });
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
        sync: { provider: "convex" },
        appearance: { themeId: "quiet-library", mode: "light", themeFile: "quiet-library.json" },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps a valid built-in selection and can recover from a broken custom reference", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-appearance-recovery-"));
    const path = join(directory, "config.json");
    try {
      writeFileSync(path, JSON.stringify({
        version: 1,
        appearance: { themeId: "nord", mode: "dark", themeFile: "missing.json" },
      }), { mode: 0o600 });
      expect(loadAppearanceConfig({ defaultConfigPath: path, environment: {}, platform: "linux" }))
        .toMatchObject({ themeId: "nord", mode: "dark", problem: expect.stringMatching(/inspect the custom theme/) });

      expect(writeAppearanceConfig(path, { themeId: "rose-pine", mode: "light" }))
        .toMatchObject({ themeId: "rose-pine", mode: "light" });
      const saved = JSON.parse(readFileSync(path, "utf8")) as { appearance: unknown };
      expect(saved.appearance).toEqual({ themeId: "rose-pine", mode: "light" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails safe when a custom theme is insecure, linked, oversized, or invalid", () => {
    const cases: [string, (directory: string, themePath: string) => void, RegExp][] = [
      ["permissive", (_directory, themePath) => {
        writeFileSync(themePath, JSON.stringify(customManifest()), { mode: 0o600 });
        chmodSync(themePath, 0o644);
      }, /permissions must be 0600/],
      ["owner-executable", (_directory, themePath) => {
        writeFileSync(themePath, JSON.stringify(customManifest()), { mode: 0o600 });
        chmodSync(themePath, 0o700);
      }, /permissions must be 0600/],
      ["symlink", (directory, themePath) => {
        const target = join(directory, "target.json");
        writeFileSync(target, JSON.stringify(customManifest()), { mode: 0o600 });
        symlinkSync(target, themePath);
      }, /must not use symbolic links/],
      ["oversized", (_directory, themePath) => {
        writeFileSync(themePath, "x".repeat(32 * 1024 + 1), { mode: 0o600 });
      }, /smaller than 32 KiB/],
      ["directory", (_directory, themePath) => {
        mkdirSync(themePath, { mode: 0o700 });
      }, /regular file/],
      ["invalid-json", (_directory, themePath) => {
        writeFileSync(themePath, "{", { mode: 0o600 });
      }, /not valid JSON/],
    ];

    for (const [name, prepare, problem] of cases) {
      const directory = mkdtempSync(join(tmpdir(), `leaflogue-theme-${name}-`));
      const path = join(directory, "config.json");
      const themePath = join(directory, "theme.json");
      try {
        prepare(directory, themePath);
        writeFileSync(path, JSON.stringify({
          version: 1,
          appearance: { themeId: "quiet-library", mode: "dark", themeFile: "theme.json" },
        }), { mode: 0o600 });
        expect(loadAppearanceConfig({ defaultConfigPath: path, environment: {}, platform: "linux" }))
          .toMatchObject({ themeId: "leaflogue", mode: "system", problem: expect.stringMatching(problem) });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it("applies and preserves config-only overrides, reporting invalid ones without losing the selection", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-appearance-overrides-"));
    const path = join(directory, "config.json");
    try {
      const overrides = { nord: { dark: { pen: "#8fbcbb" } } };
      writeFileSync(path, JSON.stringify({ version: 1, appearance: { themeId: "nord", mode: "dark", overrides } }), { mode: 0o600 });
      const loaded = loadAppearanceConfig({ defaultConfigPath: path, environment: {}, platform: "linux" });
      expect(loaded).toMatchObject({ themeId: "nord", mode: "dark" });
      expect(loaded.problem).toBeUndefined();
      expect(loaded.themes.find(({ id }) => id === "nord")?.dark.pen).toBe("#8fbcbb");

      expect(writeAppearanceConfig(path, { themeId: "nord", mode: "light" }).themes.find(({ id }) => id === "nord")?.dark.pen).toBe("#8fbcbb");
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ appearance: { themeId: "nord", mode: "light", overrides } });

      const unreadable = { nord: { dark: { ink: "#3b4252" } } };
      writeFileSync(path, JSON.stringify({ version: 1, appearance: { themeId: "nord", mode: "dark", overrides: unreadable } }), { mode: 0o600 });
      const rejected = loadAppearanceConfig({ defaultConfigPath: path, environment: {}, platform: "linux" });
      expect(rejected).toMatchObject({ themeId: "nord", mode: "dark", problem: expect.stringMatching(/Theme overrides were not applied: .*contrast is too low/) });
      expect(rejected.themes.find(({ id }) => id === "nord")?.dark).toEqual(BUILT_IN_THEMES.find(({ id }) => id === "nord")?.dark);
      expect(writeAppearanceConfig(path, { themeId: "rose-pine", mode: "dark" }).problem).toMatch(/not applied/);
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ appearance: { themeId: "rose-pine", overrides: unreadable } });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("exports a theme and imports it into protected storage as the selected theme", () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "leaflogue-theme-portable-")));
    const path = join(directory, "config", "config.json");
    const exported = join(directory, "shared", "nord-custom.json");
    try {
      mkdirSync(join(directory, "config"), { mode: 0o700 });
      mkdirSync(join(directory, "shared"), { mode: 0o700 });
      const overrides = { nord: { dark: { pen: "#8fbcbb" } } };
      writeFileSync(path, JSON.stringify({ version: 1, sync: { provider: "convex", deploymentUrl: "https://quiet-otter-123.convex.cloud" }, appearance: { themeId: "nord", mode: "dark", overrides } }), { mode: 0o600 });
      const nord = loadAppearanceConfig({ defaultConfigPath: path, environment: {}, platform: "linux" }).themes.find(({ id }) => id === "nord")!;
      writeThemeExport(exported, exportableThemeManifest(nord));
      expect(statSync(exported).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(exported, "utf8"))).toMatchObject({ version: 1, id: "nord-custom", dark: { pen: "#8fbcbb" } });

      // The chosen source need not be protected: it is copied, never referenced.
      chmodSync(exported, 0o644);
      const imported = importThemeFile(path, exported, "linux");
      expect(imported).toMatchObject({ themeId: "nord-custom", mode: "dark" });
      expect(imported.problem).toBeUndefined();
      const saved = JSON.parse(readFileSync(path, "utf8")) as { appearance: { themeFile: string } };
      expect(saved.appearance.themeFile).toMatch(/^themes\/nord-custom-[a-f0-9]{64}\.json$/u);
      const copy = join(directory, "config", saved.appearance.themeFile);
      expect(statSync(copy).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
        sync: { provider: "convex" },
        appearance: { themeId: "nord-custom", mode: "dark", themeFile: saved.appearance.themeFile, overrides },
      });
      expect(loadAppearanceConfig({ defaultConfigPath: path, environment: {}, platform: "linux" })).toMatchObject({ themeId: "nord-custom" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps an active same-ID theme intact when config publication fails", () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "leaflogue-theme-import-rollback-")));
    const path = join(directory, "config.json");
    const themeDirectory = join(directory, "themes");
    const activeThemePath = join(themeDirectory, "quiet-library-active.json");
    const sourcePath = join(directory, "replacement.json");
    try {
      mkdirSync(themeDirectory, { mode: 0o700 });
      const activeTheme = JSON.stringify(customManifest());
      writeFileSync(activeThemePath, activeTheme, { mode: 0o600 });
      const replacement = { ...customManifest(), name: "Quiet Library Revised" };
      writeFileSync(sourcePath, JSON.stringify(replacement), { mode: 0o600 });
      const originalConfig = JSON.stringify({
        version: 1,
        appearance: { themeId: "quiet-library", mode: "dark", themeFile: "themes/quiet-library-active.json" },
        extensionSetting: { values: Array.from({ length: 10_000 }, (_, index) => index % 10) },
      });
      expect(Buffer.byteLength(originalConfig)).toBeLessThan(64 * 1024);
      writeFileSync(path, originalConfig, { mode: 0o600 });

      expect(() => importThemeFile(path, sourcePath, "linux")).toThrow(/smaller than 64 KiB/);
      expect(readFileSync(path, "utf8")).toBe(originalConfig);
      expect(readFileSync(activeThemePath, "utf8")).toBe(activeTheme);
      expect(readdirSync(themeDirectory)).toEqual(["quiet-library-active.json"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses to import linked, oversized, reserved, or unreadable themes and leaves the config untouched", () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "leaflogue-theme-import-invalid-")));
    const path = join(directory, "config.json");
    try {
      const original = JSON.stringify({ version: 1, appearance: { themeId: "nord", mode: "dark" } });
      writeFileSync(path, original, { mode: 0o600 });
      const valid = join(directory, "valid.json");
      writeFileSync(valid, JSON.stringify(customManifest()), { mode: 0o600 });
      const linked = join(directory, "linked.json");
      symlinkSync(valid, linked);
      const oversized = join(directory, "oversized.json");
      writeFileSync(oversized, "x".repeat(32 * 1024 + 1), { mode: 0o600 });
      const reserved = join(directory, "reserved.json");
      writeFileSync(reserved, JSON.stringify({ ...customManifest(), id: "nord" }), { mode: 0o600 });
      const unreadable = join(directory, "unreadable.json");
      writeFileSync(unreadable, JSON.stringify({ ...customManifest(), dark: { ...customManifest().dark, ink: customManifest().dark.paper } }), { mode: 0o600 });
      for (const [source, problem] of [
        [linked, /regular file rather than a link/],
        [oversized, /smaller than 32 KiB/],
        [reserved, /invalid or reserved/],
        [unreadable, /contrast is too low/],
      ] as const) {
        expect(() => importThemeFile(path, source, "linux")).toThrow(problem);
        expect(readFileSync(path, "utf8")).toBe(original);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("picks up every valid theme in the themes folder and names the files it skips", () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "leaflogue-theme-folder-")));
    const path = join(directory, "config.json");
    const themes = join(directory, "themes");
    try {
      mkdirSync(themes, { mode: 0o700 });
      writeFileSync(join(themes, "quiet-library.json"), JSON.stringify(customManifest()), { mode: 0o600 });
      writeFileSync(join(themes, "dusk.json"), JSON.stringify({ ...customManifest(), id: "dusk", name: "Dusk" }), { mode: 0o600 });
      writeFileSync(join(themes, "loose.json"), JSON.stringify({ ...customManifest(), id: "loose", name: "Loose" }), { mode: 0o644 });
      chmodSync(join(themes, "loose.json"), 0o644);
      writeFileSync(join(themes, "twin.json"), JSON.stringify({ ...customManifest(), name: "Twin" }), { mode: 0o600 });
      // An older import copy of a theme already present is skipped quietly.
      writeFileSync(join(themes, `quiet-library-${"a".repeat(64)}.json`), JSON.stringify(customManifest()), { mode: 0o600 });
      writeFileSync(join(themes, "notes.txt"), "not a theme", { mode: 0o600 });

      // No appearance section at all: dropped-in themes are still offered.
      writeFileSync(path, JSON.stringify({ version: 1 }), { mode: 0o600 });
      const loaded = loadAppearanceConfig({ defaultConfigPath: path, environment: {}, platform: "linux" });
      expect(loaded.themeId).toBe("leaflogue");
      expect(loaded.themes.map(({ id }) => id)).toEqual(expect.arrayContaining(["quiet-library", "dusk"]));
      expect(loaded.themes.map(({ id }) => id)).not.toContain("loose");
      expect(loaded.problem).toMatch(/Skipped themes\/loose\.json: Custom theme file permissions must be 0600/);
      expect(loaded.problem).toMatch(/Skipped themes\/twin\.json: another theme already uses the ID "quiet-library"/);
      expect(loaded.problem).not.toMatch(/a{64}/);

      expect(writeAppearanceConfig(path, { themeId: "dusk", mode: "dark" })).toMatchObject({ themeId: "dusk", mode: "dark" });
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ appearance: { themeId: "dusk", mode: "dark" } });
      expect(resolveAppearanceFiles({ defaultConfigPath: path, environment: {}, platform: "linux" }).themesDirectory).toBe(themes);

      // Removing the file falls back to the default with a clear reason.
      rmSync(join(themes, "dusk.json"));
      expect(loadAppearanceConfig({ defaultConfigPath: path, environment: {}, platform: "linux" }))
        .toMatchObject({ themeId: "leaflogue", problem: expect.stringMatching(/Theme is unavailable/) });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps the documented example manifest valid under every contrast rule", () => {
    const example = JSON.parse(readFileSync(new URL("../../../theme.example.json", import.meta.url), "utf8")) as unknown;
    expect(themeContrastProblems(parseThemeManifest(example))).toEqual([]);
  });

  it("accepts links at or above the config directory but not between it and the theme", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "leaflogue-theme-links-")));
    try {
      // A linked config directory, as with macOS /var or a linked home folder.
      const realConfig = join(root, "real-config");
      mkdirSync(join(realConfig, "themes"), { recursive: true, mode: 0o700 });
      writeFileSync(join(realConfig, "themes", "quiet-library.json"), JSON.stringify(customManifest()), { mode: 0o600 });
      writeFileSync(join(realConfig, "config.json"), JSON.stringify({
        version: 1,
        appearance: { themeId: "quiet-library", mode: "dark", themeFile: "themes/quiet-library.json" },
      }), { mode: 0o600 });
      const linkedConfig = join(root, "linked-config");
      symlinkSync(realConfig, linkedConfig);
      const linkedPath = join(linkedConfig, "config.json");
      const linked = loadAppearanceConfig({ defaultConfigPath: linkedPath, environment: {}, platform: "linux" });
      expect(linked).toMatchObject({ themeId: "quiet-library", mode: "dark" });
      expect(linked.problem).toBeUndefined();
      expect(canonicalConfigPath(linkedPath)).toBe(join(realConfig, "config.json"));
      expect(resolveAppearanceFiles({ defaultConfigPath: linkedPath, environment: {}, platform: "linux" }))
        .toEqual({ configPath: join(realConfig, "config.json"), themesDirectory: join(realConfig, "themes"), themePath: join(realConfig, "themes", "quiet-library.json") });

      // A linked directory beneath the config directory is rejected.
      const outside = join(root, "outside-themes");
      mkdirSync(outside, { mode: 0o700 });
      writeFileSync(join(outside, "quiet-library.json"), JSON.stringify(customManifest()), { mode: 0o600 });
      const intermediate = join(root, "intermediate");
      mkdirSync(intermediate, { mode: 0o700 });
      symlinkSync(outside, join(intermediate, "themes"));
      const intermediatePath = join(intermediate, "config.json");
      writeFileSync(intermediatePath, JSON.stringify({
        version: 1,
        appearance: { themeId: "quiet-library", mode: "dark", themeFile: "themes/quiet-library.json" },
      }), { mode: 0o600 });
      expect(loadAppearanceConfig({ defaultConfigPath: intermediatePath, environment: {}, platform: "linux" }))
        .toMatchObject({ themeId: "leaflogue", mode: "system", problem: expect.stringMatching(/between the config directory and the theme file/) });

      // An absolute reference has no trusted root, so it must be canonical.
      const absolutePath = join(realConfig, "absolute.json");
      for (const [themeFile, expected] of [
        [join(realConfig, "themes", "quiet-library.json"), { themeId: "quiet-library" }],
        // The linked reference is refused, though the same file still loads from the themes folder.
        [join(linkedConfig, "themes", "quiet-library.json"), { themeId: "quiet-library", problem: expect.stringMatching(/canonical absolute path/) }],
      ] as const) {
        writeFileSync(absolutePath, JSON.stringify({ version: 1, appearance: { themeId: "quiet-library", mode: "dark", themeFile } }), { mode: 0o600 });
        const result = loadAppearanceConfig({ defaultConfigPath: absolutePath, environment: {}, platform: "linux" });
        expect(result).toMatchObject(expected);
        if (!("problem" in expected)) expect(result.problem).toBeUndefined();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function customManifest() {
  const source = BUILT_IN_THEMES.find(({ id }) => id === "rose-pine")!;
  return {
    version: 1,
    id: "quiet-library",
    name: "Quiet Library",
    light: { ...source.light },
    dark: { ...source.dark },
  };
}
