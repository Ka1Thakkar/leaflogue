import type { AppearanceConfiguration, AppearanceMode, AppearanceSettingsInput, ThemeDefinition, ThemeTokens } from "@leaflogue/contracts";

/** Platform-neutral built-in theme catalog and appearance validation. */

export const DEFAULT_THEME_ID = "leaflogue";
export const DEFAULT_APPEARANCE_MODE: AppearanceMode = "system";

interface Palette {
  readonly background: string;
  readonly surface: string;
  readonly elevated: string;
  readonly text: string;
  readonly subtle: string;
  readonly accent: string;
  readonly accentText: string;
  readonly bookCover?: string;
  readonly bookCoverText?: string;
  readonly highlight: string;
  readonly selection: string;
  readonly danger: string;
  readonly border: string;
  readonly shadow: string;
  readonly dot?: string;
  readonly highlighterWash?: string;
  readonly ruledLine?: string;
  readonly hairline?: string;
  readonly edge?: string;
  readonly controlBorder?: string;
  readonly chart?: string;
}

function tokens(palette: Palette): ThemeTokens {
  return {
    paper: palette.background,
    dot: palette.dot ?? palette.border,
    ink: palette.text,
    pencil: palette.subtle,
    pen: palette.accent,
    highlighter: palette.highlight,
    highlighterWash: palette.highlighterWash ?? palette.selection,
    ruled: palette.surface,
    ruledLine: palette.ruledLine ?? palette.border,
    kraft: palette.bookCover ?? palette.accent,
    kraftInk: palette.bookCoverText ?? palette.accentText,
    stamp: palette.danger,
    hairline: palette.hairline ?? palette.border,
    edge: palette.edge ?? palette.border,
    drop: palette.shadow,
    muted: palette.elevated,
    border: palette.border,
    controlBorder: palette.controlBorder ?? palette.subtle,
    ...(palette.chart ? { chart: palette.chart } : {}),
  };
}

function theme(id: string, name: string, light: Palette, dark: Palette): ThemeDefinition {
  return Object.freeze({ id, name, light: Object.freeze(tokens(light)), dark: Object.freeze(tokens(dark)) });
}

