import { useEffect, useState, type ReactNode } from "react";
import type { BookId, CustomWidget, WidgetCount, WidgetField, WidgetFilter, WidgetResult } from "@leaflogue/contracts";
import { WIDGET_FIELD_INFO } from "@leaflogue/domain";
import { Bars, FillHeatmap, Panel, Ranked, StatTile, type Bar } from "@leaflogue/ui";
import { href } from "../../router";
import { formatDay } from "../reading-summary";
import { authorsLabel, countOf, statusLabel } from "../shared";
import styles from "./dashboard.module.css";

export const COUNT_NOUNS: Readonly<Record<WidgetCount, string>> = { passages: "passage", books: "book", notes: "note" };

/** "tag is favourite", "year is this year". */
export function describeFilter(filter: WidgetFilter): string {
  const info = WIDGET_FIELD_INFO[filter.field];
  const value = "is" in filter ? filter.is : filter.isNot;
  const shown = value === "this-year" ? "this year" : value === "last-year" ? "last year" : info.values?.find(({ key }) => key === value)?.label ?? value;
  return `${info.label.toLowerCase()} ${"is" in filter ? "is" : "is not"} ${shown}`;
}

/** What a widget counts, in a couple of words: "passages by weekday". */
function headline(widget: CustomWidget): string {
  return widget.groupBy ? `${widget.count} by ${WIDGET_FIELD_INFO[widget.groupBy].label.toLowerCase()}` : widget.count;
}

/** What a widget counts, in full: "passages by weekday · tag is favourite". */
export function describeWidget(widget: CustomWidget): string {
  return [headline(widget), ...(widget.where ?? []).map(describeFilter)].join(" · ");
}

export type WidgetResultState = WidgetResult | "loading" | "failed";

/**
 * Count the given widgets over the library, again whenever the recipes or
 * the library's statistics change. Results come back by widget ID.
 */
export function useWidgetResults(widgets: readonly CustomWidget[], refresh: unknown): ReadonlyMap<string, WidgetResultState> {
  const key = JSON.stringify(widgets);
  const [results, setResults] = useState<{ key: string; refresh: unknown; values: ReadonlyMap<string, WidgetResultState> }>();
  useEffect(() => {
    const recipes = JSON.parse(key) as CustomWidget[];
    if (recipes.length === 0) return;
    let active = true;
    window.leaflogue.widgets.evaluate(recipes).then(
      (values) => { if (active) setResults({ key, refresh, values: new Map(recipes.map(({ id }, index) => [id, values[index] ?? "failed"])) }); },
      () => { if (active) setResults({ key, refresh, values: new Map(recipes.map(({ id }) => [id, "failed" as const])) }); },
    );
    return () => { active = false; };
  }, [key, refresh]);
  // Until this set of recipes has been counted, every one is loading.
  if (!results || results.key !== key || results.refresh !== refresh) {
    return new Map(widgets.map(({ id }) => [id, results?.values.get(id) ?? "loading"]));
  }
  return results.values;
}

function sub(text: string): ReactNode {
  return <span className="ui-sub">{text}</span>;
}

/** Long names would crowd a column's label; the hover card has the whole name. */
function short(label: string): string {
  return label.length > 9 ? `${label.slice(0, 8)}…` : label;
}

function hourName(hour: number): string {
  const time = (value: number) => new Date(2000, 0, 1, value % 24).toLocaleTimeString(undefined, { hour: "numeric" });
  return `${time(hour)} – ${time(hour + 1)}`;
}

function bars(widget: CustomWidget, result: Extract<WidgetResult, { kind: "groups" }>): Bar[] {
  const max = Math.max(0, ...result.groups.map(({ value }) => value));
  return result.groups.map(({ key, label, value }) => {
    const hour = widget.groupBy === "hour";
    return {
      label: hour ? (Number(key) % 6 === 0 ? key : "") : short(label),
      detail: hour ? hourName(Number(key)) : label,
      value,
      highlight: max > 0 && value === max,
    };
  });
}

