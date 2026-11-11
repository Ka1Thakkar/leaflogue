import type { ThemeTokens } from "@leaflogue/contracts";
import { contrastRatio } from "@leaflogue/ui";

function rgb(value: string): [number, number, number, number] | undefined {
  if (/^#[\da-f]{6}$/iu.test(value)) return [parseInt(value.slice(1, 3), 16), parseInt(value.slice(3, 5), 16), parseInt(value.slice(5, 7), 16), 1];
  if (!/^rgba?\(/u.test(value)) return undefined;
  const parts = value.match(/[\d.]+/gu)?.map(Number);
  return parts && parts.length >= 3 ? [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1] : undefined;
}
const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0")).join("")}`;
function hsl(value: string): [number, number, number] {
  const channels = rgb(value) ?? [0, 0, 0, 1]; const [r, g, b] = channels.slice(0, 3).map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min, lightness = (max + min) / 2;
  const hue = !delta ? 0 : max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return [hue * 60, delta ? delta / (1 - Math.abs(2 * lightness - 1)) : 0, lightness];
}
function fromHsl(h: number, s: number, l: number) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return hex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}
const distance = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
const mix = (a: string, b: string, amount: number) => {
  const first = rgb(a)!, second = rgb(b)!;
  return hex(...[0, 1, 2].map((i) => first[i]! * (1 - amount) + second[i]! * amount) as [number, number, number]);
};

/** Map chromatic colours by hue family; adapt missing families to the theme's saturation. */
export function readerColor(value: string, property: "color" | "background-color" | "border-color", dark: boolean, tokens?: ThemeTokens): string {
  const original = rgb(value);
  const paper = tokens?.paper.slice(0, 7) ?? (dark ? "#000000" : "#ffffff");
  const ink = tokens?.ink.slice(0, 7) ?? (dark ? "#ffffff" : "#111111");
  if (original?.[3] === 0) return property === "color" ? ink : "transparent";
  if (!tokens) return property === "color" ? ink : property === "background-color" ? "transparent" : dark ? "#555555" : "#cccccc";
  if (!original) return property === "color" ? ink : "transparent";
  const source = hex(...original.slice(0, 3) as [number, number, number]); const [hue, saturation, lightness] = hsl(source);
  if (saturation < 0.14) return property === "color" ? ink : property === "border-color" ? tokens.border.slice(0, 7) : lightness > 0.94 ? paper : tokens.muted.slice(0, 7);
  const candidates = [tokens.pen, tokens.stamp, tokens.highlighter, tokens.chart, tokens.kraft].filter((color): color is string => Boolean(color)).map((color) => color.slice(0, 7)).filter((color) => hsl(color)[1] > 0.15);
  const nearest = [...candidates].sort((a, b) => distance(hsl(a)[0], hue) - distance(hsl(b)[0], hue))[0];
  const accent = hsl(tokens.pen.slice(0, 7));
  const base = nearest && distance(hsl(nearest)[0], hue) < 35 ? nearest : fromHsl(hue, Math.max(0.3, Math.min(0.7, accent[1])), dark ? 0.72 : 0.32);
  if (property === "background-color") return mix(paper, base, 0.18);
  if (property === "border-color") return base;
  const [h, s, l] = hsl(base);
  for (let step = 0; step <= 1; step += 0.025) {
    const adjusted = fromHsl(h, s, dark ? Math.min(1, l + step) : Math.max(0, l - step));
    if (contrastRatio(adjusted, paper) >= 4.5) return adjusted;
  }
  return ink;
}

const originalColors = new WeakMap<Document, { element: HTMLElement; color: string; background: string; border: string }[]>();
export function applyReaderColors(doc: Document, dark: boolean, tokens?: ThemeTokens) {
  let originals = originalColors.get(doc);
  if (!originals) {
    originals = Array.from(doc.querySelectorAll<HTMLElement>("#reader-pages *")).map((element) => {
      const style = doc.defaultView!.getComputedStyle(element);
      return { element, color: style.color, background: style.backgroundColor, border: style.borderTopColor };
    });
    originalColors.set(doc, originals);
  }
  const cache = new Map<string, string>();
  const map = (value: string, property: "color" | "background-color" | "border-color") => {
    const key = `${value}:${property}`; let mapped = cache.get(key);
    if (!mapped) { mapped = readerColor(value, property, dark, tokens); cache.set(key, mapped); }
    return mapped;
  };
  for (const original of originals) {
    for (const [property, value] of [["color", original.color], ["background-color", original.background], ["border-color", original.border]] as const) original.element.style.setProperty(property, map(value, property), "important");
  }
  doc.body.style.setProperty("background-color", tokens?.paper ?? (dark ? "#000000" : "#ffffff"), "important");
  doc.body.style.setProperty("color", tokens?.ink ?? (dark ? "#ffffff" : "#111111"), "important");
  let highlightStyle = doc.getElementById("reader-highlight-colors");
  if (!highlightStyle) { highlightStyle = doc.createElement("style"); highlightStyle.id = "reader-highlight-colors"; doc.head.append(highlightStyle); }
  const background = tokens?.highlighter.slice(0, 7) ?? "#ffe098";
  const foreground = contrastRatio(background, "#000000") >= contrastRatio(background, "#ffffff") ? "#000000" : "#ffffff";
  highlightStyle.textContent = `::highlight(leaflogue-saved){background:${background};color:${foreground}}`;
}
