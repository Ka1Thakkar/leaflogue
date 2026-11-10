import type { ReactNode } from "react";
import type { DashboardId, DashboardWidgetId, DashboardWidth, LibraryPassageStatistic, LibraryProgressStatistic, LibraryStatistics } from "@leaflogue/contracts";
import { Bars, FillHeatmap, Meter, Panel, Ranked, StatTile, type Bar } from "@leaflogue/ui";
import { href } from "../../router";
import { DailyHighlight } from "../DailyHighlight";
import { countOf } from "../shared";
import { formatDay, parseDay, type ReadingSummary } from "../reading-summary";
import styles from "./dashboard.module.css";

export interface WidgetContext {
  readonly dashboard: DashboardId;
  readonly statistics: LibraryStatistics;
  readonly summary?: ReadingSummary;
  readonly width: DashboardWidth;
  readonly tall: boolean;
}

export interface WidgetDefinition {
  readonly title: string;
  /** One line for the list of widgets to add. */
  readonly description: string;
  /** Keep the panel's own height instead of matching its row, e.g. a quote beside a list. */
  readonly natural?: boolean;
  /** Nothing to show for this library: hidden on the page, a placeholder while customising. */
  readonly render: (context: WidgetContext) => ReactNode | null;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const WEEKDAY_NAMES = ["Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"] as const;
const LENGTHS = ["≤100", "101–300", "301–600", "600+"] as const;
const LENGTH_NAMES = ["Up to 100", "101 to 300", "301 to 600", "Over 600"] as const;

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function weekdayBars(days: LibraryStatistics["days"]): Bar[] {
  const totals = [0, 0, 0, 0, 0, 0, 0];
  for (const { day, highlights } of days) totals[(parseDay(day).getDay() + 6) % 7]! += highlights;
  const max = Math.max(...totals);
  return totals.map((value, index) => ({ label: WEEKDAYS[index]!, detail: WEEKDAY_NAMES[index]!, value, highlight: max > 0 && value === max }));
}

function monthBars(months: LibraryStatistics["highlightsByMonth"]): Bar[] {
  const max = Math.max(0, ...months.map(({ highlights }) => highlights));
  return months.map(({ month, highlights }) => ({
    label: new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "short", timeZone: "UTC" }),
    detail: new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" }),
    value: highlights,
    highlight: max > 0 && highlights === max,
  }));
}

/** One line of the coverage panel: how much of the library carries a kind of data. */
function Coverage({ label, have, of, unit, use }: { readonly label: string; readonly have: number; readonly of: number; readonly unit: string; readonly use: string }) {
  return (
    <li className={styles.coverage}>
      <div><span>{label}</span><span className="ui-number">{have.toLocaleString()} of {of.toLocaleString()} {of === 1 ? unit : `${unit}s`}</span></div>
      <Meter value={have} max={of} tone={have >= of ? "good" : "mark"} />
      <span className="ui-sub">{use}</span>
    </li>
  );
}

/** How long a book has gone without a passage before it counts as set aside. */
const QUIET_DAYS = 30;

function daysSince(day: string): number {
  return Math.round((parseDay(today()).getTime() - parseDay(day).getTime()) / 86_400_000);
}

/** "today", "yesterday", "5 days ago", "3 months ago", "2 years ago". */
function ago(day: string): string {
  const days = daysSince(day);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (days < 30) return format.format(-days, "day");
  if (days < 365) return format.format(-Math.round(days / 30.4), "month");
  return format.format(-Math.round(days / 365.25), "year");
}

function hourName(hour: number): string {
  const time = (value: number) => new Date(2000, 0, 1, value % 24).toLocaleTimeString(undefined, { hour: "numeric" });
  return `${time(hour)} – ${time(hour + 1)}`;
}

function timeOfDay(hour: number): string {
  if (hour < 5) return "late at night";
  if (hour < 12) return "in the morning";
  if (hour < 17) return "in the afternoon";
  if (hour < 21) return "in the evening";
  return "at night";
}

