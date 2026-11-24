import { describe, expect, it } from "vitest";
import { isMonochrome, remapLightness } from "./pdf-pages";

const pixels = (...rgb: [number, number, number][]) => Uint8ClampedArray.from(rgb.flatMap(([r, g, b]) => [r, g, b, 255]));

describe("PDF page toning", () => {
  it("treats scans and line art as monochrome but keeps colour artwork", () => {
    const scan = pixels(...Array.from({ length: 100 }, (_, i) => [i % 2 ? 255 : 20, i % 2 ? 255 : 20, i % 2 ? 255 : 22] as [number, number, number]));
    expect(isMonochrome(scan)).toBe(true);
    const photo = pixels(...Array.from({ length: 100 }, (_, i) => (i % 3 ? [200, 40, 30] : [255, 255, 255]) as [number, number, number]));
    expect(isMonochrome(photo)).toBe(false);
  });

  it("maps white to paper and black to ink", () => {
    const px = pixels([255, 255, 255], [0, 0, 0]);
    remapLightness(px, [18, 20, 24], [230, 225, 215]);
    expect(Array.from(px.slice(0, 3))).toEqual([18, 20, 24]);
    expect(Array.from(px.slice(4, 7))).toEqual([230, 225, 215]);
  });
});
