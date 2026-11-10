import {
  customWidgetId,
  DASHBOARD_IDS,
  DASHBOARD_SHELF,
  DASHBOARD_TILE_IDS,
  DASHBOARD_WIDGET_IDS,
  DASHBOARD_WIDTHS,
  isCustomWidgetSlot,
  WIDGET_LIMITS,
  type DashboardId,
  type DashboardPlacement,
  type DashboardSlotId,
  type DashboardWidth,
} from "@leaflogue/contracts";

/**
 * Dashboard layouts, checked the same way wherever they are kept: the
 * desktop's settings file, or a hosted backend for the web app.
 */

const TILE_IDS: ReadonlySet<string> = new Set(DASHBOARD_TILE_IDS);
const WIDGET_IDS: ReadonlySet<string> = new Set([...DASHBOARD_WIDGET_IDS, DASHBOARD_SHELF]);
const WIDTHS: ReadonlySet<string> = new Set(DASHBOARD_WIDTHS);

/** A custom widget's ID: lowercase letters, digits, and dashes inside. */
export const CUSTOM_WIDGET_ID = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;

/** `custom:<id>`, whether or not that widget still exists. */
function isCustomPlacement(widget: string): boolean {
  if (!isCustomWidgetSlot(widget)) return false;
  const id = customWidgetId(widget);
  return id.length <= WIDGET_LIMITS.id && CUSTOM_WIDGET_ID.test(id);
}

export function isDashboardId(value: unknown): value is DashboardId {
  return typeof value === "string" && (DASHBOARD_IDS as readonly string[]).includes(value);
}

/**
 * Validate one dashboard's widget list, in the order the reader arranged it.
 * Without `customWidgets`, only Leaflogue's own widgets (and the books) may
 * be placed.
 */
export function parseDashboardLayout(value: unknown, options: { readonly customWidgets?: boolean } = {}): DashboardPlacement[] {
  const customWidgets = options.customWidgets ?? true;
  if (!Array.isArray(value)) throw new Error("A dashboard layout must be a list of widgets");
  if (value.length > WIDGET_IDS.size + (customWidgets ? WIDGET_LIMITS.widgets : 0)) throw new Error("A dashboard layout lists too many widgets");
  const seen = new Set<string>();
  return value.map((entry: unknown, index) => {
    const position = `Dashboard widget ${index + 1}`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(`${position} is invalid`);
    const { widget, width, tall, ...rest } = entry as Record<string, unknown>;
    if (Object.keys(rest).length > 0) throw new Error(`${position} has unknown fields`);
    if (typeof widget !== "string" || !(WIDGET_IDS.has(widget) || (customWidgets && isCustomPlacement(widget)))) throw new Error(`${position} is not a known widget`);
    if (seen.has(widget)) throw new Error(`${position} repeats "${widget}"`);
    seen.add(widget);
    if (width !== undefined && (typeof width !== "string" || !WIDTHS.has(width))) throw new Error(`${position} has an invalid width`);
    if (tall !== undefined && typeof tall !== "boolean") throw new Error(`${position} has an invalid height`);
    // A tile is always one sixth of a row and one row high; the books always take the whole width.
    if (TILE_IDS.has(widget) || widget === DASHBOARD_SHELF) return { widget: widget as DashboardSlotId };
    return {
      widget: widget as DashboardSlotId,
      ...(width !== undefined ? { width: width as DashboardWidth } : {}),
      ...(tall === true ? { tall: true } : {}),
    };
  });
}
