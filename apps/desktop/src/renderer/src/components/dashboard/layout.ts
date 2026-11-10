import { customWidgetSlot, DASHBOARD_SHELF, DASHBOARD_TILE_IDS, DASHBOARD_WIDGET_IDS, DASHBOARD_WIDTHS, isCustomWidgetSlot, type CustomWidget, type CustomWidgetSlot, type DashboardId, type DashboardItemId, type DashboardPlacement, type DashboardSlotId, type DashboardWidth } from "@leaflogue/contracts";

export type Layout = readonly DashboardPlacement[];

/** The reader's own widgets, by the slot a layout places them in. */
export type CustomWidgets = ReadonlyMap<CustomWidgetSlot, CustomWidget>;
const NO_CUSTOM_WIDGETS: CustomWidgets = new Map();

export function customWidgetsBySlot(widgets: readonly CustomWidget[]): CustomWidgets {
  return new Map(widgets.map((widget) => [customWidgetSlot(widget.id), widget]));
}

const TILES: ReadonlySet<DashboardSlotId> = new Set(DASHBOARD_TILE_IDS);
/** A tile is a small numbered card: the built-in ones, and custom widgets that show a number. */
export const isTile = (widget: DashboardSlotId, custom: CustomWidgets = NO_CUSTOM_WIDGETS): boolean =>
  isCustomWidgetSlot(widget) ? custom.get(widget)?.show === "number" : TILES.has(widget);
export const isShelf = (widget: DashboardSlotId): widget is typeof DASHBOARD_SHELF => widget === DASHBOARD_SHELF;

/** What each page shows until the reader rearranges it. */
export const DEFAULT_LAYOUTS: Readonly<Record<DashboardId, Layout>> = {
  library: [
    { widget: "passages" }, { widget: "notes" }, { widget: "finished" },
    { widget: "active-days" }, { widget: "longest-run" }, { widget: "busiest-day" },
    { widget: "activity", width: "half" }, { widget: "top-books", width: "half" },
    { widget: "series", width: "half" }, { widget: "daily", width: "half" },
    { widget: DASHBOARD_SHELF },
  ],
  statistics: [
    { widget: "passages" }, { widget: "books" }, { widget: "finished" },
    { widget: "active-days" }, { widget: "longest-run" }, { widget: "busiest-day" },
    { widget: "activity", width: "full" },
    { widget: "months" }, { widget: "weekdays" }, { widget: "coverage" },
    { widget: "top-authors", tall: true }, { widget: "top-books", tall: true },
    { widget: "lengths" }, { widget: "finished-years" },
  ],
};

export const WIDTH_LABELS: Readonly<Record<DashboardWidth, string>> = {
  third: "One third",
  half: "Half",
  "two-thirds": "Two thirds",
  full: "Full width",
};

export function widthOf(placement: DashboardPlacement): DashboardWidth {
  return isShelf(placement.widget) ? "full" : placement.width ?? "third";
}

/**
 * Keep only one entry per known widget, in order, so a stale layout never
 * breaks a page: a custom widget that was deleted simply goes. The library
 * always has its books somewhere, after every widget unless the reader moved
 * them; no other page has them.
 */
export function normalize(layout: Layout, dashboard: DashboardId, custom: CustomWidgets = NO_CUSTOM_WIDGETS): Layout {
  const seen = new Set<DashboardSlotId>();
  const known = new Set<string>([...(dashboard === "library" ? [...DASHBOARD_WIDGET_IDS, DASHBOARD_SHELF] : DASHBOARD_WIDGET_IDS), ...custom.keys()]);
  const kept = layout.filter(({ widget }) => {
    if (!known.has(widget) || seen.has(widget)) return false;
    seen.add(widget);
    return true;
  });
  return dashboard === "library" && !seen.has(DASHBOARD_SHELF) ? [...kept, { widget: DASHBOARD_SHELF }] : kept;
}

export function move(layout: Layout, widget: DashboardSlotId, to: number): Layout {
  const from = layout.findIndex((entry) => entry.widget === widget);
  if (from < 0) return layout;
  const target = Math.max(0, Math.min(layout.length - 1, to));
  if (target === from) return layout;
  const next = [...layout];
  const [entry] = next.splice(from, 1);
  next.splice(target, 0, entry!);
  return next;
}

export function update(layout: Layout, widget: DashboardItemId, change: { readonly width?: DashboardWidth; readonly tall?: boolean }, custom: CustomWidgets = NO_CUSTOM_WIDGETS): Layout {
  return layout.map((entry) => {
    if (entry.widget !== widget || isTile(widget, custom)) return entry;
    const width = change.width ?? entry.width;
    const tall = change.tall ?? entry.tall;
    return { widget, ...(width && width !== "third" ? { width } : {}), ...(tall ? { tall: true } : {}) };
  });
}

export function remove(layout: Layout, widget: DashboardItemId): Layout {
  return layout.filter((entry) => entry.widget !== widget);
}

/** Tiles join the end of the tiles already shown; panels go after the other widgets, above the books. */
export function add(layout: Layout, widget: DashboardItemId, custom: CustomWidgets = NO_CUSTOM_WIDGETS): Layout {
  if (layout.some((entry) => entry.widget === widget)) return layout;
  const next = [...layout];
  if (isTile(widget, custom)) {
    const lastTile = layout.reduce((last, entry, index) => (isTile(entry.widget, custom) ? index : last), -1);
    next.splice(lastTile + 1, 0, { widget });
    return next;
  }
  const shelf = layout.findIndex((entry) => isShelf(entry.widget));
  next.splice(shelf < 0 ? next.length : shelf, 0, { widget });
  return next;
}

export function sameLayout(a: Layout, b: Layout): boolean {
  return a.length === b.length && a.every((entry, index) => {
    const other = b[index]!;
    return entry.widget === other.widget && widthOf(entry) === widthOf(other) && !!entry.tall === !!other.tall;
  });
}

export const WIDTHS = DASHBOARD_WIDTHS;
