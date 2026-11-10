import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "../components/icons";

const iso = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

function parse(value?: string): Date | undefined {
  if (!value) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  return year && month && day ? new Date(year, month - 1, day) : undefined;
}

const shift = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);

/** 0 = Sunday … 6 = Saturday: the first column of the calendar in the reader's locale. */
function firstWeekday(): number {
  try {
    const info = (new Intl.Locale(navigator.language) as unknown as { getWeekInfo?: () => { firstDay: number } }).getWeekInfo?.();
    return info ? info.firstDay % 7 : 1;
  } catch {
    return 1;
  }
}

/** A themed calendar in place of the system date picker. Values are `YYYY-MM-DD`. */
export function DatePicker({ label, value, onChange }: {
  readonly label: string;
  readonly value?: string;
  readonly onChange: (value: string | undefined) => void;
}) {
  const selected = parse(value);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState<Date>(() => selected ?? new Date());
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const locale = navigator.language;
  const today = iso(new Date());

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  useEffect(() => {
    if (open) root.current?.querySelector<HTMLButtonElement>(`[data-date="${iso(focused)}"]`)?.focus();
  }, [open, focused]);

  const days = useMemo(() => {
    const first = new Date(focused.getFullYear(), focused.getMonth(), 1);
    const lead = (first.getDay() - firstWeekday() + 7) % 7;
    const count = new Date(focused.getFullYear(), focused.getMonth() + 1, 0).getDate();
    return [...Array<Date | null>(lead).fill(null), ...Array.from({ length: count }, (_, index) => new Date(focused.getFullYear(), focused.getMonth(), index + 1))];
  }, [focused]);
  const weekdays = useMemo(() => Array.from({ length: 7 }, (_, index) => {
    const date = new Date(2024, 0, 7 + ((firstWeekday() + index) % 7));
    return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(date);
  }), [locale]);

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  function choose(date: Date | undefined) {
    onChange(date ? iso(date) : undefined);
    close();
  }

  function onKeyDown(event: KeyboardEvent) {
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key in step) {
      event.preventDefault();
      setFocused((current) => shift(current, step[event.key]!));
    } else if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault();
      const direction = event.key === "PageUp" ? -1 : 1;
      setFocused((current) => new Date(current.getFullYear(), current.getMonth() + direction, 1));
    }
  }

  const format = (date: Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, options).format(date);
  return (
    <div className="ll-datepicker" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="ll-field ll-datepicker-trigger"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setFocused(selected ?? new Date());
          setOpen((was) => !was);
        }}
      >
        <CalendarDays size={16} aria-hidden="true" />
        <span data-empty={selected ? undefined : ""}>{selected ? format(selected, { dateStyle: "medium" }) : "Any date"}</span>
      </button>
      {open && (
        <div id={id} className="ll-datepicker-panel" role="dialog" aria-label={label} onKeyDown={onKeyDown}>
          <div className="ll-datepicker-head">
            <button type="button" className="ll-icon-button" aria-label="Previous month" onClick={() => setFocused((current) => new Date(current.getFullYear(), current.getMonth() - 1, 1))}><ChevronLeft size={18} aria-hidden="true" /></button>
            <strong aria-live="polite">{format(focused, { month: "long", year: "numeric" })}</strong>
            <button type="button" className="ll-icon-button" aria-label="Next month" onClick={() => setFocused((current) => new Date(current.getFullYear(), current.getMonth() + 1, 1))}><ChevronRight size={18} aria-hidden="true" /></button>
          </div>
          <div className="ll-datepicker-grid" role="grid" aria-label={format(focused, { month: "long", year: "numeric" })}>
            {weekdays.map((weekday) => <span key={weekday} className="ll-datepicker-weekday" aria-hidden="true">{weekday}</span>)}
            {days.map((date, index) => date ? (
              <button
                key={iso(date)}
                type="button"
                data-date={iso(date)}
                aria-label={format(date, { dateStyle: "full" })}
                aria-pressed={selected ? iso(selected) === iso(date) : false}
                data-today={iso(date) === today ? "" : undefined}
                tabIndex={iso(date) === iso(focused) ? 0 : -1}
                onClick={() => choose(date)}
              >{date.getDate()}</button>
            ) : <span key={`blank-${index}`} />)}
          </div>
          <div className="ll-datepicker-foot">
            <button type="button" className="ll-text-button" onClick={() => choose(new Date())}>Today</button>
            {selected && <button type="button" className="ll-text-button" onClick={() => choose(undefined)}><X size={14} aria-hidden="true" />Clear</button>}
          </div>
        </div>
      )}
    </div>
  );
}
