import { describe, expect, it } from "vitest";
import { DEFAULT_READER_PREFERENCES, validateReaderPreferences } from "./reader-preferences";

describe("persisted reader preference boundary", () => {
  it("rejects invalid choices and non-finite values from stale or edited storage", () => {
    expect(validateReaderPreferences({ size: Infinity, weight: NaN, columns: "url(javascript:alert(1))", alignment: {}, dark: "false" })).toEqual(DEFAULT_READER_PREFERENCES);
    expect(validateReaderPreferences(null)).toEqual(DEFAULT_READER_PREFERENCES);
  });
  it("bounds values so edited preferences cannot overflow the reader or inject CSS", () => {
    const value = validateReaderPreferences({ size: 900, horizontal: -50, letter: "1em;color:red", width: 0, weight: -800 });
    expect(value.size).toBe(48); expect(value.horizontal).toBe(8); expect(value.width).toBe(30); expect(value.weight).toBe(0); expect(value.letter).toBe(0);
  });
});
