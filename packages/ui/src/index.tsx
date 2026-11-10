import { useLayoutEffect, useRef, useState } from "react";
import { useChartTip } from "./tip";
import { Icon } from "./icons";
import type { AnchorHTMLAttributes, ComponentPropsWithoutRef, ComponentType, CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";

/**
 * The shared stat-sheet interface used by the Leaflogue desktop app and its
 * web apps. Components carry structure and accessibility; ui.css carries the
 * look, derived from whichever theme is active. Icons use the shared paths
 * and named adapters so both apps keep the same visual weight.
 */

function cx(...names: readonly (string | false | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

/**
 * How an app renders an in-app link. Plain anchors by default; a framework
 * passes its own (Next's `Link`, for example) so navigation stays client-side.
 */
export type LinkComponent = ComponentType<AnchorHTMLAttributes<HTMLAnchorElement> & { readonly href: string }>;

/** External web destinations open separately; paths, fragments, and mail links stay unchanged. */
export function externalLinkProps(href?: string) {
  return /^(https?:)?\/\//iu.test(href ?? "")
    ? { target: "_blank", rel: "noopener noreferrer" } as const
    : {};
}

const Anchor: LinkComponent = (props) => <a {...externalLinkProps(props.href)} {...props} />;

export interface Crumb {
  readonly label: string;
  readonly href?: string;
}

export function AppHeader({ brand, brandHref, brandIcon, crumbs = [], inset, children, link: Link = Anchor }: {
  readonly link?: LinkComponent;
  readonly brand: string;
  readonly brandHref: string;
  readonly brandIcon?: ReactNode;
  readonly crumbs?: readonly Crumb[];
  /** Leaves room for window controls drawn over the header, such as macOS traffic lights. */
  readonly inset?: "traffic-lights";
  /** Search, status, and actions, placed at the end of the bar. */
  readonly children?: ReactNode;
}) {
  return (
    <header className="ui-header" data-inset={inset}>
      <Link className="ui-brand" href={brandHref} aria-label={`${brand} home`}>
        {brandIcon}
        {brand}
      </Link>
      {crumbs.length > 0 && (
        <nav className="ui-crumbs" aria-label="Breadcrumb">
          {crumbs.map((crumb, index) => {
            const last = index === crumbs.length - 1;
            return (
              <span key={`${index}:${crumb.label}`} style={{ display: "contents" }}>
                <span aria-hidden="true">/</span>
                {last || !crumb.href
                  ? <span aria-current={last ? "page" : undefined}>{crumb.label}</span>
                  : <Link href={crumb.href}>{crumb.label}</Link>}
              </span>
            );
          })}
        </nav>
      )}
      <div className="ui-header-end">{children}</div>
    </header>
  );
}

export interface RailItem {
  readonly href: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly current?: boolean;
  /** A small count on the icon, such as changes waiting for review. */
  readonly badge?: number;
  /** Sits apart from the main destinations: after a gap, or at the bottom. */
  readonly placement?: "gap" | "end";
  /** Left out of the phone tab bar, where only the main destinations fit. */
  readonly hideOnPhone?: boolean;
}

/** The icon rail on the left; on phones it becomes a labelled tab bar along the bottom. */
/** How wide an expanded rail may be dragged, in pixels. */
export const RAIL_WIDTH = { min: 160, max: 360, default: 208 } as const;
/** Dragging an expanded rail narrower than this folds it back to icons. */
const RAIL_COLLAPSE_AT = 120;

export function NavRail({ items, label = "Main", onSelect, link: Link = Anchor, expanded = false, width = RAIL_WIDTH.default, onExpandedChange, onWidthChange, toggleShortcut }: {
  readonly link?: LinkComponent;
  readonly items: readonly RailItem[];
  readonly label?: string;
  /** Called on click; return true to handle it in place of following the link (for example, to open a dialog). */
  readonly onSelect?: (href: string) => boolean;
  /** Shows each destination's name beside its icon. */
  readonly expanded?: boolean;
  /** The expanded rail's width in pixels, kept between `RAIL_WIDTH.min` and `.max`. */
  readonly width?: number;
  /** Given, the rail offers a button at its top to expand and collapse it. */
  readonly onExpandedChange?: (expanded: boolean) => void;
  /** Given, the expanded rail's edge can be dragged, or moved with the arrow keys, to resize it. */
  readonly onWidthChange?: (width: number) => void;
  /** The toggle's shortcut as shown in its tooltip, e.g. "⌘B". */
  readonly toggleShortcut?: string;
}) {
  const clamped = Math.round(Math.min(RAIL_WIDTH.max, Math.max(RAIL_WIDTH.min, width)));
  const [dragging, setDragging] = useState(false);

  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const left = handle.parentElement!.getBoundingClientRect().left;
    handle.setPointerCapture(event.pointerId);
    setDragging(true);
    let open = expanded;
    const move = (moved: PointerEvent) => {
      const next = moved.clientX - left;
      if (next < RAIL_COLLAPSE_AT) {
        if (open) onExpandedChange?.(open = false);
        return;
      }
      if (!open) onExpandedChange?.(open = true);
      onWidthChange?.(Math.round(Math.min(RAIL_WIDTH.max, Math.max(RAIL_WIDTH.min, next))));
    };
    const stop = () => {
      setDragging(false);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  }

  function resizeWithKeys(event: ReactKeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onExpandedChange?.(!expanded);
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    if (!expanded) {
      if (event.key === "ArrowRight") onExpandedChange?.(true);
      return;
    }
    const next = clamped + (event.key === "ArrowRight" ? step : -step);
    if (next < RAIL_WIDTH.min) onExpandedChange?.(false);
    else onWidthChange?.(Math.min(RAIL_WIDTH.max, next));
  }

  return (
    <nav
      className="ui-rail"
      aria-label={label}
      data-expanded={expanded ? "" : undefined}
      data-resizing={dragging ? "" : undefined}
      style={expanded ? { "--ui-rail-expanded": `${clamped}px` } as CSSProperties : undefined}
    >
      {onExpandedChange && (
        <button
          type="button"
          className="ui-rail-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse sidebar" : "Expand sidebar"}
          aria-keyshortcuts={toggleShortcut ? "Meta+B Control+B" : undefined}
          title={`${expanded ? "Collapse sidebar" : "Expand sidebar"}${toggleShortcut ? ` (${toggleShortcut})` : ""}`}
          onClick={() => onExpandedChange(!expanded)}
        >
          <Icon name="sidebar" size={16} />
        </button>
      )}
      {items.map((item) => (
        <span key={item.href} style={{ display: "contents" }}>
          {item.placement === "gap" && <span className="ui-rail-gap" aria-hidden="true" />}
          <Link
            href={item.href}
            className={cx("ui-rail-item", item.placement === "end" && "ui-rail-end")}
            aria-current={item.current ? "page" : undefined}
            title={expanded ? undefined : item.label}
            data-phone={item.hideOnPhone ? "hidden" : undefined}
            onClick={onSelect ? (event) => { if (onSelect(item.href)) event.preventDefault(); } : undefined}
          >
            {item.icon}
            <span>{item.label}</span>
            {item.badge ? <span className="ui-badge" aria-label={`${item.badge} waiting`}>{item.badge > 99 ? "99+" : item.badge}</span> : null}
          </Link>
        </span>
      ))}
      {(onWidthChange || onExpandedChange) && (
        <div
          className="ui-rail-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuemin={0}
          aria-valuemax={RAIL_WIDTH.max}
          aria-valuenow={expanded ? clamped : 0}
          tabIndex={0}
          title="Drag to resize, double-click to expand or collapse"
          onPointerDown={startDrag}
          onDoubleClick={() => onExpandedChange?.(!expanded)}
          onKeyDown={resizeWithKeys}
        />
      )}
    </nav>
  );
}

export function Panel({ title, actions, children, className, bodyClassName, padded = false, as: Tag = "section", ...rest }: {
  readonly title?: ReactNode;
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
  readonly className?: string;
  readonly bodyClassName?: string;
  /** Pads the body; leave off for lists and tables that run to the panel edge. */
  readonly padded?: boolean;
  readonly as?: "section" | "div" | "article" | "aside";
} & Omit<ComponentPropsWithoutRef<"section">, "title" | "className" | "children">) {
  return (
    <Tag className={cx("ui-panel", className)} {...rest}>
      {(title !== undefined || actions !== undefined) && (
        <div className="ui-panel-head">
          {typeof title === "string" ? <h2 className="ui-label">{title}</h2> : title ?? <span />}
          {actions}
        </div>
      )}
      {padded ? <div className={cx("ui-panel-body", bodyClassName)}>{children}</div> : children}
    </Tag>
  );
}

export type Tone = "chart" | "mark" | "good" | "danger";

export function StatTile({ label, value, sub, size, tone, badge, badgeTone }: {
  /** Colours the figure with a theme accent, where the theme makes it readable. */
  readonly tone?: Tone;
  /** A short note beside the label, such as a rank: "#3 of 15". */
  readonly badge?: string;
  /** Ranks stand out in the highlight colour; descriptions stay quiet. */
  readonly badgeTone?: "mark" | "quiet";
  readonly label: string;
  readonly value: ReactNode;
  readonly sub?: ReactNode;
  /** Figure size in pixels; tiles in a dense row may want it smaller. */
  readonly size?: number;
}) {
  return (
    <div className="ui-panel ui-tile">
      {badge === undefined ? <span className="ui-label">{label}</span> : (
        <span className="ui-tile-head">
          <span className="ui-label">{label}</span>
          <span className="ui-tile-badge" data-tone={badgeTone ?? "mark"}>{badge}</span>
        </span>
      )}
      <span className="ui-figure" data-tone={tone} style={size ? { fontSize: size } : undefined}>{value}</span>
      {sub !== undefined && <span className="ui-sub" title={typeof sub === "string" ? sub : undefined}>{sub}</span>}
    </div>
  );
}

export function TitleRow({ title, meta, actions, level = 1 }: {
  readonly title: ReactNode;
  readonly meta?: ReactNode;
  readonly actions?: ReactNode;
  readonly level?: 1 | 2;
}) {
  const Heading = level === 1 ? "h1" : "h2";
  return (
    <div className="ui-title-row">
      <Heading className="ui-title">{title}</Heading>
      {meta !== undefined && <span className="ui-sub">{meta}</span>}
      {actions !== undefined && <span>{actions}</span>}
    </div>
  );
}

export interface Bar {
  readonly label: string;
  readonly value: number;
  readonly highlight?: boolean;
  /** The full name for the hover card, e.g. "August 2026" for the label "Aug". */
  readonly detail?: string;
}

/** "1 passage", "848 passages". */
function counted(value: number, unit: string | undefined, format: (value: number) => string): string {
  return unit ? `${format(value)} ${unit}${value === 1 ? "" : "s"}` : format(value);
}

/**
 * A column chart with its numbers in the markup: each bar is labelled, and a
 * hidden table carries the same figures for screen readers.
 */
export function Bars({ bars, title, height = 120, gap = 4, showValues = true, format = (value) => value.toLocaleString(), unit, share = false }: {
  readonly bars: readonly Bar[];
  /** What each value counts, singular, for the hover card: "passage". */
  readonly unit?: string;
  /** Adds each bar's share of the total to the hover card. */
  readonly share?: boolean;
  /** Names the chart for assistive technology. */
  readonly title: string;
  readonly height?: number;
  readonly gap?: number;
  readonly showValues?: boolean;
  readonly format?: (value: number) => string;
}) {
  const max = Math.max(1, ...bars.map(({ value }) => value));
  const total = bars.reduce((sum, { value }) => sum + value, 0);
  const { handlers, tip } = useChartTip();
  return (
    <figure className="ui-bars" style={{ "--ui-bars-height": `${height}px`, "--ui-bars-gap": `${gap}px` } as CSSProperties}>
      <div className="ui-bars-plot" aria-hidden="true" {...handlers}>
        {bars.map((bar, index) => (
          <div
            key={`${index}:${bar.label}`}
            className="ui-bars-col"
            data-highlight={bar.highlight ? "" : undefined}
            data-tip-title={bar.detail ?? bar.label}
            data-tip-value={`${counted(bar.value, unit, format)}${share && total > 0 ? ` · ${Math.round((bar.value / total) * 100)}%` : ""}`}
          >
            {showValues && bar.value > 0 && <b>{format(bar.value)}</b>}
            <i style={{ height: `${(bar.value / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="ui-bars-axis" aria-hidden="true">
        {bars.map((bar, index) => <span key={`${index}:${bar.label}`}>{bar.label}</span>)}
      </div>
      {tip}
      <table className="ui-visually-hidden">
        <caption>{title}</caption>
        <tbody>
          {bars.map((bar, index) => (
            <tr key={`${index}:${bar.label}`}><th scope="row">{bar.detail ?? bar.label}</th><td>{format(bar.value)}</td></tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

export function Meter({ value, max, label, tone }: { readonly value: number; readonly max: number; readonly label?: string; readonly tone?: "mark" | "good" }) {
  const share = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <div className="ui-meter" data-tone={tone} role={label ? "meter" : undefined} aria-label={label} aria-valuenow={label ? value : undefined} aria-valuemin={label ? 0 : undefined} aria-valuemax={label ? max : undefined} aria-hidden={label ? undefined : true}>
      <span style={{ width: `${share * 100}%` }} />
    </div>
  );
}

export interface RankedEntry {
  readonly key: string;
  readonly label: ReactNode;
  readonly value: number;
  readonly href?: string;
}

/** A short leaderboard: name, figure, and a meter scaled to the leader. */
export function Ranked({ entries, format = (value) => value.toLocaleString(), numbered = false }: {
  readonly entries: readonly RankedEntry[];
  readonly format?: (value: number) => string;
  /** Shows each place, with the top three picked out. */
  readonly numbered?: boolean;
}) {
  const max = Math.max(1, ...entries.map(({ value }) => value));
  return (
    <ol className="ui-rank" data-numbered={numbered ? "" : undefined}>
      {entries.map((entry, index) => (
        <li key={entry.key} className="ui-rank-row">
          {numbered && <span className="ui-rank-place" data-top={index < 3 ? "" : undefined} aria-hidden="true">{index + 1}</span>}
          <span>{entry.href ? <a href={entry.href} {...externalLinkProps(entry.href)}>{entry.label}</a> : entry.label}</span>
          <span className="ui-number">{format(entry.value)}</span>
          <Meter value={entry.value} max={max} />
        </li>
      ))}
    </ol>
  );
}

export function Facet({ label, count, pressed, onSelect }: {
  readonly label: ReactNode;
  readonly count?: number;
  readonly pressed: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button type="button" className="ui-facet" aria-pressed={pressed} onClick={onSelect}>
      <span>{label}</span>
      <span>{count === undefined ? "" : count.toLocaleString()}</span>
    </button>
  );
}

export function KeyValue({ label, hint, children, labelFor }: {
  readonly label: string;
  readonly hint?: ReactNode;
  readonly children?: ReactNode;
  /** The id of the control this row describes. */
  readonly labelFor?: string;
}) {
  return (
    <div className="ui-kv">
      <div>
        {labelFor ? <label htmlFor={labelFor}>{label}</label> : <span>{label}</span>}
        {hint !== undefined && <span className="ui-sub">{hint}</span>}
      </div>
      <div>{children}</div>
    </div>
  );
}

export function Chip({ tone, plain, children }: {
  readonly tone?: "accent" | "mark" | "danger";
  readonly plain?: boolean;
  readonly children: ReactNode;
}) {
  return <span className="ui-chip" data-tone={tone} data-plain={plain ? "" : undefined}>{children}</span>;
}

export function Status({ tone, label, detail, href }: {
  readonly tone?: "good" | "busy" | "bad";
  readonly label: string;
  readonly detail?: string;
  readonly href?: string;
}) {
  const content = <span>{label}</span>;
  return href
    ? <a className="ui-status" data-tone={tone} role="status" href={href} {...externalLinkProps(href)} title={detail} aria-label={detail ? `${label}. ${detail}` : label}>{content}</a>
    : <span className="ui-status" data-tone={tone} role="status" title={detail}>{content}</span>;
}

export interface HeatmapDay {
  /** A local calendar day, `YYYY-MM-DD`. */
  readonly day: string;
  readonly value: number;
}

function parseDay(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year!, (month ?? 1) - 1, date ?? 1);
}

function formatDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * A calendar of activity: one column per week (Monday first), one square per
 * day, shaded in five steps relative to the busiest day. Covers the span from
 * the first to the last day given, at most `maxWeeks` ending at the last.
 */
/**
 * A heatmap as wide as its panel: as many weeks as fit at the given square
 * size, ending at the latest day, so a short history sits at the right of a
 * full calendar rather than in a corner of an empty box.
 */
export function FillHeatmap({ cell = 16, weeks: fixedWeeks, ...props }: Omit<Parameters<typeof Heatmap>[0], "maxWeeks" | "fullSpan" | "cell"> & {
  readonly cell?: number;
  /** Show exactly this many weeks and size the squares to fill the width instead. */
  readonly weeks?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [weeks, setWeeks] = useState(fixedWeeks ?? 17);
  const [size, setSize] = useState(cell);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => {
      // 34px of weekday labels, then one column (square plus 3px gap) per week.
      const room = element.clientWidth - 34 + 3;
      if (fixedWeeks) {
        setSize(Math.max(8, Math.min(28, room / fixedWeeks - 3)));
        return;
      }
      setWeeks(Math.max(4, Math.min(53, Math.floor(room / (cell + 3)))));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [cell, fixedWeeks]);
  return <div ref={box} className="ui-heatmap-fill"><Heatmap {...props} cell={fixedWeeks ? size : cell} maxWeeks={fixedWeeks ?? weeks} fullSpan /></div>;
}

export function Heatmap({ days, title, unit = "passage", maxWeeks = 53, through, fullSpan = false, cell }: {
  readonly days: readonly HeatmapDay[];
  readonly title: string;
  readonly unit?: string;
  readonly maxWeeks?: number;
  /** End the calendar on this day (`YYYY-MM-DD`) instead of the last day with activity, e.g. today. */
  readonly through?: string;
  /** Always show `maxWeeks` weeks, not just the span that has activity. */
  readonly fullSpan?: boolean;
  /** Square size in pixels. */
  readonly cell?: number;
}) {
  if (days.length === 0) return <p className="ui-sub">Nothing to show yet.</p>;
  const values = new Map(days.map(({ day, value }) => [day, value]));
  const sorted = [...values.keys()].sort();
  const last = parseDay(through && through > sorted.at(-1)! ? through : sorted.at(-1)!);
  const end = new Date(last);
  end.setDate(end.getDate() + (6 - ((end.getDay() + 6) % 7)));
  let start = parseDay(sorted[0]!);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const earliest = new Date(end);
  earliest.setDate(earliest.getDate() - maxWeeks * 7 + 1);
  if (start < earliest || fullSpan) start = earliest;
  const max = Math.max(1, ...days.map(({ value }) => value));
  const weeks: { readonly days: { readonly key: string; readonly value: number; readonly inRange: boolean; readonly date: Date }[] }[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const week = [];
    for (let index = 0; index < 7; index += 1) {
      const key = formatDay(cursor);
      week.push({ key, value: values.get(key) ?? 0, inRange: cursor <= last, date: new Date(cursor) });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push({ days: week });
  }
  const level = (value: number) => value === 0 ? 0 : Math.min(4, Math.ceil((value / max) * 4));
  const plural = (count: number) => `${count.toLocaleString()} ${unit}${count === 1 ? "" : "s"}`;
  return <HeatmapBody weeks={weeks} title={title} cell={cell} days={days} plural={plural} level={level} />;
}

function HeatmapBody({ weeks, title, cell, days, plural, level }: {
  readonly weeks: readonly { readonly days: readonly { readonly key: string; readonly value: number; readonly inRange: boolean; readonly date: Date }[] }[];
  readonly title: string;
  readonly cell: number | undefined;
  readonly days: readonly HeatmapDay[];
  readonly plural: (count: number) => string;
  readonly level: (value: number) => number;
}) {
  const { handlers, tip } = useChartTip();
  return (
    <figure className="ui-heatmap" aria-label={title} style={cell ? { "--ui-heat-cell": `${cell}px` } as CSSProperties : undefined}>
      <div className="ui-heatmap-months" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${weeks.length}, var(--ui-heat-cell))` }}>
        {weeks.map((week, index) => {
          const monthStart = week.days.find(({ date }) => date.getDate() === 1)?.date;
          // The first column names its month only when the next month is not about to crowd it.
          const nextStart = weeks.slice(1, 3).some((later) => later.days.some(({ date }) => date.getDate() === 1));
          const label = monthStart ?? (index === 0 && !nextStart ? week.days[0]!.date : undefined);
          return <span key={week.days[0]!.key}>{label ? label.toLocaleDateString(undefined, { month: "short" }) : ""}</span>;
        })}
      </div>
      <div className="ui-heatmap-body">
        <div className="ui-heatmap-weekdays" aria-hidden="true">
          {["Mon", "", "Wed", "", "Fri", "", "Sun"].map((label, index) => <span key={index}>{label}</span>)}
        </div>
        <div {...handlers} className="ui-heatmap-grid" role="img" aria-label={`${title}: ${plural(days.reduce((sum, { value }) => sum + value, 0))} over ${days.filter(({ value }) => value > 0).length} days`} style={{ gridTemplateColumns: `repeat(${weeks.length}, var(--ui-heat-cell))` }}>
          {weeks.map((week) => (
            <div key={week.days[0]!.key} className="ui-heatmap-week">
              {week.days.map((day) => (
                <i
                  key={day.key}
                  data-level={day.inRange ? level(day.value) : undefined}
                  data-tip-title={day.inRange ? day.date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : undefined}
                  data-tip-value={day.inRange ? plural(day.value) : undefined}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      {tip}
      <div className="ui-heatmap-legend" aria-hidden="true">
        <span>Less</span>{[0, 1, 2, 3, 4].map((step) => <i key={step} data-level={step} />)}<span>More</span>
      </div>
    </figure>
  );
}

export { contrastRatio, toneProperties, type ToneInputs } from "./tones";
export { Icon, type IconName } from "./icons";

export { Select, SelectItem, Menu, MenuItem, MenuSeparator } from "./controls";
export type { SelectProps } from "./controls";
export { ComboBox, DatePicker } from "./pickers";
export { PickerPopover, MultiSelect } from "./pickers";
export type { MultiSelectProps } from "./pickers";
