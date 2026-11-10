import type { AppearanceConfiguration, ThemeTokens } from "@leaflogue/contracts";
import { toneProperties } from "@leaflogue/ui";

type RequiredToken = Exclude<keyof ThemeTokens, "chart">;

const TOKEN_PROPERTIES: Readonly<Record<RequiredToken, string>> = {
  paper: "--paper",
  dot: "--dot",
  ink: "--ink",
  pencil: "--pencil",
  pen: "--pen",
  highlighter: "--highlighter",
  highlighterWash: "--highlighter-wash",
  ruled: "--ruled",
  ruledLine: "--ruled-line",
  kraft: "--kraft",
  kraftInk: "--kraft-ink",
  stamp: "--stamp",
  hairline: "--hairline",
  edge: "--edge",
  drop: "--drop",
  muted: "--muted",
  border: "--border",
  controlBorder: "--control-border",
};

let stopSystemListener: (() => void) | undefined;

export function applyAppearance(configuration: AppearanceConfiguration, systemDark: boolean): "light" | "dark" {
  const definition = configuration.themes.find(({ id }) => id === configuration.themeId) ?? configuration.themes[0];
  if (!definition) throw new Error("Leaflogue has no usable theme");
  const mode = configuration.mode === "system" ? (systemDark ? "dark" : "light") : configuration.mode;
  const root = document.documentElement;
  const values = definition[mode];
  for (const [token, property] of Object.entries(TOKEN_PROPERTIES) as [RequiredToken, string][]) {
    root.style.setProperty(property, values[token]);
  }
  // The chart colour (or pen) and each accent's readable text colour.
  for (const [property, value] of Object.entries(toneProperties(values))) root.style.setProperty(property, value);
  root.style.setProperty("--background", values.paper);
  root.style.setProperty("--foreground", values.ink);
  root.style.setProperty("--primary", values.ink);
  root.style.setProperty("--primary-foreground", values.paper);
  root.style.setProperty("--muted-foreground", values.pencil);
  root.style.setProperty("--accent", values.pen);
  root.style.setProperty("--destructive", values.stamp);
  root.style.colorScheme = mode;
  root.dataset.theme = definition.id;
  root.dataset.appearance = mode;
  return mode;
}

export function activateAppearance(configuration: AppearanceConfiguration): void {
  stopSystemListener?.();
  stopSystemListener = undefined;
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  applyAppearance(configuration, media.matches);
  if (configuration.mode !== "system") return;
  const update = (event: MediaQueryListEvent) => applyAppearance(configuration, event.matches);
  media.addEventListener("change", update);
  stopSystemListener = () => media.removeEventListener("change", update);
}

/**
 * Apply the stored choice before the first paint, so a restart reopens in the
 * theme the reader left. A damaged or unreadable configuration is not worth a
 * blank window: the stylesheet's system-theme fallback is already in place.
 */
export async function activateStoredAppearance(read: () => Promise<AppearanceConfiguration>): Promise<void> {
  try {
    activateAppearance(await read());
  } catch {
    // CSS contains the Leaflogue system-theme fallback for damaged configuration.
  }
}
