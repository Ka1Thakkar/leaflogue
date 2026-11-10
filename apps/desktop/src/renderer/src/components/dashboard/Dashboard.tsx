
import { Select, SelectItem } from "@leaflogue/ui";
import { useCallback, useEffect, useMemo, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { customWidgetSlot,DASHBOARD_WIDGET_IDS, isCustomWidgetSlot, type CustomWidget, type DashboardId, type DashboardItemId, type DashboardLayouts, type DashboardPlacement, type DashboardSlotId, type DashboardWidth, type LibraryStatistics } from "@leaflogue/contracts";
import { Icon, Panel, StatTile } from "@leaflogue/ui";
import { useCustomWidgets } from "../../host";
import { useConfirm } from "../Confirm";
import { InlineError } from "../shared";
import type { ReadingSummary } from "../reading-summary";
import { CustomWidgetView, describeWidget, useWidgetResults } from "./custom";
import { add, customWidgetsBySlot, DEFAULT_LAYOUTS, isShelf, isTile, move, normalize, remove, sameLayout, update, WIDTH_LABELS, WIDTHS, widthOf, type CustomWidgets, type Layout } from "./layout";
import { WidgetBuilder } from "./WidgetBuilder";
import { WIDGETS } from "./widgets";
import styles from "./dashboard.module.css";

export interface DashboardState {
  readonly id: DashboardId;
  /** Undefined until the saved layout has been read, so the default never flashes first. */
  readonly layout?: Layout;
  /** The reader's own widgets, placed or not. */
  readonly widgets: readonly CustomWidget[];
  readonly custom: CustomWidgets;
  readonly editing: boolean;
  readonly saving: boolean;
  readonly error: string;
  /** What the last widget import or export did. */
  readonly notice: string;
  readonly problem: string;
  readonly start: () => void;
  readonly cancel: () => void;
  readonly change: (next: (layout: Layout) => Layout) => void;
  readonly reset: () => void;
  readonly save: () => Promise<void>;
  /** Save a widget; a new one is also placed on this page. */
  readonly saveWidget: (widget: CustomWidget) => Promise<void>;
  readonly deleteWidget: (id: string) => Promise<void>;
  readonly exportWidget: (id: string) => Promise<void>;
  readonly importWidgets: () => Promise<void>;
}

const message = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/u, "") : fallback);

/** The layout for one page, and the editing session while the reader customises it. */
export function useDashboard(id: DashboardId): DashboardState {
  const [saved, setSaved] = useState<Layout>();
  const [draft, setDraft] = useState<Layout>();
  const [widgets, setWidgets] = useState<readonly CustomWidget[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [problem, setProblem] = useState("");
  const custom = useMemo(() => customWidgetsBySlot(widgets), [widgets]);

  /** Take in what the settings file now holds, keeping the reader's unsaved arrangement. */
  const apply = useCallback((layouts: DashboardLayouts) => {
    const next = layouts.widgets ?? [];
    const bySlot = customWidgetsBySlot(next);
    setWidgets(next);
    setSaved(normalize(layouts[id] ?? DEFAULT_LAYOUTS[id], id, bySlot));
    setDraft((current) => current && normalize(current, id, bySlot));
    setProblem(layouts.problem ?? "");
    return bySlot;
  }, [id]);

  useEffect(() => {
    let active = true;
    window.leaflogue.dashboards.describe().then(
      (layouts) => { if (active) apply(layouts); },
      // The page still works with the default layout; only customising is affected.
      () => { if (active) setSaved(DEFAULT_LAYOUTS[id]); },
    );
    return () => { active = false; };
  }, [id, apply]);

  const editing = draft !== undefined;
  const cancel = useCallback(() => { setDraft(undefined); setError(""); setNotice(""); }, []);
  useEffect(() => {
    if (!editing) return;
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) cancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, cancel]);

  return {
    id,
    ...(draft ?? saved ? { layout: draft ?? saved } : {}),
    widgets,
    custom,
    editing,
    saving,
    error,
    notice,
    problem,
    start: () => { setError(""); setNotice(""); setDraft(saved ?? DEFAULT_LAYOUTS[id]); },
    cancel,
    change: (next) => setDraft((current) => next(current ?? saved ?? DEFAULT_LAYOUTS[id])),
    reset: () => setDraft(DEFAULT_LAYOUTS[id]),
    save: async () => {
      if (!draft) return;
      setSaving(true);
      setError("");
      try {
        // Matching the default is stored as "no layout", so later improvements to the default still arrive.
        apply(await window.leaflogue.dashboards.save(id, sameLayout(draft, DEFAULT_LAYOUTS[id]) ? null : draft));
        setDraft(undefined);
        setNotice("");
      } catch {
        setError("Your layout could not be saved. The page still shows your changes; try Done again.");
      } finally {
        setSaving(false);
      }
    },
    saveWidget: async (widget) => {
      const isNew = !widgets.some(({ id: existing }) => existing === widget.id);
      try {
        const bySlot = apply(await window.leaflogue.widgets.save(widget));
        if (isNew) setDraft((current) => add(current ?? saved ?? DEFAULT_LAYOUTS[id], customWidgetSlot(widget.id), bySlot));
      } catch (failure) {
        throw new Error(message(failure, "The widget could not be saved."), { cause: failure });
      }
    },
    deleteWidget: async (widgetId) => {
      setError("");
      try {
        apply(await window.leaflogue.widgets.delete(widgetId));
      } catch (failure) {
        setError(message(failure, "The widget could not be deleted."));
      }
    },
    exportWidget: async (widgetId) => {
      setError("");
      setNotice("");
      try {
        const receipt = await window.leaflogue.widgets.export(widgetId);
        if (receipt) setNotice(`Saved “${receipt.title}” as ${receipt.fileName}. Share the file, and anyone can import it.`);
      } catch (failure) {
        setError(message(failure, "The widget could not be exported."));
      }
    },
    importWidgets: async () => {
      setError("");
      setNotice("");
      try {
        const receipt = await window.leaflogue.widgets.import();
        if (!receipt) return;
        apply(receipt.layouts);
        const added = receipt.added.length === 0 ? "" : `Added ${receipt.added.map((title) => `“${title}”`).join(", ")}: choose ${receipt.added.length === 1 ? "it" : "them"} below to place ${receipt.added.length === 1 ? "it" : "them"}.`;
        const unchanged = receipt.unchanged === 0 ? "" : `${receipt.unchanged === 1 ? "One widget was" : `${receipt.unchanged} widgets were`} already here.`;
        setNotice([added, unchanged].filter(Boolean).join(" "));
      } catch (failure) {
        setError(`Nothing was imported. ${message(failure, "Those files are not Leaflogue widgets.")}`);
      }
    },
  };
}

