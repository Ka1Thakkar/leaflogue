import { describe, expect, it } from "vitest";
import { bookPositions, bookTimeline } from "./book-charts";

const at = (day: string, hour = 12) => new Date(`${day}T${String(hour).padStart(2, "0")}:00:00`).getTime();

describe("book charts", () => {
  it("draws one bar per day across a short span, gaps included, and marks the busiest", () => {
    const timeline = bookTimeline([
      { createdAt: 0, sourceCreatedAt: at("2026-08-31") },
      { createdAt: 0, sourceCreatedAt: at("2026-08-31", 20) },
      { createdAt: 0, sourceCreatedAt: at("2026-09-02") },
    ]);
    expect(timeline?.unit).toBe("day");
    expect(timeline?.bars.map(({ value }) => value)).toEqual([2, 0, 1]);
    expect(timeline?.bars[0]?.highlight).toBe(true);
    expect(timeline).toMatchObject({ activeDays: 2, firstDay: "2026-08-31", lastDay: "2026-09-02", busiest: 2 });
  });

  it("switches to months when the span runs past a month", () => {
    const timeline = bookTimeline([{ createdAt: at("2026-01-05") }, { createdAt: at("2026-03-20") }]);
    expect(timeline?.unit).toBe("month");
    expect(timeline?.bars.map(({ value }) => value)).toEqual([1, 0, 1]);
  });

  it("places passages in tenths only when most of them carry a position", () => {
    const placed = bookPositions([
      { createdAt: 0, sourceLocation: "Part 1 · 3%" },
      { createdAt: 0, sourceLocation: "Part 3 · 63%" },
      { createdAt: 0, sourceLocation: "span#kobo\\.1" },
    ]);
    expect(placed?.placed).toBe(2);
    expect(placed?.bars.map(({ value }) => value)).toEqual([1, 0, 0, 0, 0, 0, 1, 0, 0, 0]);
    expect(bookPositions([{ createdAt: 0, sourceLocation: "Page 4" }, { createdAt: 0, sourceLocation: "12%" }, { createdAt: 0 }])).toBeUndefined();
  });
});
