import { describe, expect, it } from "vitest";
import { buildPublicationSnapshot, isPublicationId, isReporterKey, newPublicationId, PUBLICATION_LIMITS, validReportDetails } from "./publications";

describe("public links", () => {
  it("freezes the passage, book, and chosen notes, marking AI notes", () => {
    expect(buildPublicationSnapshot({
      passage: "  Every pane held a season. ",
      bookTitle: " ",
      authors: ["Imogen Vale", " "],
      notes: [{ markdown: "Mine.", origin: "reader" }, { markdown: "An explanation.", origin: "ai" }, { markdown: "  " }],
    })).toEqual({
      passage: "Every pane held a season.",
      bookTitle: "Untitled book",
      authors: ["Imogen Vale"],
      notes: [{ markdown: "Mine.", ai: false }, { markdown: "An explanation.", ai: true }],
    });
  });

  it("refuses empty or oversized material rather than cutting it", () => {
    expect(() => buildPublicationSnapshot({ passage: " ", bookTitle: "B", authors: [], notes: [] })).toThrow("no text");
    expect(() => buildPublicationSnapshot({ passage: "x".repeat(PUBLICATION_LIMITS.passageBytes + 1), bookTitle: "B", authors: [], notes: [] })).toThrow("too long");
    expect(() => buildPublicationSnapshot({ passage: "x", bookTitle: "B", authors: [], notes: Array.from({ length: 21 }, () => ({ markdown: "n" })) })).toThrow("at most 20");
  });

  it("makes unguessable addresses and checks report input", () => {
    const ids = new Set(Array.from({ length: 50 }, newPublicationId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(isPublicationId(id)).toBe(true);
    expect(isPublicationId("short")).toBe(false);
    expect(isReporterKey("a".repeat(20))).toBe(true);
    expect(isReporterKey("bad key!")).toBe(false);
    expect(validReportDetails("  ")).toBeUndefined();
    expect(() => validReportDetails("x".repeat(2_001))).toThrow("too long");
  });
});