export const BUILT_IN_THEMES: readonly ThemeDefinition[] = Object.freeze([
  theme("leaflogue", "Leaflogue", {
    chart: "#3f7a5a", background: "#fbf6ea", surface: "#fdfbf4", elevated: "#f1ead9", text: "#2a2521",
    subtle: "#6d6459", accent: "#27508c", accentText: "#ffffff", bookCover: "#c9a97d",
    bookCoverText: "#46381f", highlight: "#ffd84d", highlighterWash: "#ffd84d", dot: "#e7dfcf",
    selection: "#ffd84d", danger: "#bf453a", ruledLine: "#e9e3d5", hairline: "#2a252126",
    edge: "#2a252121", border: "#d8cdb4", shadow: "#2a2521a8",
  }, {
    chart: "#8cc7a1", background: "#211d17", surface: "#241f19", elevated: "#2b251d", text: "#ece5d6",
    subtle: "#a79c88", accent: "#8fb6ea", accentText: "#172335", bookCover: "#6d5638",
    bookCoverText: "#f0e4cd", highlight: "#ffd84d", highlighterWash: "#ffd84d3d", dot: "#393229",
    selection: "#735f22", danger: "#d9695c", ruledLine: "#2e2922", hairline: "#ece5d626",
    edge: "#ece5d61c", border: "#3d3529", shadow: "#000000b8",
  }),
  theme("everforest", "Everforest", {
    chart: "#b5539c", background: "#fdf6e3", surface: "#f4f0d9", elevated: "#efebd4", text: "#5c6a72",
    subtle: "#5f6b73", accent: "#388ebd", accentText: "#1e2326", bookCover: "#3a94c5",
    bookCoverText: "#1e2326", highlight: "#dfa000",
    selection: "#f0ead4", danger: "#c23e3b", border: "#d3c6aa", shadow: "#5c6a7270",
  }, {
    chart: "#d699b6", background: "#2d353b", surface: "#343f44", elevated: "#3d484d", text: "#d3c6aa",
    subtle: "#aeb6aa", accent: "#7fbbb3", accentText: "#20282c", highlight: "#dbbc7f",
    bookCover: "#3a515d", bookCoverText: "#d3c6aa",
    selection: "#543a48", danger: "#e98f91", border: "#56635f", shadow: "#000000a8",
  }),
  theme("catppuccin", "Catppuccin", {
    chart: "#8839ef", background: "#eff1f5", surface: "#e6e9ef", elevated: "#dce0e8", text: "#4c4f69",
    subtle: "#5c5f77", accent: "#1e66f5", accentText: "#ffffff", highlight: "#df8e1d",
    selection: "#c3c7d3", danger: "#d00f38", border: "#9ca0b0", shadow: "#4c4f6966",
  }, {
    chart: "#cba6f7", background: "#1e1e2e", surface: "#181825", elevated: "#313244", text: "#cdd6f4",
    subtle: "#bac2de", accent: "#89b4fa", accentText: "#11111b", highlight: "#f9e2af",
    bookCover: "#45475a", bookCoverText: "#cdd6f4",
    selection: "#45475a", danger: "#f38ba8", border: "#585b70", shadow: "#000000a8",
  }),
  theme("rose-pine", "Rosé Pine", {
    chart: "#907aa9", background: "#faf4ed", surface: "#fffaf3", elevated: "#f2e9e1", text: "#464261",
    subtle: "#625e7a", accent: "#286983", accentText: "#ffffff", highlight: "#ea9d34",
    selection: "#dfdad9", danger: "#9f4965", border: "#b8b3c2", shadow: "#46426166",
  }, {
    chart: "#c4a7e7", background: "#191724", surface: "#1f1d2e", elevated: "#26233a", text: "#e0def4",
    subtle: "#aaa6c2", accent: "#9ccfd8", accentText: "#191724", highlight: "#f6c177",
    bookCover: "#524f67", bookCoverText: "#e0def4", selection: "#403d52", danger: "#eb6f92",
    border: "#524f67", shadow: "#000000a8",
  }),
  theme("tokyo-night", "Tokyo Night", {
    chart: "#7847bd", background: "#e6e7ed", surface: "#dfe0e7", elevated: "#d5d6df", text: "#343b58",
    subtle: "#515568", accent: "#2959aa", accentText: "#ffffff", highlight: "#8f5e15",
    selection: "#c4c8da", danger: "#8c4351", border: "#a8aec4", shadow: "#343b5866",
  }, {
    chart: "#bb9af7", background: "#1a1b26", surface: "#24283b", elevated: "#292e42", text: "#c0caf5",
    subtle: "#a9b1d6", accent: "#7aa2f7", accentText: "#16161e", highlight: "#e0af68",
    bookCover: "#414868", bookCoverText: "#c0caf5",
    selection: "#414868", danger: "#f7768e", border: "#565f89", shadow: "#000000b0",
  }),
  theme("nord", "Nord", {
    chart: "#8a5a82", background: "#eceff4", surface: "#e5e9f0", elevated: "#d8dee9", text: "#2e3440",
    subtle: "#4c566a", accent: "#4c6f99", accentText: "#ffffff", highlight: "#b06f00",
    selection: "#c8d0dc", danger: "#a9444e", border: "#9aa6b8", shadow: "#2e344066",
  }, {
    chart: "#b48ead", background: "#2e3440", surface: "#3b4252", elevated: "#434c5e", text: "#eceff4",
    subtle: "#d8dee9", accent: "#88c0d0", accentText: "#202631", highlight: "#ebcb8b",
    bookCover: "#4c566a", bookCoverText: "#eceff4",
    selection: "#4c566a", danger: "#ea98a0", border: "#5f6b7d", shadow: "#000000a8",
  }),
]);

const THEME_IDS = new Set(BUILT_IN_THEMES.map(({ id }) => id));
const APPEARANCE_MODES = new Set<AppearanceMode>(["light", "dark", "system"]);
const THEME_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OPAQUE_COLOR = /^#[0-9a-f]{6}$/;
const ALPHA_COLOR = /^#[0-9a-f]{8}$/;
const ALPHA_ROLES = new Set<keyof ThemeTokens>(["highlighterWash", "hairline", "edge", "drop"]);
export const THEME_TOKEN_KEYS = Object.freeze([
  "paper", "dot", "ink", "pencil", "pen", "highlighter", "highlighterWash", "ruled", "ruledLine",
  "kraft", "kraftInk", "stamp", "hairline", "edge", "drop", "muted", "border", "controlBorder",
] as const satisfies readonly (keyof ThemeTokens)[]);
/** Roles a theme may leave out; each has a documented fallback. */
export const OPTIONAL_THEME_TOKEN_KEYS = Object.freeze(["chart"] as const satisfies readonly (keyof ThemeTokens)[]);
const TOKEN_KEY_SET: ReadonlySet<string> = new Set([...THEME_TOKEN_KEYS, ...OPTIONAL_THEME_TOKEN_KEYS]);

export function validateAppearanceSettings(value: unknown, availableThemeIds: ReadonlySet<string> = THEME_IDS): AppearanceSettingsInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Appearance settings are invalid");
  const input = value as Record<string, unknown>;
  if (typeof input.themeId !== "string" || !availableThemeIds.has(input.themeId)) throw new Error("Theme is unavailable");
  if (typeof input.mode !== "string" || !APPEARANCE_MODES.has(input.mode as AppearanceMode)) throw new Error("Appearance mode is invalid");
  if (Object.keys(input).some((key) => key !== "themeId" && key !== "mode")) throw new Error("Appearance settings contain unknown fields");
  return { themeId: input.themeId, mode: input.mode as AppearanceMode };
}