/** "have a tag", "have a recorded time": what a grouped widget's note says the rest lack. */
function having(field: WidgetField): string {
  switch (field) {
    case "hour": return "a recorded time";
    case "finished-year": return "a known finish year";
    case "author": return "an author";
    case "tag": return "a tag";
    case "thread": return "a thread";
    default: return `a ${WIDGET_FIELD_INFO[field].label.toLowerCase()}`;
  }
}

function Message({ children }: { readonly children: ReactNode }) {
  return <p className="ui-sub">{children}</p>;
}

/** A custom widget drawn with the same charts as the built-in ones. */
export function CustomWidgetView({ widget, result, tall = false }: {
  readonly widget: CustomWidget;
  readonly result: WidgetResultState;
  readonly tall?: boolean;
}) {
  const unit = COUNT_NOUNS[widget.count];
  const summary = describeWidget(widget);
  if (widget.show === "number") {
    const value = typeof result === "string" ? "–" : result.kind === "number" ? result.value.toLocaleString() : "–";
    return <StatTile label={widget.title} value={value} sub={result === "failed" ? "could not be counted" : summary} />;
  }
  let body: ReactNode;
  let note: ReactNode = null;
  if (result === "loading") body = <Message>Counting…</Message>;
  else if (result === "failed") body = <Message>This widget could not be counted. Try again later, or edit it while customising.</Message>;
  else if (result.kind === "groups") {
    if (result.total === 0 || result.groups.every(({ value }) => value === 0)) {
      body = <Message>Nothing in your library matches this yet.</Message>;
    } else if (widget.show === "bars") {
      const crowded = result.groups.length > 12;
      body = <Bars title={widget.title} bars={bars(widget, result)} height={tall ? 260 : 130} gap={crowded ? 2 : 4} showValues={!crowded} unit={unit} share />;
    } else {
      const books = widget.groupBy === "book";
      body = <Ranked numbered entries={result.groups.map(({ key, label, value }) => ({ key, label, value, ...(books ? { href: href.book(key as BookId) } : {}) }))} />;
    }
    if (result.total > 0 && result.missing > 0) {
      note = <p className={`ui-sub ${styles.note}`}>{(result.total - result.missing).toLocaleString()} of {countOf(result.total, unit)} {result.total === 1 ? "has" : "have"} {having(widget.groupBy!)}.</p>;
    }
  } else if (result.kind === "days") {
    body = result.days.length === 0
      ? <Message>Nothing in your library matches this yet.</Message>
      : <FillHeatmap title={`${widget.title}, per day`} days={result.days} unit={unit} cell={18} />;
  } else if (result.kind === "items") {
    body = result.items.length === 0 ? <Message>Nothing in your library matches this yet.</Message> : (
      <ul className={styles.passages}>
        {result.items.map((item) => item.kind === "book" ? (
          <li key={item.bookId}>
            <a className={styles.itemTitle} href={href.book(item.bookId)}>{item.title}</a>
            <span className="ui-sub">{authorsLabel(item.authors)} · {statusLabel(item.status)}</span>
          </li>
        ) : (
          <li key={item.kind === "passage" ? item.highlightId : `${item.bookId}:${item.text}:${item.day}`}>
            <blockquote>{item.text}</blockquote>
            <span className="ui-sub"><a href={href.book(item.bookId, item.highlightId)}>{item.title}</a> · {formatDay(item.day, { month: "short", day: "numeric", year: "numeric" })}</span>
          </li>
        ))}
      </ul>
    );
    if (result.total > result.items.length) note = <p className={`ui-sub ${styles.note}`}>{widget.count === "books" ? "The first" : "The latest"} {result.items.length.toLocaleString()} of {countOf(result.total, unit)}.</p>;
  } else {
    body = <Message>This widget could not be counted.</Message>;
  }
  const filters = widget.where ?? [];
  return (
    <Panel title={widget.title} actions={sub(widget.description ?? headline(widget))} padded>
      {body}
      {note}
      {filters.length > 0 && <p className={`ui-sub ${styles.note}`}>Only where {filters.map(describeFilter).join(", and ")}.</p>}
    </Panel>
  );
}
