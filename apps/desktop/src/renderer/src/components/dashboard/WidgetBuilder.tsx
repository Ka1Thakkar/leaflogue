
import { Select, SelectItem } from "@leaflogue/ui";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CUSTOM_WIDGET_VERSION, WIDGET_CHARTS, WIDGET_COUNTS, WIDGET_LIMITS, type CustomWidget, type WidgetChart, type WidgetCount, type WidgetField, type WidgetFilter, type WidgetSort } from "@leaflogue/contracts";
import { customWidgetIdFor, GROUPED_CHARTS, WIDGET_FIELD_INFO, widgetDefaults, widgetFieldsFor, type WidgetValue } from "@leaflogue/domain";
import { Icon } from "@leaflogue/ui";
import { InlineError } from "../shared";
import { CustomWidgetView, useWidgetResults } from "./custom";
import styles from "./builder.module.css";

const COUNT_LABELS: Readonly<Record<WidgetCount, string>> = { passages: "Passages", books: "Books on your shelf", notes: "Notes" };
const CHART_LABELS: Readonly<Record<WidgetChart, string>> = {
  number: "A number",
  bars: "Columns",
  ranked: "A ranked list",
  heatmap: "A calendar",
  list: "A list of them",
};
const SORT_LABELS: Readonly<Record<WidgetSort, string>> = { count: "Largest first", label: "In their own order" };
const AMOUNTS = [3, 4, 5, 6, 8, 10, 12, 15, 20, 24, 30, 50] as const;

interface FilterRow {
  readonly key: number;
  readonly field: WidgetField;
  readonly negate: boolean;
  /** Empty until the reader picks one; the filter applies only then. */
  readonly value: string;
}

interface Draft {
  readonly title: string;
  readonly description: string;
  readonly count: WidgetCount;
  readonly show: WidgetChart;
  readonly groupBy: WidgetField;
  readonly sort: WidgetSort;
  readonly limit: number;
  readonly filters: readonly FilterRow[];
}

let rowKey = 0;

function draftOf(widget: CustomWidget | undefined): Draft {
  const show = widget?.show ?? "bars";
  const defaults = widgetDefaults({ show });
  return {
    title: widget?.title ?? "",
    description: widget?.description ?? "",
    count: widget?.count ?? "passages",
    show,
    groupBy: widget?.groupBy ?? "weekday",
    sort: widget?.sort ?? defaults.sort,
    limit: widget?.limit ?? defaults.limit,
    filters: (widget?.where ?? []).map((filter) => ({ key: rowKey++, field: filter.field, negate: !("is" in filter), value: "is" in filter ? filter.is : filter.isNot })),
  };
}

/** Keep a draft valid as its parts change: fields a count lacks go, and each chart keeps what it uses. */
function tidy(draft: Draft): Draft {
  const fields = widgetFieldsFor(draft.count);
  const show = draft.show === "heatmap" && draft.count === "books" ? "number" : draft.show;
  return {
    ...draft,
    show,
    groupBy: fields.includes(draft.groupBy) ? draft.groupBy : fields[0]!,
    filters: draft.filters.filter(({ field }) => fields.includes(field)),
  };
}

function recipeOf(draft: Draft, id: string): CustomWidget {
  const grouped = GROUPED_CHARTS.includes(draft.show);
  const where: WidgetFilter[] = draft.filters
    .filter(({ value }) => value !== "")
    .map(({ field, negate, value }) => (negate ? { field, isNot: value } : { field, is: value }));
  return {
    id,
    version: CUSTOM_WIDGET_VERSION,
    title: draft.title.trim() || "Untitled widget",
    ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
    count: draft.count,
    ...(grouped ? { groupBy: draft.groupBy } : {}),
    ...(where.length > 0 ? { where } : {}),
    show: draft.show,
    ...(draft.show !== "number" && draft.show !== "heatmap" ? { limit: draft.limit } : {}),
    ...(grouped ? { sort: draft.sort } : {}),
  };
}

/** The count whose groups list a field's values in this library. */
function countFor(field: WidgetField): WidgetCount {
  return widgetFieldsFor("books").includes(field) ? "books" : "passages";
}

/**
 * The values a filter can pick for a field: fixed ones from the field
 * itself, and names (tags, authors, years) drawn from the library.
 */
