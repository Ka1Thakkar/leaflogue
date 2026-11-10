import { describe, expect, it } from "vitest";
import { appearanceConfiguration, applyThemeOverrides, BUILT_IN_THEMES, exportableThemeManifest, parseThemeManifest, parseThemeOverrides, themeContrastProblems, validateAppearanceSettings } from "./index";

describe("appearance domain", () => {
  it("ships complete light and dark token sets with readable body text", () => {
    expect(BUILT_IN_THEMES.map(({ id }) => id)).toEqual([
      "leaflogue", "everforest", "catppuccin", "rose-pine", "tokyo-night", "nord",
    ]);
    for (const theme of BUILT_IN_THEMES) {
      expect(themeContrastProblems(theme), theme.id).toEqual([]);
      for (const variant of [theme.light, theme.dark]) {
        expect(Object.keys(variant)).toHaveLength(19);
        expect(variant.chart, `${theme.id} chart`).toMatch(/^#[0-9a-f]{6}$/u);
        expect(contrast(variant.ink, variant.paper), `${theme.id} body`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(variant.pencil, variant.paper), `${theme.id} muted text`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(variant.kraftInk, variant.kraft), `${theme.id} accent text`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(variant.controlBorder, variant.paper), `${theme.id} control boundary`).toBeGreaterThanOrEqual(3);
        expect(contrast(variant.pen, variant.paper), `${theme.id} focus indicator`).toBeGreaterThanOrEqual(3);
        expect(contrast(variant.ink, opaqueOver(variant.highlighterWash, variant.paper)), `${theme.id} selection`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(variant.stamp, variant.paper), `${theme.id} danger text`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps a placeholder cover quieter than the reading it stands in for", () => {
    // A cover with no artwork is the least meaningful block on a page, and the
    // largest. Deriving it from a theme's accent inverts that: dark-mode
    // accents are light by convention, so the placeholder ends up the
    // brightest thing on screen, louder than the titles beside it. A cover is
    // book cloth — a surface — so it stays dark in a dark theme and darker
    // than the page in a light one.
    for (const theme of BUILT_IN_THEMES) {
      expect(luminance(theme.light.kraft), `${theme.id} light cover`)
        .toBeLessThan(luminance(theme.light.paper));
      expect(luminance(theme.dark.kraft), `${theme.id} dark cover`).toBeLessThanOrEqual(0.13);
      expect(luminance(theme.dark.kraft), `${theme.id} dark cover`)
        .toBeGreaterThan(luminance(theme.dark.paper));
    }
  });

  it("preserves every established Leaflogue semantic token", () => {
    expect(BUILT_IN_THEMES[0]).toMatchObject({
      light: {
        paper: "#fbf6ea", dot: "#e7dfcf", ink: "#2a2521", pencil: "#6d6459", pen: "#27508c",
        highlighter: "#ffd84d", highlighterWash: "#ffd84d", ruled: "#fdfbf4", ruledLine: "#e9e3d5",
        kraft: "#c9a97d", kraftInk: "#46381f", stamp: "#bf453a", hairline: "#2a252126",
        edge: "#2a252121", drop: "#2a2521a8", muted: "#f1ead9", border: "#d8cdb4",
      },
      dark: {
        paper: "#211d17", dot: "#393229", ink: "#ece5d6", pencil: "#a79c88", pen: "#8fb6ea",
        highlighter: "#ffd84d", highlighterWash: "#ffd84d3d", ruled: "#241f19", ruledLine: "#2e2922",
        kraft: "#6d5638", kraftInk: "#f0e4cd", stamp: "#d9695c", hairline: "#ece5d626",
        edge: "#ece5d61c", drop: "#000000b8", muted: "#2b251d", border: "#3d3529",
      },
    });
  });

  it("applies config-only overrides through the manifest grammar", () => {
    const overrides = parseThemeOverrides({ nord: { dark: { pen: "#8fbcbb", hairline: "#eceff426" } } });
    const nord = applyThemeOverrides(BUILT_IN_THEMES, overrides).find(({ id }) => id === "nord")!;
    expect(nord.dark).toMatchObject({ pen: "#8fbcbb", hairline: "#eceff426", ink: BUILT_IN_THEMES.find(({ id }) => id === "nord")!.dark.ink });
    expect(nord.light).toEqual(BUILT_IN_THEMES.find(({ id }) => id === "nord")!.light);
    expect(appearanceConfiguration({ themeId: "nord", mode: "dark" }, undefined, [], overrides).themes.find(({ id }) => id === "nord")?.dark.pen)
      .toBe("#8fbcbb");
  });

  it.each([
    [{ nord: { dark: { pen: "url(#x)" } } }, /lowercase hex/],
    [{ nord: { dark: { pen: "var(--pen)" } } }, /lowercase hex/],
    [{ nord: { dark: { pen: "#8FBCBB" } } }, /lowercase hex/],
    [{ nord: { dark: { ink: "#eceff4cc" } } }, /lowercase hex/],
    [{ nord: { dark: { background: "#000000" } } }, /not a semantic role/],
    [{ nord: { dusk: {} } }, /unknown fields/],
    [{ "Nord!": { dark: {} } }, /ID is invalid/],
    [[], /must be an object/],
  ])("rejects override %j", (value, problem) => {
    expect(() => parseThemeOverrides(value)).toThrow(problem);
  });

  it("refuses overrides that break contrast or name an unavailable theme, applying nothing", () => {
    expect(() => applyThemeOverrides(BUILT_IN_THEMES, parseThemeOverrides({ nord: { dark: { ink: "#3b4252" } } })))
      .toThrow(/body text contrast is too low after overrides for nord/);
    expect(() => applyThemeOverrides(BUILT_IN_THEMES, parseThemeOverrides({ removed: { dark: {} } })))
      .toThrow(/unavailable theme removed/);
  });

  it("exports built-ins as re-importable copies and custom themes as themselves", () => {
    const nord = BUILT_IN_THEMES.find(({ id }) => id === "nord")!;
    const exported = exportableThemeManifest(nord);
    expect(exported).toEqual({ version: 1, id: "nord-custom", name: "Nord custom", light: nord.light, dark: nord.dark });
    expect(parseThemeManifest(JSON.parse(JSON.stringify(exported)))).toMatchObject({ id: "nord-custom" });
    const custom = parseThemeManifest(manifest());
    expect(exportableThemeManifest(custom)).toMatchObject({ id: "quiet-library", name: "Quiet Library" });
  });

  it("rejects unknown settings fields", () => {
    expect(() => validateAppearanceSettings({ themeId: "leaflogue", mode: "light", css: "body{}" }))
      .toThrow(/unknown fields/);
  });

  it("draws each dark placeholder cover from its own palette's raised surface", () => {
    const cover = (id: string) => {
      const dark = BUILT_IN_THEMES.find((theme) => theme.id === id)?.dark;
      return { kraft: dark?.kraft, kraftInk: dark?.kraftInk };
    };
    // Each value is that palette's own surface or overlay shade, not its
    // accent: Rosé Pine highlightHigh, Tokyo Night fg_gutter, Nord nord3.
    expect(cover("rose-pine")).toEqual({ kraft: "#524f67", kraftInk: "#e0def4" });
    expect(cover("tokyo-night")).toEqual({ kraft: "#414868", kraftInk: "#c0caf5" });
    expect(cover("nord")).toEqual({ kraft: "#4c566a", kraftInk: "#eceff4" });
  });

  it("accepts a complete, versioned custom theme with semantic colors only", () => {
    const custom = manifest();
    expect(parseThemeManifest(custom)).toEqual({
      id: "quiet-library",
      name: "Quiet Library",
      light: custom.light,
      dark: custom.dark,
    });
  });

  it.each([
    ["unknown manifest field", () => ({ ...manifest(), css: "body{}" })],
    ["unknown token", () => ({ ...manifest(), light: { ...manifest().light, link: "#000000" } })],
    ["missing token", () => {
      const light: Record<string, string> = { ...manifest().light };
      Reflect.deleteProperty(light, "paper");
      return { ...manifest(), light };
    }],
    ["reserved ID", () => ({ ...manifest(), id: "rose-pine" })],
    ["unsafe ID", () => ({ ...manifest(), id: "../quiet-library" })],
    ["control character", () => ({ ...manifest(), name: "Quiet\nLibrary" })],
    ["CSS value", () => ({ ...manifest(), light: { ...manifest().light, paper: "var(--paper)" } })],
    ["uppercase hex", () => ({ ...manifest(), light: { ...manifest().light, paper: "#FAF4ED" } })],
    ["alpha on opaque role", () => ({ ...manifest(), light: { ...manifest().light, paper: "#faf4edff" } })],
  ])("rejects %s", (_label, build) => {
    expect(() => parseThemeManifest(build())).toThrow();
  });

  it("rejects custom themes whose semantic roles are not readable", () => {
    expect(() => parseThemeManifest({
      ...manifest(),
      light: { ...manifest().light, ink: manifest().light.paper },
    })).toThrow(/contrast is too low/);
  });

  it("rejects invisible field boundaries and focus indicators", () => {
    const source = manifest();
    expect(() => parseThemeManifest({
      ...source,
      light: { ...source.light, ruled: source.light.pen, controlBorder: source.light.pen },
    })).toThrow(/on fields contrast is too low/);
  });
  it("accepts a theme without the optional chart colour and rejects an unreadable one", () => {
    const rose = BUILT_IN_THEMES.find(({ id }) => id === "rose-pine")!;
    const withoutChart = (tokens: typeof rose.light) => Object.fromEntries(Object.entries(tokens).filter(([key]) => key !== "chart"));
    const light = withoutChart(rose.light);
    const dark = withoutChart(rose.dark);
    expect(parseThemeManifest({ version: 1, id: "no-chart", name: "No chart", light, dark }).dark.chart).toBeUndefined();
    expect(() => parseThemeManifest({ version: 1, id: "faint-chart", name: "Faint", light: rose.light, dark: { ...rose.dark, chart: rose.dark.ruled } }))
      .toThrow(/chart marks/);
  });
});

function manifest() {
  const source = BUILT_IN_THEMES.find(({ id }) => id === "rose-pine")!;
  return {
    version: 1,
    id: "quiet-library",
    name: "Quiet Library",
    light: { ...source.light },
    dark: { ...source.dark },
  };
}

function opaqueOver(foreground: string, background: string): string {
  if (foreground.length !== 9) return foreground;
  const alpha = Number.parseInt(foreground.slice(7, 9), 16) / 255;
  const channels = [1, 3, 5].map((offset) => Math.round(
    Number.parseInt(foreground.slice(offset, offset + 2), 16) * alpha
    + Number.parseInt(background.slice(offset, offset + 2), 16) * (1 - alpha),
  ));
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function contrast(first: string, second: string): number {
  const firstLuminance = luminance(first);
  const secondLuminance = luminance(second);
  return (Math.max(firstLuminance, secondLuminance) + 0.05) / (Math.min(firstLuminance, secondLuminance) + 0.05);
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}
