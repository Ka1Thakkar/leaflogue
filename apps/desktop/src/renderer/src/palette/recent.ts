/**
 * What the palette remembers: the last few things opened, run, or searched,
 * and how often and how lately each item was chosen, used to rank results.
 * Kept in this window's storage only; it never leaves the device, and losing
 * it only loses the convenience.
 */

const STORAGE_KEY = "leaflogue.palette";
export const RECENT_LIMIT = 8;
const USE_LIMIT = 200;

/** Enough to show and reopen a recent item without loading anything first. */
export interface RecentEntry {
  /** The item's key, such as `book:<id>`, `cmd:<id>`, or `search:<words>`. */
  readonly key: string;
  readonly title: string;
  readonly subtitle?: string;
  /** Where it opens, for books, passages, and pages. */
  readonly href?: string;
  readonly at: number;
}

interface Use {
  readonly count: number;
  readonly at: number;
}

interface Memory {
  readonly recent: readonly RecentEntry[];
  readonly uses: Readonly<Record<string, Use>>;
}

function isEntry(value: unknown): value is RecentEntry {
  const entry = value as RecentEntry;
  return typeof entry === "object" && entry !== null && typeof entry.key === "string" && typeof entry.title === "string" && typeof entry.at === "number"
    && (entry.href === undefined || (typeof entry.href === "string" && entry.href.startsWith("#/")));
}

export function readMemory(): Memory {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as { recent?: unknown; uses?: unknown } | null;
    const recent = Array.isArray(saved?.recent) ? saved.recent.filter(isEntry).slice(0, RECENT_LIMIT) : [];
    const uses: Record<string, Use> = {};
    if (saved?.uses && typeof saved.uses === "object") {
      for (const [key, use] of Object.entries(saved.uses as Record<string, unknown>)) {
        const { count, at } = (use ?? {}) as Partial<Use>;
        if (typeof count === "number" && typeof at === "number") uses[key] = { count, at };
      }
    }
    return { recent, uses };
  } catch {
    return { recent: [], uses: {} };
  }
}

function writeMemory(memory: Memory): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(memory));
  } catch {
    // Storage unavailable: the palette still works, it just forgets.
  }
}

/** Remember that an item was chosen: first in the recent list, and one more use. */
export function remember(entry: Omit<RecentEntry, "at">, now = Date.now()): void {
  const memory = readMemory();
  const recent = [{ ...entry, at: now }, ...memory.recent.filter(({ key }) => key !== entry.key)].slice(0, RECENT_LIMIT);
  const previous = memory.uses[entry.key];
  const uses = Object.entries({ ...memory.uses, [entry.key]: { count: (previous?.count ?? 0) + 1, at: now } })
    .sort(([, left], [, right]) => right.at - left.at)
    .slice(0, USE_LIMIT);
  writeMemory({ recent, uses: Object.fromEntries(uses) });
}

/** Forget everything the palette remembered. */
export function forgetRecent(): void {
  writeMemory({ recent: [], uses: {} });
}

const DAY = 24 * 60 * 60 * 1000;

/** Up to 15 extra points for something chosen often and lately. */
export function usageBoost(use: Use | undefined, now = Date.now()): number {
  if (!use) return 0;
  const age = now - use.at;
  const lately = age < DAY ? 8 : age < 7 * DAY ? 5 : age < 30 * DAY ? 2 : 0;
  return lately + Math.min(7, Math.log2(use.count + 1) * 2.5);
}
