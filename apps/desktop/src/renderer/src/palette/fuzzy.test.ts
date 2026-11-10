import { describe, expect, it } from "vitest";
import { fuzzyScore, scoreWord } from "./fuzzy";

describe("fuzzy scoring", () => {
  it("ranks an exact title over a prefix, a word start, and letters in order", () => {
    const exact = scoreWord("piranesi", "piranesi")!;
    const prefix = scoreWord("pira", "piranesi")!;
    const word = scoreWord("house", "the house of tides")!;
    const inside = scoreWord("ouse", "the house of tides")!;
    const scattered = scoreWord("prns", "piranesi")!;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(inside);
    expect(inside).toBeGreaterThan(scattered);
  });

  it("needs every word to match one of the fields", () => {
    const fields = [{ text: "Piranesi" }, { text: "Susanna Clarke", weight: 0.7 }];
    expect(fuzzyScore("clarke pira", fields)).toBeGreaterThan(0);
    expect(fuzzyScore("clarke norrell", fields)).toBeUndefined();
  });

  it("ignores case and accents", () => {
    expect(fuzzyScore("bronte", [{ text: "Charlotte Brontë" }])).toBeGreaterThan(0);
  });

  it("refuses letters scattered too far apart", () => {
    expect(scoreWord("ab", "a very long title that eventually has b")).toBeUndefined();
  });

  it("weighs a match in a secondary field below the same match in the title", () => {
    expect(fuzzyScore("dark", [{ text: "Dark mode" }])).toBeGreaterThan(fuzzyScore("dark", [{ text: "Appearance" }, { text: "dark", weight: 0.5 }])!);
  });
});
