import { MAX_HIGHLIGHT_PAGE, type HighlightListEntry, type HighlightPage, type HighlightQuery } from "@leaflogue/contracts";
import { BackendError } from "../transport/transport";
import type { LibraryClient, Page } from "./client";
import { toHighlightEntry, type WirePassage } from "./wire";

/**
 * The interface asks for passages by offset; `browse:highlights` pages by
 * cursor, and a Convex page can hold fewer items than asked while more
 * remain. So each query keeps the passages read so far and its next cursor:
 * "load more" continues where the last read stopped, and a read from the
 * start begins afresh, which is how the interface refreshes after a change.
 */

const BROWSE_PAGE = 50;
const DEFAULT_LIMIT = 50;
const KEPT_QUERIES = 8;
const LOCAL_DAY_MS = { shortest: 23 * 60 * 60 * 1000, longest: 25 * 60 * 60 * 1000 };

interface Stream {
  readonly items: HighlightListEntry[];
  cursor: string | null;
  done: boolean;
  /** Read with the older UTC-date argument, for a backend that predates exact bounds. */
  legacy: boolean;
  /** Reads run one after another so two "load more"s never skip a page. */
  tail: Promise<void>;
}

interface Translated {
  /** Arguments with exact date bounds (`dateFrom`/`dateBefore`). */
  readonly args: Record<string, unknown>;
  /**
   * The same query for a backend from before exact bounds, which refuses
   * them: it takes one UTC calendar `date`, so passages from the hours a
   * local day does not share with it are missed.
   */
  readonly legacyArgs: Record<string, unknown>;
  /** What the backend cannot filter exactly, checked here. */
  readonly keep: (passage: WirePassage) => boolean;
}

function calendarDate(timestamp: number): string {
  const day = new Date(timestamp);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

export function translateHighlightQuery(query: HighlightQuery): Translated {
  const search = query.search?.trim();
  const from = query.dateFrom ?? Number.NEGATIVE_INFINITY;
  const before = query.dateBefore ?? Number.POSITIVE_INFINITY;
  const dated = query.dateFrom !== undefined || query.dateBefore !== undefined;
  const imported = query.dateKind === "imported";
  // The backend filters by the exact span the interface asks for, such as
  // one local day: [its local midnight, the next local midnight).
  const base: Record<string, unknown> = {
    ...(query.bookId ? { bookId: query.bookId } : {}),
    ...(search ? { search } : {}),
    ...(query.tagId ? { tagId: query.tagId } : {}),
    ...(query.notes ? { notes: query.notes } : {}),
    ...(query.source ? { source: query.source === "manual" ? "typed" : "imported" } : {}),
    ...(query.sort ? { sort: query.sort } : {}),
  };
  const args: Record<string, unknown> = {
    ...base,
    ...(query.dateFrom !== undefined ? { dateFrom: query.dateFrom } : {}),
    ...(query.dateBefore !== undefined ? { dateBefore: query.dateBefore } : {}),
    ...(dated ? { dateKind: imported ? "imported" : "added" } : {}),
  };
  // An older backend filters by one UTC calendar day, so it is given the
  // local day's date (the UTC day that overlaps it most) and the exact
  // bounds are checked here. Other ranges are only checked here.
  const span = before - from;
  const oneDay = Number.isFinite(span) && span >= LOCAL_DAY_MS.shortest && span <= LOCAL_DAY_MS.longest;
  const legacyArgs: Record<string, unknown> = {
    ...base,
    ...(oneDay ? { date: calendarDate(from), dateKind: imported ? "imported" : "added" } : {}),
  };
  const keep = (passage: WirePassage) => {
    if (!dated) return true;
    const at = imported ? passage.importedVersion?.lastImportedAt : passage.createdAt;
    return at !== undefined && at >= from && at < before;
  };
  return { args, legacyArgs, keep };
}

/**
 * Whether a refused first read may be a backend from before exact date
 * bounds. Such a backend refuses the unknown arguments: apps/server says the
 * request is invalid, and a production Convex deployment hides its argument
 * error behind an uncoded one.
 */
function mayPredateExactBounds(error: unknown): boolean {
  return error instanceof BackendError && (error.code === undefined || error.code === "LEAFLOGUE_REQUEST_INVALID");
}

export class HighlightPages {
  readonly #client: LibraryClient;
  readonly #streams = new Map<string, Stream>();
  /** Set once the backend has refused exact date bounds; later reads use its older form. */
  #legacyDates = false;

  constructor(client: LibraryClient) {
    this.#client = client;
  }

  async list(query: HighlightQuery): Promise<HighlightPage> {
    const offset = Math.max(0, Math.trunc(query.offset ?? 0));
    const limit = Math.min(MAX_HIGHLIGHT_PAGE, Math.max(1, Math.trunc(query.limit ?? DEFAULT_LIMIT)));
    const translated = translateHighlightQuery(query);
    const key = JSON.stringify(translated.args) + `|${query.dateFrom ?? ""}|${query.dateBefore ?? ""}`;
    let stream = this.#streams.get(key);
    if (!stream || offset === 0) {
      stream = { items: [], cursor: null, done: false, legacy: this.#legacyDates, tail: Promise.resolve() };
      this.#streams.delete(key);
      this.#streams.set(key, stream);
      for (const stale of this.#streams.keys()) {
        if (this.#streams.size <= KEPT_QUERIES) break;
        this.#streams.delete(stale);
      }
    }
    // One more than asked, so `hasMore` is exact.
    await this.#fill(stream, translated, offset + limit + 1);
    return {
      entries: stream.items.slice(offset, offset + limit),
      hasMore: stream.items.length > offset + limit || !stream.done,
    };
  }

  #fill(stream: Stream, translated: Translated, wanted: number): Promise<void> {
    const run = stream.tail.then(async () => {
      const read = (legacy: boolean) => this.#client.query<Page<WirePassage>>("browse:highlights", {
        ...(legacy ? translated.legacyArgs : translated.args),
        paginationOpts: { numItems: BROWSE_PAGE, cursor: stream.cursor },
      });
      const datedDiffers = JSON.stringify(translated.args) !== JSON.stringify(translated.legacyArgs);
      while (!stream.done && stream.items.length < wanted) {
        let result: Page<WirePassage>;
        try {
          result = await read(stream.legacy);
        } catch (error) {
          // A cursor belongs to the form it was read with, so only a first read falls back.
          if (stream.legacy || !datedDiffers || stream.cursor !== null || !mayPredateExactBounds(error)) throw error;
          try {
            result = await read(true);
          } catch {
            throw error;
          }
          stream.legacy = true;
          this.#legacyDates = true;
        }
        stream.items.push(...result.page.filter(translated.keep).map(toHighlightEntry));
        stream.cursor = result.continueCursor;
        stream.done = result.isDone;
      }
    });
    // A failed read leaves the stream where it was, for the next attempt.
    stream.tail = run.catch(() => undefined);
    return run;
  }
}
