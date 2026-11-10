import type { LibraryBookStatistics, LibraryStatistics } from "@leaflogue/contracts";

/** A local calendar day (`YYYY-MM-DD`) as a date at local midnight. */
export function parseDay(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year!, (month ?? 1) - 1, date ?? 1);
}

export function formatDay(day: string, options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }): string {
  return parseDay(day).toLocaleDateString(undefined, options);
}

const DAY = 86_400_000;

function daysBetween(first: string, last: string): number {
  return Math.round((parseDay(last).getTime() - parseDay(first).getTime()) / DAY) + 1;
}

export interface ReadingSummary {
  /** "Jul 20 – Sep 25, 2026", from the first to the last day with a passage. */
  readonly range: string;
  readonly activeDays: number;
  readonly spanDays: number;
  readonly longestRun: number;
  readonly busiest: { readonly day: string; readonly highlights: number };
  readonly topBook?: LibraryBookStatistics;
  readonly topNotes?: LibraryBookStatistics;
}

/** The headline figures for the library overview, all derived from passage days. */
export function readingSummary(statistics: LibraryStatistics): ReadingSummary | undefined {
  const days = statistics.days;
  if (days.length === 0) return undefined;
  const first = days[0]!.day;
  const last = days.at(-1)!.day;
  let longestRun = 0;
  let run = 0;
  let previous: string | undefined;
  for (const { day } of days) {
    run = previous !== undefined && daysBetween(previous, day) === 2 ? run + 1 : 1;
    longestRun = Math.max(longestRun, run);
    previous = day;
  }
  const busiest = days.reduce((best, entry) => entry.highlights > best.highlights ? entry : best, days[0]!);
  const sameYear = first.slice(0, 4) === last.slice(0, 4);
  const range = first === last
    ? formatDay(first, { month: "short", day: "numeric", year: "numeric" })
    : `${formatDay(first, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" })} – ${formatDay(last, { month: "short", day: "numeric", year: "numeric" })}`;
  const topBook = statistics.books[0];
  const topNotes = [...statistics.books].sort((a, b) => b.notes - a.notes)[0];
  return {
    range,
    activeDays: days.length,
    spanDays: daysBetween(first, last),
    longestRun,
    busiest,
    ...(topBook && topBook.highlights > 0 ? { topBook } : {}),
    ...(topNotes && topNotes.notes > 0 ? { topNotes } : {}),
  };
}
