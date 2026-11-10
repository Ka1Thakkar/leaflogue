/**
 * Accent colours as text, only where the theme makes them readable. Themes
 * guarantee ink, pencil, and stamp as text; their accents (pen, highlighter,
 * chart) are only guaranteed as marks. So each accent is offered as a text
 * colour when it clears WCAG on both the page and a panel (3:1 for large
 * figures, 4.5:1 for small labels). An accent that does not is shaded, a step
 * at a time, until it does: bright gold on cream paper becomes dark amber
 * rather than disappearing into plain text.
 */
export interface ToneInputs {
  readonly paper: string;
  readonly ruled: string;
  readonly ink: string;
  readonly pen: string;
  readonly highlighter: string;
  readonly stamp: string;
  readonly chart?: string;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

export function contrastRatio(first: string, second: string): number {
  const a = luminance(first.slice(0, 7));
  const b = luminance(second.slice(0, 7));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness];
  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  const hue = max === r ? ((g - b) / delta + (g < b ? 6 : 0)) : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return [hue * 60, saturation, lightness];
}

function fromHsl(hue: number, saturation: number, lightness: number): string {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lightness - chroma / 2;
  const [r, g, b] = hue < 60 ? [chroma, x, 0] : hue < 120 ? [x, chroma, 0] : hue < 180 ? [0, chroma, x]
    : hue < 240 ? [0, x, chroma] : hue < 300 ? [x, 0, chroma] : [chroma, 0, x];
  return `#${[r, g, b].map((channel) => Math.round((channel + m) * 255).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The same colour, darker on a light page or lighter on a dark one, keeping
 * its hue and saturation. Yellows lean toward amber as they darken, the way
 * printed gold does, instead of turning olive.
 */
function shade(color: string, step: number, darken: boolean): string {
  const [hue, saturation, lightness] = toHsl(color);
  const amberHue = darken && hue > 38 && hue < 70 ? hue - Math.min(hue - 38, step * 40) : hue;
  return fromHsl(amberHue, saturation, Math.min(1, Math.max(0, lightness + (darken ? -step : step))));
}

/** CSS custom properties for `ui.css`'s accent tones, from the active theme variant. */
export function toneProperties(tokens: ToneInputs): Record<string, string> {
  const chart = tokens.chart ?? tokens.pen;
  const passes = (color: string, minimum: number) =>
    contrastRatio(color, tokens.paper) >= minimum && contrastRatio(color, tokens.ruled) >= minimum;
  const darken = contrastRatio(tokens.paper, "#000000") > contrastRatio(tokens.paper, "#ffffff");
  const readable = (color: string, minimum: number) => {
    for (let step = 0; step <= 0.6; step += 0.02) {
      const candidate = shade(color.slice(0, 7), step, darken);
      if (passes(candidate, minimum)) return candidate;
    }
    return tokens.ink;
  };
  const properties: Record<string, string> = { "--chart": chart };
  for (const [name, color] of [["chart", chart], ["mark", tokens.highlighter], ["good", tokens.pen], ["danger", tokens.stamp]] as const) {
    properties[`--ui-tone-${name}`] = readable(color, 3);
    properties[`--ui-tone-${name}-text`] = readable(color, 4.5);
  }
  return properties;
}