export function appearanceConfiguration(
  settings?: Partial<AppearanceSettingsInput>,
  problem?: string,
  customThemes: readonly ThemeDefinition[] = [],
  overrides: ThemeOverrides = {},
): AppearanceConfiguration {
  const themes = applyThemeOverrides([...BUILT_IN_THEMES, ...customThemes], overrides);
  const availableThemeIds = new Set(themes.map(({ id }) => id));
  const themeId = typeof settings?.themeId === "string" && availableThemeIds.has(settings.themeId) ? settings.themeId : DEFAULT_THEME_ID;
  const mode = typeof settings?.mode === "string" && APPEARANCE_MODES.has(settings.mode) ? settings.mode : DEFAULT_APPEARANCE_MODE;
  return { themeId, mode, themes, ...(problem ? { problem } : {}) };
}

export function parseThemeManifest(value: unknown): ThemeDefinition {
  const manifest = record(value, "Theme manifest");
  exactKeys(manifest, ["version", "id", "name", "light", "dark"], "Theme manifest");
  if (manifest.version !== 1) throw new Error("Theme manifest version is not supported");
  if (typeof manifest.id !== "string" || !THEME_ID.test(manifest.id) || THEME_IDS.has(manifest.id)) {
    throw new Error("Custom theme ID is invalid or reserved");
  }
  if (typeof manifest.name !== "string" || !manifest.name.trim() || manifest.name.length > 80 || hasControlCharacter(manifest.name)) {
    throw new Error("Custom theme name is invalid");
  }
  const definition = Object.freeze({
    id: manifest.id,
    name: manifest.name.trim(),
    light: Object.freeze(parseTokens(manifest.light, "light")),
    dark: Object.freeze(parseTokens(manifest.dark, "dark")),
  });
  validateThemeContrast(definition);
  return definition;
}

export interface ThemeManifest {
  readonly version: 1;
  readonly id: string;
  readonly name: string;
  readonly light: ThemeTokens;
  readonly dark: ThemeTokens;
}

/**
 * A portable manifest for a theme as it is currently rendered, overrides
 * included. Built-in IDs are reserved, so a built-in is exported as an
 * editable copy with its own ID that can be imported again.
 */
export function exportableThemeManifest(theme: ThemeDefinition): ThemeManifest {
  const builtIn = THEME_IDS.has(theme.id);
  const manifest: ThemeManifest = {
    version: 1,
    id: builtIn ? `${theme.id}-custom` : theme.id,
    name: builtIn ? `${theme.name} custom`.slice(0, 80) : theme.name,
    light: { ...theme.light },
    dark: { ...theme.dark },
  };
  parseThemeManifest(manifest);
  return manifest;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 31 || code === 127;
  });
}

function parseTokens(value: unknown, variant: string): ThemeTokens {
  const input = record(value, `Theme ${variant} tokens`);
  const optional = OPTIONAL_THEME_TOKEN_KEYS.filter((key) => key in input);
  exactKeys(input, [...THEME_TOKEN_KEYS, ...optional], `Theme ${variant} tokens`);
  return parseTokenSubset(input, variant) as ThemeTokens;
}

/** The one role allowlist and colour grammar shared by manifests and overrides. */
function parseTokenSubset(input: Record<string, unknown>, variant: string): Partial<ThemeTokens> {
  const result: Partial<Record<keyof ThemeTokens, string>> = {};
  for (const [key, color] of Object.entries(input)) {
    if (!TOKEN_KEY_SET.has(key)) throw new Error(`Theme ${variant} token ${key} is not a semantic role`);
    const role = key as keyof ThemeTokens;
    if (typeof color !== "string" || (!OPAQUE_COLOR.test(color) && !(ALPHA_ROLES.has(role) && ALPHA_COLOR.test(color)))) {
      throw new Error(`Theme ${variant} token ${key} must be a lowercase hex color`);
    }
    result[role] = color;
  }
  return result;
}

export interface ThemeOverride {
  readonly light?: Partial<ThemeTokens>;
  readonly dark?: Partial<ThemeTokens>;
}

/** Config-only token overrides, keyed by the theme they adjust. */
export type ThemeOverrides = Readonly<Record<string, ThemeOverride>>;

const MAX_OVERRIDDEN_THEMES = 16;

