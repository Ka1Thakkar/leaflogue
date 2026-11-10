import type { Bar } from "@leaflogue/ui";
import { passagePosition } from "@leaflogue/domain";
import { formatDay, parseDay } from "./reading-summary";

interface Dated { readonly createdAt: number; readonly sourceCreatedAt?: number; readonly sourceLocation?: string }

function dayKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export interface BookTimeline {
  readonly bars: readonly Bar[];
  /** "per day" or "per month", for the chart's caption. */
  readonly unit: "day" | "month";
  readonly firstDay: string;
  readonly lastDay: string;
  readonly activeDays: number;
  readonly busiest: number;
}

/**
 * When a book's passages were highlighted: one bar per day across a short
 * span (gaps included), or one per month when the span runs past a month.
 */
export function bookTimeline(highlights: readonly Dated[]): BookTimeline | undefined {
  if (highlights.length === 0) return undefined;
  const days = new Map<string, number>();
  for (const highlight of highlights) {
    const key = dayKey(highlight.sourceCreatedAt ?? highlight.createdAt);
    days.set(key, (days.get(key) ?? 0) + 1);
  }
  const sorted = [...days.keys()].sort();
  const firstDay = sorted[0]!;
  const lastDay = sorted.at(-1)!;
  const busiest = Math.max(...days.values());
  const span = Math.round((parseDay(lastDay).getTime() - parseDay(firstDay).getTime()) / 86_400_000) + 1;
  if (span <= 31) {
    const bars: Bar[] = [];
    const cursor = parseDay(firstDay);
    for (let index = 0; index < span; index += 1) {
      const key = dayKey(cursor.getTime());
      const value = days.get(key) ?? 0;
      bars.push({
        label: span <= 10 ? formatDay(key, { weekday: "short", day: "numeric" }) : String(cursor.getDate()),
        detail: formatDay(key, { weekday: "long", day: "numeric", month: "long", year: "numeric" }),
        value,
        highlight: value === busiest,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    return { bars, unit: "day", firstDay, lastDay, activeDays: days.size, busiest };
  }
  const months = new Map<string, number>();
  for (const [day, count] of days) months.set(day.slice(0, 7), (months.get(day.slice(0, 7)) ?? 0) + count);
  const bars: Bar[] = [];
  const cursor = parseDay(`${firstDay.slice(0, 7)}-01`);
  const end = parseDay(`${lastDay.slice(0, 7)}-01`);
  const monthBusiest = Math.max(...months.values());
  while (cursor <= end && bars.length < 36) {
    const key = dayKey(cursor.getTime()).slice(0, 7);
    const value = months.get(key) ?? 0;
    bars.push({ label: cursor.toLocaleDateString(undefined, { month: "short" }), detail: cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" }), value, highlight: value === monthBusiest });
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return { bars, unit: "month", firstDay, lastDay, activeDays: days.size, busiest };
}

/**
 * Where in the book passages sit, in tenths, for passages whose importer
 * recorded a position. Undefined when fewer than half have one, since a
 * partial picture would mislead.
 */
export function bookPositions(highlights: readonly Dated[]): { readonly bars: readonly Bar[]; readonly placed: number } | undefined {
  const positions = highlights.map(({ sourceLocation }) => passagePosition(sourceLocation)).filter((value): value is number => value !== undefined);
  if (positions.length === 0 || positions.length < highlights.length / 2) return undefined;
  const bins = Array.from({ length: 10 }, () => 0);
  for (const position of positions) bins[Math.min(9, Math.floor(position * 10))]! += 1;
  const max = Math.max(...bins);
  return {
    bars: bins.map((value, index) => ({ label: `${index * 10}%`, detail: `${index * 10}–${index * 10 + 10}% through the book`, value, highlight: value === max })),
    placed: positions.length,
  };
}