/** A short list of passages, each opening its place on the book's page. */
function Passages({ passages, label }: { readonly passages: readonly LibraryPassageStatistic[]; readonly label: (passage: LibraryPassageStatistic) => string }) {
  return (
    <ul className={styles.passages}>
      {passages.map((passage) => (
        <li key={passage.highlightId}>
          <blockquote>{passage.text}</blockquote>
          <span className="ui-sub"><a href={href.book(passage.bookId, passage.highlightId)}>{passage.title}</a> · {label(passage)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Books being read or set aside, with when each last had a passage. */
function Progress({ books, quote }: { readonly books: readonly LibraryProgressStatistic[]; readonly quote: boolean }) {
  return (
    <ul className={styles.progress}>
      {books.map((book) => (
        <li key={book.bookId}>
          <div>
            <a href={book.latest ? href.book(book.bookId, book.latest.highlightId) : href.book(book.bookId)}>{book.title}</a>
            {book.status === "paused" && <span className={styles.badge}>paused</span>}
          </div>
          <span className="ui-sub">
            {book.authors.length > 0 && <>{book.authors.join(", ")} · </>}
            {book.lastDay ? `last passage ${ago(book.lastDay)}` : "no passages yet"}
            {book.highlights > 0 && <> · {countOf(book.highlights, "passage")}</>}
          </span>
          {quote && book.latest && <blockquote>{book.latest.text}</blockquote>}
        </li>
      ))}
    </ul>
  );
}

function sub(text: string): ReactNode {
  return <span className="ui-sub">{text}</span>;
}

export const WIDGETS: Readonly<Record<DashboardWidgetId, WidgetDefinition>> = {
  passages: {
    title: "Passages",
    description: "How many passages you have kept",
    render: ({ statistics, summary }) => {
      const top = summary?.topBook;
      return <StatTile label="Passages" value={statistics.totals.highlights.toLocaleString()} sub={top ? `top: ${top.title} · ${top.highlights.toLocaleString()}` : undefined} />;
    },
  },
  notes: {
    title: "Notes",
    description: "How many notes you have written",
    render: ({ statistics, summary }) => {
      const top = summary?.topNotes;
      return <StatTile label="Notes" tone="mark" value={statistics.totals.notes.toLocaleString()} sub={top ? `top: ${top.title} · ${top.notes.toLocaleString()}` : undefined} />;
    },
  },
  books: {
    title: "Books on your shelf",
    description: "Books, authors, and what you are reading now",
    render: ({ statistics }) => {
      const authors = new Set(statistics.books.flatMap(({ authors }) => authors)).size;
      return <StatTile label="Books on your shelf" value={statistics.totals.books.toLocaleString()} sub={`${countOf(authors, "author")} · ${statistics.totals.reading.toLocaleString()} reading`} />;
    },
  },
  finished: {
    title: "Finished",
    description: "Books you have marked finished",
    render: ({ statistics }) => <StatTile label="Finished" tone="good" value={statistics.totals.finished.toLocaleString()} sub={`of ${countOf(statistics.totals.books, "book")}`} />,
  },
  "active-days": {
    title: "Active days",
    description: "Days you highlighted something",
    render: ({ summary }) => summary ? <StatTile label="Active days" value={summary.activeDays.toLocaleString()} sub={`of ${summary.spanDays.toLocaleString()} days in range`} /> : null,
  },
  "longest-run": {
    title: "Longest run",
    description: "Most days in a row with a highlight",
    render: ({ summary }) => summary ? <StatTile label="Longest run" tone="mark" value={`${summary.longestRun}d`} sub="days in a row" /> : null,
  },
  "busiest-day": {
    title: "Busiest day",
    description: "The day you highlighted the most",
    render: ({ summary }) => summary
      ? <StatTile label="Busiest day" value={summary.busiest.highlights.toLocaleString()} sub={formatDay(summary.busiest.day, { month: "short", day: "numeric", year: "numeric" })} />
      : null,
  },
  activity: {
    title: "Activity",
    description: "A calendar of passages per day",
    render: ({ statistics, width }) => {
      if (statistics.days.length === 0) return null;
      const days = statistics.days.map(({ day, highlights }) => ({ day, value: highlights }));
      const { highlightsDated } = statistics.coverage;
      const { highlights } = statistics.totals;
      if (width !== "full") {
        return (
          <Panel title="Activity" actions={sub("passages per day")} padded>
            <FillHeatmap title="Passages per day" days={days} cell={18} />
          </Panel>
        );
      }
      return (
        <Panel
          title={<h2 className="ui-label">Activity <span className={styles.caption}>passages per day · {highlightsDated === highlights ? `all ${highlights.toLocaleString()} have a highlight date` : `${highlightsDated.toLocaleString()} of ${highlights.toLocaleString()} have a highlight date; the rest count on the day they were added`}</span></h2>}
          padded
        >
          <FillHeatmap title="Passages per day over the last year" days={days} through={today()} weeks={53} />
        </Panel>
      );
    },
  },
  "top-books": {
    title: "Most highlighted books",
    description: "The books you have highlighted most",
    render: ({ statistics, dashboard, tall }) => (
      <Panel title="Most highlighted" actions={dashboard === "library" ? <a className="ui-sub" href={href.statistics()}>All statistics</a> : undefined} padded>
        {statistics.books.length === 0 ? <p className="ll-muted">No highlights yet.</p> : (
          <Ranked numbered entries={statistics.books.slice(0, tall ? 10 : 6).map((book) => ({ key: book.bookId, label: book.title, value: book.highlights, href: href.book(book.bookId) }))} />
        )}
      </Panel>
    ),
  },
  "top-authors": {
    title: "Most highlighted authors",
    description: "The authors you have highlighted most",
    render: ({ statistics, tall }) => (
      <Panel title="Most highlighted authors" padded>
        {statistics.topAuthors.length === 0 ? <p className="ll-muted">No highlights yet.</p> : (
          <Ranked numbered entries={statistics.topAuthors.slice(0, tall ? 10 : 6).map((author) => ({ key: author.name, label: <>{author.name} <span className="ui-sub">{countOf(author.books, "book")}</span></>, value: author.highlights }))} />
        )}
      </Panel>
    ),
  },
  months: {
    title: "Highlights by month",
    description: "Passages in each of the last twelve months",
    render: ({ statistics }) => {
      const months = monthBars(statistics.highlightsByMonth);
      const busiest = months.find(({ highlight }) => highlight);
      return (
        <Panel title="Highlights by month" actions={busiest ? sub(`${busiest.label} was busiest`) : undefined} padded>
          <Bars title="Highlights in the last twelve months" bars={months} height={130} unit="passage" share />
        </Panel>
      );
    },
  },
  weekdays: {
    title: "By weekday",
    description: "Which days of the week you read most",
    render: ({ statistics }) => {
      const weekdays = weekdayBars(statistics.days);
      const leading = weekdays.findIndex(({ highlight }) => highlight);
      return (
        <Panel title="By weekday" actions={leading >= 0 ? sub(`${WEEKDAY_NAMES[leading]} lead`) : undefined} padded>
          <Bars title="Passages by weekday" bars={weekdays} height={130} unit="passage" share />
        </Panel>
      );
    },
  },
  coverage: {
    title: "What these numbers use",
    description: "How much of your library has dates and series",
    render: ({ statistics }) => (
      <Panel title="What these numbers use" actions={sub("from your readers' files")} padded>
        <ul className={styles.coverageList}>
          <Coverage label="Highlight date" have={statistics.coverage.highlightsDated} of={statistics.totals.highlights} unit="passage" use="used by the activity, month, and weekday charts" />
          <Coverage label="Series" have={statistics.coverage.booksWithSeries} of={statistics.totals.books} unit="book" use="used by the series panel" />
          <Coverage label="Finish date" have={statistics.coverage.finishedDated} of={statistics.totals.finished} unit="finished book" use="used by books finished each year" />
        </ul>
      </Panel>
    ),
  },
  lengths: {
    title: "Passage length",
    description: "How long the passages you keep are",
    render: ({ statistics }) => {
      const max = Math.max(...statistics.lengths);
      return (
        <Panel title="Passage length" actions={sub(`average ${statistics.averageLength.toLocaleString()} characters`)} padded>
          <Bars title="Passages by length in characters" height={90} unit="passage" share bars={statistics.lengths.map((value, index) => ({ label: LENGTHS[index]!, detail: `${LENGTH_NAMES[index]!} characters`, value, highlight: value === max && value > 0 }))} />
        </Panel>
      );
    },
  },
  "finished-years": {
    title: "Books finished each year",
    description: "Finished books by the year you finished them",
    render: ({ statistics }) => {
      const undated = statistics.totals.finished - statistics.coverage.finishedDated;
      return (
        <Panel title="Books finished each year" actions={sub("by finish date")} padded>
          {statistics.coverage.finishedDated === 0 ? (
            <p className="ui-sub">No finished book has a finish date yet.</p>
          ) : (
            <Bars title="Books finished each year" height={70} unit="book" bars={statistics.finishedByYear.map(({ year, books }) => ({ label: String(year), detail: `Finished in ${year}`, value: books }))} />
          )}
          {undated > 0 && (
            <p className={`ui-sub ${styles.note}`}>{countOf(undated, "finished book")} {undated === 1 ? "has" : "have"} no finish date. Add one from the book&apos;s page.</p>
          )}
        </Panel>
      );
    },
  },
  series: {
    title: "Series",
    description: "Your series and how far through each you are",
    natural: true,
    render: ({ statistics, tall }) => {
      if (statistics.series.length === 0) return null;
      return (
        <Panel title="Series" padded>
          <ul className={styles.series}>
            {statistics.series.slice(0, tall ? 8 : 3).map((entry, index) => (
              <li key={entry.name} data-tone={index % 2 ? "good" : "chart"}>
                <div><span>{entry.name}</span><span className="ui-number">{entry.highlights.toLocaleString()}</span></div>
                <div className={styles.seriesBooks} aria-hidden="true">
                  {Array.from({ length: Math.min(entry.books, 12) }, (_, book) => <i key={book} data-finished={book < entry.finished ? "" : undefined} />)}
                </div>
                <span className="ui-sub">{countOf(entry.books, "book")} · {entry.finished === entry.books ? "all finished" : `${entry.finished} finished`}</span>
              </li>
            ))}
          </ul>
        </Panel>
      );
    },
  },
  "on-this-day": {
    title: "On this day",
    description: "Passages you highlighted on this date in earlier years",
    natural: true,
    render: ({ statistics, tall }) => {
      if (statistics.coverage.highlightsDated === 0) return null;
      const date = formatDay(today(), { month: "long", day: "numeric" });
      return (
        <Panel title="On this day" actions={sub(date)} padded>
          {statistics.onThisDay.length === 0
            ? <p className="ui-sub">Nothing you highlighted on {date} in earlier years. Another day may bring something back.</p>
            : <Passages passages={statistics.onThisDay.slice(0, tall ? 6 : 3)} label={({ day }) => `${day.slice(0, 4)}, ${ago(day)}`} />}
        </Panel>
      );
    },
  },
  "reading-now": {
    title: "Currently reading",
    description: "The books you are reading and their latest passage",
    natural: true,
    render: ({ statistics, tall, width }) => {
      const reading = statistics.inProgress.filter(({ status }) => status === "reading");
      if (reading.length === 0) return null;
      const shown = reading.slice(0, tall ? 8 : 4);
      return (
        <Panel title="Currently reading" actions={sub(countOf(reading.length, "book"))} padded>
          <Progress books={shown} quote={tall || width === "full" || width === "two-thirds"} />
        </Panel>
      );
    },
  },
  hours: {
    title: "Time of day",
    description: "The hours you highlight in",
    render: ({ statistics }) => {
      const total = statistics.hours.reduce((sum, value) => sum + value, 0);
      if (total === 0) return null;
      const max = Math.max(...statistics.hours);
      const peak = statistics.hours.indexOf(max);
      const bars = statistics.hours.map((value, hour) => ({ label: hour % 6 === 0 ? String(hour) : "", detail: hourName(hour), value, highlight: value === max }));
      return (
        <Panel title="Time of day" actions={sub(`mostly ${timeOfDay(peak)}`)} padded>
          <Bars title="Passages by the hour you highlighted them" bars={bars} height={110} gap={2} showValues={false} unit="passage" share />
          {total < statistics.totals.highlights && (
            <p className={`ui-sub ${styles.note}`}>{total.toLocaleString()} of {countOf(statistics.totals.highlights, "passage")} have a highlight time.</p>
          )}
        </Panel>
      );
    },
  },
  recent: {
    title: "Recently kept",
    description: "The last passages you highlighted",
    natural: true,
    render: ({ statistics, tall }) => statistics.recent.length === 0 ? null : (
      <Panel title="Recently kept" actions={<a className="ui-sub" href={href.highlights()}>All highlights</a>} padded>
        <Passages passages={statistics.recent.slice(0, tall ? 8 : 4)} label={({ day }) => ago(day)} />
      </Panel>
    ),
  },
  "pick-up": {
    title: "Pick back up",
    description: "Paused books, and books you have not highlighted in a month",
    natural: true,
    render: ({ statistics, tall }) => {
      if (statistics.inProgress.length === 0) return null;
      const waiting = statistics.inProgress
        .filter((book) => book.status === "paused" || !book.lastDay || daysSince(book.lastDay) >= QUIET_DAYS)
        .sort((a, b) => (a.lastDay ?? "").localeCompare(b.lastDay ?? "") || a.title.localeCompare(b.title));
      return (
        <Panel title="Pick back up" actions={waiting.length > 0 ? sub(countOf(waiting.length, "book")) : undefined} padded>
          {waiting.length === 0
            ? <p className="ui-sub">Nothing waiting: every book you are reading has a passage from the last month.</p>
            : <Progress books={waiting.slice(0, tall ? 8 : 4)} quote={false} />}
        </Panel>
      );
    },
  },
  daily: {
    title: "Today's highlight",
    description: "One passage picked for you each day",
    natural: true,
    render: ({ statistics }) => statistics.totals.highlights > 0 ? <DailyHighlight /> : null,
  },
};