function useFieldValues(fields: readonly WidgetField[]): ReadonlyMap<WidgetField, readonly WidgetValue[]> {
  const drawn = useMemo(() => [...new Set(fields)].filter((field) => !WIDGET_FIELD_INFO[field].values), [fields]);
  const recipes = useMemo(() => drawn.map((field): CustomWidget => ({ id: `values-${field}`, version: CUSTOM_WIDGET_VERSION, title: "Values", count: countFor(field), groupBy: field, show: "ranked", sort: "label", limit: WIDGET_LIMITS.shown })), [drawn]);
  const results = useWidgetResults(recipes, undefined);
  return useMemo(() => {
    const values = new Map<WidgetField, readonly WidgetValue[]>();
    for (const field of fields) {
      const info = WIDGET_FIELD_INFO[field];
      if (info.values) {
        values.set(field, info.values);
        continue;
      }
      const result = results.get(`values-${field}`);
      // A book is matched by its title, so the title is what a shared widget keeps.
      const found = result && typeof result !== "string" && result.kind === "groups" ? result.groups.map(({ label }) => ({ key: label, label })) : [];
      const unique = [...new Map(found.map((value) => [value.key, value])).values()];
      values.set(field, info.year ? [{ key: "this-year", label: "This year" }, { key: "last-year", label: "Last year" }, ...unique.reverse()] : unique);
    }
    return values;
  }, [fields, results]);
}

/** Escape closes the builder, not the customising behind it. */
function keepEscapeInside(event: KeyboardEvent) {
  if (event.key === "Escape") event.stopPropagation();
}

