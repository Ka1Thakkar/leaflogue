import { describe, expect, it } from "vitest";
import { lookupWord, normalizeDictionaryWord } from "./dictionary";

describe("bundled offline dictionary", () => {
  it("reads real WordNet definitions, parts of speech, and synonyms", async () => {
    const result = await lookupWord("Serendipity");
    expect(result.word).toBe("serendipity");
    expect(result.definitions.some(entry => entry.definition.includes("fortunate"))).toBe(true);
    const read = await lookupWord("read");
    expect(new Set(read.definitions.map(entry => entry.partOfSpeech))).toContain("verb");
    expect(read.definitions.every(entry => entry.definition.length > 0)).toBe(true);
    const happy = await lookupWord("happy");
    expect(happy.definitions.some(entry => entry.synonyms.length > 0)).toBe(true);
  });
  it("supports exact phrases and regular inflections without fuzzy guesses", async () => {
    expect((await lookupWord("books")).word).toBe("book");
    expect((await lookupWord("running")).definitions.length).toBeGreaterThan(0);
    expect((await lookupWord("look up")).definitions.length).toBeGreaterThan(0);
    expect((await lookupWord("zzzznotaword")).definitions).toEqual([]);
  });
  it("bounds and normalizes untrusted renderer requests before touching the files", () => {
    expect(normalizeDictionaryWord("  Free   Will  ")).toBe("free_will");
    for (const value of [null, {}, "", "a".repeat(81), "../data.noun", "<script>"] ) {
      expect(() => normalizeDictionaryWord(value)).toThrow();
    }
  });
});