/** Customise, or while customising: back to default, cancel, and done. */
export function DashboardControls({ state }: { readonly state: DashboardState }) {
  if (!state.layout) return null;
  if (!state.editing) {
    return (
      <button type="button" className="ll-button-secondary" onClick={state.start}>
        <Icon name="layout" size={15} />Customise
      </button>
    );
  }
  return (
    <>
      <button type="button" className="ll-button-secondary" onClick={state.reset} disabled={sameLayout(state.layout, DEFAULT_LAYOUTS[state.id])}>
        <Icon name="reset" size={15} />Default layout
      </button>
      <button type="button" className="ll-button-secondary" onClick={state.cancel}>Cancel</button>
      <button type="button" className="ll-button" onClick={() => void state.save()} disabled={state.saving}>
        <Icon name="check" size={15} />{state.saving ? "Saving…" : "Done"}
      </button>
    </>
  );
}

function Placeholder({ widget }: { readonly widget: DashboardWidgetIdOnly }) {
  const { title } = WIDGETS[widget];
  return isTile(widget)
    ? <StatTile label={title} value="–" sub="nothing to count yet" />
    : <Panel title={title} padded><p className="ui-sub">Nothing to show for your library yet. It appears here once there is.</p></Panel>;
}

type DashboardWidgetIdOnly = Exclude<DashboardItemId, `custom:${string}`>;

/** A confirmation's Escape answers it, and does not also end customising. */
function keepEscapeInside(event: KeyboardEvent) {
  if (event.key === "Escape") event.stopPropagation();
}