export function parseThemeOverrides(value: unknown): ThemeOverrides {
  const input = record(value, "Theme overrides");
  const entries = Object.entries(input);
  if (entries.length > MAX_OVERRIDDEN_THEMES) throw new Error("Theme overrides name too many themes");
  const result: Record<string, ThemeOverride> = {};
  for (const [themeId, override] of entries) {
    if (!THEME_ID.test(themeId)) throw new Error("Theme override ID is invalid");
    const variants = record(override, `Theme ${themeId} overrides`);
    if (Object.keys(variants).some((key) => key !== "light" && key !== "dark")) {
      throw new Error(`Theme ${themeId} overrides have unknown fields`);
    }
    result[themeId] = Object.freeze({
      ...(variants.light !== undefined ? { light: Object.freeze(parseTokenSubset(record(variants.light, `Theme ${themeId} light overrides`), `${themeId} light`)) } : {}),
      ...(variants.dark !== undefined ? { dark: Object.freeze(parseTokenSubset(record(variants.dark, `Theme ${themeId} dark overrides`), `${themeId} dark`)) } : {}),
    });
  }
  return Object.freeze(result);
}

/**
 * Apply validated overrides to their themes. Every overridden theme must still
 * pass the full contrast list; otherwise nothing is applied, so a theme is
 * never partially adjusted.
 */
export function applyThemeOverrides(themes: readonly ThemeDefinition[], overrides: ThemeOverrides): readonly ThemeDefinition[] {
  const known = new Set(themes.map(({ id }) => id));
  const unknown = Object.keys(overrides).find((id) => !known.has(id));
  if (unknown) throw new Error(`Theme overrides refer to unavailable theme ${unknown}`);
  return themes.map((theme) => {
    const override = overrides[theme.id];
    if (!override) return theme;
    const adjusted: ThemeDefinition = Object.freeze({
      ...theme,
      light: Object.freeze({ ...theme.light, ...override.light }),
      dark: Object.freeze({ ...theme.dark, ...override.dark }),
    });
    const [problem] = themeContrastProblems(adjusted);
    if (problem) throw new Error(`${problem} after overrides for ${theme.id}`);
    return adjusted;
  });
}

function validateThemeContrast(theme: ThemeDefinition): void {
  const [problem] = themeContrastProblems(theme);
  if (problem) throw new Error(problem);
}

/**
 * WCAG 2.2 AA pairs for every surface the desktop renders: 4.5:1 for text and
 * 3:1 for focus indicators, control boundaries, and meaningful icons. Built-in
 * and custom themes are held to the same list.
 */
export function themeContrastProblems(theme: ThemeDefinition): readonly string[] {
  const problems: string[] = [];
  for (const [mode, variant] of [["light", theme.light], ["dark", theme.dark]] as const) {
    const selection = opaqueOver(variant.highlighterWash, variant.paper);
    const requirements = [
      [variant.ink, variant.paper, 4.5, "body text"],
      [variant.pencil, variant.paper, 4.5, "muted text"],
      [variant.kraftInk, variant.kraft, 4.5, "placeholder-cover text"],
      [variant.stamp, variant.paper, 4.5, "danger text"],
      [variant.controlBorder, variant.paper, 3, "control boundary"],
      [variant.controlBorder, variant.ruled, 3, "control boundary on fields"],
      [variant.pen, variant.paper, 3, "focus indicator"],
      [variant.pen, variant.ruled, 3, "focus indicator on fields"],
      [variant.ink, selection, 4.5, "selected text"],
      [variant.paper, variant.ink, 4.5, "primary button text"],
      [variant.ink, variant.ruled, 4.5, "text on ruled paper"],
      [variant.pencil, variant.ruled, 4.5, "muted text on ruled paper"],
      [variant.stamp, variant.ruled, 4.5, "danger text on ruled paper"],
      [variant.ink, variant.muted, 4.5, "navigation text"],
      [variant.pencil, variant.muted, 4.5, "muted navigation text"],
      [variant.pen, variant.muted, 3, "focus indicator on navigation"],
      [variant.stamp, variant.muted, 3, "danger icon on hover"],
      ...(variant.chart ? [
        [variant.chart, variant.paper, 3, "chart marks"],
        [variant.chart, variant.ruled, 3, "chart marks on panels"],
      ] as const : []),
    ] as const;
    for (const [foreground, background, minimum, label] of requirements) {
      if (contrast(foreground, background) < minimum) {
        problems.push(`Theme ${mode} ${label} contrast is too low`);
      }
    }
  }
  return problems;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !expected.has(key))) {
    throw new Error(`${label} has missing or unknown fields`);
  }
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

function opaqueOver(foreground: string, background: string): string {
  if (foreground.length !== 9) return foreground;
  const alpha = Number.parseInt(foreground.slice(7, 9), 16) / 255;
  const channels = [1, 3, 5].map((offset) => Math.round(
    Number.parseInt(foreground.slice(offset, offset + 2), 16) * alpha
    + Number.parseInt(background.slice(offset, offset + 2), 16) * (1 - alpha),
  ));
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}