export function WidgetBuilder({ initial, taken, onSave, onClose }: {
  /** The widget being edited; a new one when absent. */
  readonly initial?: CustomWidget;
  /** IDs already in use, so a new widget gets its own. */
  readonly taken: readonly string[];
  readonly onSave: (widget: CustomWidget) => Promise<void>;
  readonly onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [draft, setDraft] = useState(() => draftOf(initial));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const titleInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    // A closed dialog refuses focus, so the title takes it only once the dialog is open.
    titleInput.current?.focus();
  }, []);

  const change = (patch: Partial<Draft>) => setDraft((current) => tidy({ ...current, ...patch }));
  const fields = widgetFieldsFor(draft.count);
  const grouped = GROUPED_CHARTS.includes(draft.show);
  const charts = WIDGET_CHARTS.filter((chart) => !(chart === "heatmap" && draft.count === "books"));
  const values = useFieldValues(useMemo(() => draft.filters.map(({ field }) => field), [draft.filters]));
  const amounts = AMOUNTS.includes(draft.limit as (typeof AMOUNTS)[number]) ? AMOUNTS : [...AMOUNTS, draft.limit].sort((a, b) => a - b);

  // The title and description do not change the count, so typing them does not recount.
  const recipe = recipeOf(draft, initial?.id ?? "preview");
  const result = useWidgetResults([recipeOf({ ...draft, title: "Preview", description: "" }, recipe.id)], undefined).get(recipe.id) ?? "loading";

  const save = async () => {
    if (!draft.title.trim()) {
      setError("Give the widget a title.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSave(recipeOf(draft, initial?.id ?? customWidgetIdFor(draft.title, taken)));
      onClose();
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : "The widget could not be saved.");
      setSaving(false);
    }
  };

  const field = (name: string) => `${id}-${name}`;
  return (
    <dialog
      ref={dialog}
      className={`ll-dialog ${styles.dialog}`}
      aria-labelledby={field("heading")}
      onKeyDown={keepEscapeInside}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
    >
      <div className={styles.heading}>
        <h2 id={field("heading")}>{initial ? "Edit widget" : "New widget"}</h2>
        <button type="button" className="ui-icon-btn" onClick={onClose} aria-label="Close" title="Close"><Icon name="close" size={16} /></button>
      </div>
      <form className={styles.body} onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <div className={styles.sheet}>
          <div className={styles.row}>
            <label htmlFor={field("title")}>Title</label>
            <input ref={titleInput} id={field("title")} className="ll-field" value={draft.title} maxLength={WIDGET_LIMITS.title} placeholder="Favourites by weekday" onChange={(event) => change({ title: event.target.value })} />
          </div>
          <div className={styles.row}>
            <label htmlFor={field("count")}>Count</label>
            <Select id={field("count")} className="ll-field" value={draft.count} onValueChange={(value) => change({ count: value as WidgetCount })}>
              {WIDGET_COUNTS.map((count) => <SelectItem key={count} value={count}>{COUNT_LABELS[count]}</SelectItem>)}
            </Select>
          </div>
          <div className={styles.row}>
            <label htmlFor={field("show")}>Show as</label>
            <Select
              id={field("show")}
              className="ll-field"
              value={draft.show}
              onValueChange={(value) => {
                const show = value as WidgetChart;
                change({ show, ...widgetDefaults({ show }) });
              }}
            >
              {charts.map((chart) => <SelectItem key={chart} value={chart}>{CHART_LABELS[chart]}</SelectItem>)}
            </Select>
          </div>
          {grouped && (
            <>
              <div className={styles.row}>
                <label htmlFor={field("group")}>Group by</label>
                <Select id={field("group")} className="ll-field" value={draft.groupBy} onValueChange={(value) => change({ groupBy: value as WidgetField })}>
                  {fields.map((option) => <SelectItem key={option} value={option}>{WIDGET_FIELD_INFO[option].label}</SelectItem>)}
                </Select>
              </div>
              <div className={styles.row}>
                <label htmlFor={field("sort")}>Order</label>
                <Select id={field("sort")} className="ll-field" value={draft.sort} onValueChange={(value) => change({ sort: value as WidgetSort })}>
                  {(["count", "label"] as const).map((sort) => <SelectItem key={sort} value={sort}>{SORT_LABELS[sort]}</SelectItem>)}
                </Select>
              </div>
            </>
          )}
          {draft.show !== "number" && draft.show !== "heatmap" && (
            <div className={styles.row}>
              <label htmlFor={field("limit")}>How many</label>
              <Select id={field("limit")} className="ll-field" value={draft.limit} onValueChange={(value) => change({ limit: Number(value) })}>
                {amounts.map((amount) => <SelectItem key={amount} value={amount}>{draft.show === "list" ? `${amount} at most` : `Top ${amount}`}</SelectItem>)}
              </Select>
            </div>
          )}
          <fieldset className={styles.filters}>
            <legend>Only</legend>
            {draft.filters.length === 0 && <p className="ui-sub">Everything is counted. Add a filter to count only some of it.</p>}
            {draft.filters.map((row, index) => {
              const options = values.get(row.field) ?? [];
              const label = `Filter ${index + 1}`;
              const update = (patch: Partial<FilterRow>) => change({ filters: draft.filters.map((entry) => (entry.key === row.key ? { ...entry, ...patch } : entry)) });
              return (
                <div key={row.key} className={styles.filter} role="group" aria-label={label}>
                  <Select className="ll-field" aria-label={`${label} field`} value={row.field} onValueChange={(value) => update({ field: value as WidgetField, value: "" })}>
                    {fields.map((option) => <SelectItem key={option} value={option}>{WIDGET_FIELD_INFO[option].label}</SelectItem>)}
                  </Select>
                  <Select className="ll-field" aria-label={`${label} match`} value={row.negate ? "not" : "is"} onValueChange={(value) => update({ negate: value === "not" })}>
                    <SelectItem value="is">is</SelectItem>
                    <SelectItem value="not">is not</SelectItem>
                  </Select>
                  <Select className="ll-field" aria-label={`${label} value`} value={row.value} onValueChange={(value) => update({ value: value })}>
                    <SelectItem value="" disabled>{options.length === 0 ? "Nothing to choose yet" : "Choose…"}</SelectItem>
                    {/* A value from a shared widget that this library lacks stays chosen. */}
                    {row.value && !options.some(({ key }) => key === row.value) && <SelectItem value={row.value}>{row.value}</SelectItem>}
                    {options.map((option) => <SelectItem key={option.key} value={option.key}>{option.label}</SelectItem>)}
                  </Select>
                  <button type="button" className="ui-icon-btn" aria-label={`Remove ${label.toLowerCase()}`} title="Remove filter" onClick={() => change({ filters: draft.filters.filter((entry) => entry.key !== row.key) })}>
                    <Icon name="close" size={14} />
                  </button>
                </div>
              );
            })}
            {draft.filters.length < WIDGET_LIMITS.filters && (
              <button type="button" className={`ll-button-secondary ${styles.addFilter}`} onClick={() => change({ filters: [...draft.filters, { key: rowKey++, field: fields[0]!, negate: false, value: "" }] })}>
                <Icon name="plus" size={14} />Add a filter
              </button>
            )}
          </fieldset>
          <div className={styles.row}>
            <label htmlFor={field("description")}>Description <span className="ui-sub">optional</span></label>
            <input id={field("description")} className="ll-field" value={draft.description} maxLength={WIDGET_LIMITS.description} placeholder="Shown when you add it, and to people you share it with" onChange={(event) => change({ description: event.target.value })} />
          </div>
        </div>
        <section className={styles.preview} aria-label="Preview">
          <span className="ll-label">Preview</span>
          <div className={styles.previewSlot} data-tile={draft.show === "number" ? "" : undefined}>
            <CustomWidgetView widget={recipe} result={result} />
          </div>
        </section>
        <div className={styles.actions}>
          <InlineError>{error}</InlineError>
          <button type="button" className="ll-button-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="ll-button" disabled={saving}>
            <Icon name="check" size={15} />{saving ? "Saving…" : initial ? "Save widget" : "Add widget"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