export function Dashboard({ state, statistics, summary, shelf }: {
  readonly state: DashboardState;
  readonly statistics: LibraryStatistics;
  readonly summary?: ReadingSummary;
  /** The library's books, shown where the reader placed them among the widgets. */
  readonly shelf?: ReactNode;
}) {
  const [dragging, setDragging] = useState<DashboardSlotId>();
  /** The builder: open for a new widget (null) or one being edited. */
  const [building, setBuilding] = useState<CustomWidget | null>();
  const [confirm, confirmation] = useConfirm();
  // Built-in widgets work everywhere; building and sharing your own may not (the web app leaves it out).
  const customWidgets = useCustomWidgets();
  const { layout, editing, custom } = state;
  const placed = useMemo(
    () => (layout ?? []).flatMap(({ widget }) => (isCustomWidgetSlot(widget) && custom.has(widget) ? [custom.get(widget)!] : [])),
    [layout, custom],
  );
  // Recounted whenever the library's statistics are, so custom widgets keep up with imports.
  const results = useWidgetResults(placed, statistics);
  if (!layout) return <>{shelf}</>;
  const missing: DashboardItemId[] = [
    ...DASHBOARD_WIDGET_IDS.filter((widget) => !layout.some((entry) => entry.widget === widget)),
    ...[...custom.keys()].filter((widget) => !layout.some((entry) => entry.widget === widget)),
  ];
  const titleOf = (widget: DashboardItemId) => (isCustomWidgetSlot(widget) ? custom.get(widget)?.title ?? "Widget" : WIDGETS[widget].title);
  const descriptionOf = (widget: DashboardItemId) => {
    if (!isCustomWidgetSlot(widget)) return WIDGETS[widget].description;
    const definition = custom.get(widget);
    return definition ? definition.description ?? describeWidget(definition) : "";
  };

  const dragProps = (widget: DashboardSlotId) => editing ? {
    draggable: true,
    onDragStart: (event: DragEvent) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", widget);
      setDragging(widget);
    },
    onDragOver: (event: DragEvent) => {
      if (!dragging) return;
      event.preventDefault();
      if (dragging !== widget) state.change((current) => move(current, dragging, current.findIndex((entry) => entry.widget === widget)));
    },
    onDrop: (event: DragEvent) => event.preventDefault(),
    onDragEnd: () => setDragging(undefined),
  } : {};

  const arrows = (widget: DashboardSlotId, title: string, index: number) => (
    <>
      <span className={styles.grip} title="Drag to move"><Icon name="grip" size={14} /></span>
      <button type="button" className="ui-icon-btn" aria-label={`Move ${title} earlier`} title="Move earlier" disabled={index === 0} onClick={() => state.change((current) => move(current, widget, index - 1))}>
        <Icon name="arrow-left" size={14} />
      </button>
      <button type="button" className="ui-icon-btn" aria-label={`Move ${title} later`} title="Move later" disabled={index === layout.length - 1} onClick={() => state.change((current) => move(current, widget, index + 1))}>
        <Icon name="arrow-right" size={14} />
      </button>
    </>
  );

  const deleteWidget = async (definition: CustomWidget) => {
    const confirmed = await confirm({
      title: `Delete “${definition.title}”?`,
      message: "It goes from both pages and from the widgets you can add. Export it first if you may want it back.",
      confirmLabel: "Delete widget",
      destructive: true,
    });
    if (confirmed) await state.deleteWidget(definition.id);
  };

  const slot = (placement: DashboardPlacement, index: number) => {
    const { widget } = placement;
    if (isShelf(widget)) {
      // While customising, the books are a single bar to arrange the widgets around.
      if (!editing) return null;
      return (
        <div key={widget} className={`${styles.slot} ${styles.shelf}`} data-width="full" data-dragging={dragging === widget ? "" : undefined} {...dragProps(widget)}>
          <div className={styles.toolbar} role="group" aria-label="Your books">
            {arrows(widget, "your books", index)}
          </div>
          <p className={styles.shelfLabel}><Icon name="library" size={15} /><span><b>Your books</b> <span className="ui-sub">Widgets after this show below your books.</span></span></p>
        </div>
      );
    }
    const definition = isCustomWidgetSlot(widget) ? custom.get(widget) : undefined;
    if (isCustomWidgetSlot(widget) && !definition) return null;
    const title = titleOf(widget);
    const tile = isTile(widget, custom);
    const width = widthOf(placement);
    const tall = !tile && !!placement.tall;
    const content = definition
      ? <CustomWidgetView widget={definition} result={results.get(definition.id) ?? "loading"} tall={tall} />
      : WIDGETS[widget as DashboardWidgetIdOnly].render({ dashboard: state.id, statistics, ...(summary ? { summary } : {}), width, tall });
    if (content === null && !editing) return null;
    return (
      <div
        key={widget}
        className={styles.slot}
        data-width={tile ? "tile" : width}
        data-tall={tall ? "" : undefined}
        data-natural={!definition && WIDGETS[widget as DashboardWidgetIdOnly].natural ? "" : undefined}
        data-dragging={dragging === widget ? "" : undefined}
        {...dragProps(widget)}
      >
        {editing && (
          <div className={styles.toolbar} role="group" aria-label={title}>
            {arrows(widget, title, index)}
            {!tile && (
              <>
                <Select className={styles.width} aria-label={`${title} width`} value={width} onValueChange={(value) => state.change((current) => update(current, widget, { width: value as DashboardWidth }, custom))}>
                  {WIDTHS.map((option) => <SelectItem key={option} value={option}>{WIDTH_LABELS[option]}</SelectItem>)}
                </Select>
                <button type="button" className={styles.toggle} aria-label={`Make ${title} two rows tall`} title="Two rows tall, so shorter panels stack beside it" aria-pressed={tall} onClick={() => state.change((current) => update(current, widget, { tall: !tall }, custom))}>
                  Tall
                </button>
              </>
            )}
            {definition && customWidgets && (
              <span className={styles.customTools}>
                <button type="button" className="ui-icon-btn" aria-label={`Edit ${title}`} title="Edit this widget" onClick={() => setBuilding(definition)}>
                  <Icon name="edit" size={14} />
                </button>
                <button type="button" className="ui-icon-btn" aria-label={`Export ${title}`} title="Save as a file to share" onClick={() => void state.exportWidget(definition.id)}>
                  <Icon name="upload" size={14} />
                </button>
                <button type="button" className="ui-icon-btn" aria-label={`Delete ${title}`} title="Delete this widget" onClick={() => void deleteWidget(definition)}>
                  <Icon name="trash" size={14} />
                </button>
              </span>
            )}
            <button type="button" className="ui-icon-btn" aria-label={`Remove ${title}`} title="Remove from this page" onClick={() => state.change((current) => remove(current, widget))}>
              <Icon name="close" size={14} />
            </button>
          </div>
        )}
        <div className={styles.content} inert={editing}>
          {content ?? <Placeholder widget={widget as DashboardWidgetIdOnly} />}
        </div>
      </div>
    );
  };

  const widgets = layout.filter(({ widget }) => !isShelf(widget));
  const split = layout.findIndex(({ widget }) => isShelf(widget));
  const grid = (entries: readonly { placement: DashboardPlacement; index: number }[]) => {
    const slots = entries.map(({ placement, index }) => slot(placement, index)).filter(Boolean);
    return slots.length === 0 ? null : <div className={styles.grid}>{slots}</div>;
  };
  const indexed = layout.map((placement, index) => ({ placement, index }));

  return (
    <>
      {editing && (
        <section className={styles.tray} aria-label="Add widgets">
          <p className="ui-sub">
            Drag widgets to move them, or use the arrows.{shelf !== undefined && " Put a widget after Your books to show it below them."} Changes are kept when you press Done.
            {state.problem && <> {state.problem}.</>}
          </p>
          <ul className={styles.catalogue}>
            {customWidgets && (
              <>
                <li>
                  <button type="button" className={`${styles.addButton} ${styles.newButton}`} title="Count passages, books or notes your own way" onClick={() => setBuilding(null)}>
                    <Icon name="plus" size={14} />New widget
                  </button>
                </li>
                <li>
                  <button type="button" className={styles.addButton} title="Add widgets from .leaflogue-widget.json files" onClick={() => void state.importWidgets()}>
                    <Icon name="import" size={14} />Import widgets
                  </button>
                </li>
                {missing.length > 0 && <li className={styles.divider} aria-hidden="true" />}
              </>
            )}
            {missing.map((widget) => (
              <li key={widget}>
                <button type="button" className={styles.addButton} data-custom={isCustomWidgetSlot(widget) ? "" : undefined} title={descriptionOf(widget)} onClick={() => state.change((current) => add(current, widget, custom))}>
                  <Icon name="plus" size={14} />{titleOf(widget)}
                </button>
              </li>
            ))}
          </ul>
          {missing.length === 0 && <p className="ui-sub">Every widget is already on this page.</p>}
          {state.notice && <p className="ui-sub" role="status">{state.notice}</p>}
          <InlineError>{state.error}</InlineError>
        </section>
      )}
      {editing ? (
        <div className={styles.grid} data-editing="">
          {layout.map(slot)}
          {widgets.length === 0 && <p className={`ui-sub ${styles.empty}`}>This page has no widgets. Add some above, or press Done to keep it empty.</p>}
        </div>
      ) : split < 0 ? (
        <>{grid(indexed)}{shelf}</>
      ) : (
        <>
          {grid(indexed.slice(0, split))}
          {shelf}
          {grid(indexed.slice(split + 1))}
        </>
      )}
      {building !== undefined && customWidgets && (
        <WidgetBuilder
          {...(building ? { initial: building } : {})}
          taken={state.widgets.map(({ id }) => id)}
          onSave={state.saveWidget}
          onClose={() => setBuilding(undefined)}
        />
      )}
      <div onKeyDown={keepEscapeInside}>{confirmation}</div>
    </>
  );
}
