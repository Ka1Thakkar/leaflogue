import type { DashboardId, DashboardPlacement } from "@leaflogue/contracts";
import { isDashboardId, parseDashboardLayout } from "@leaflogue/domain";
import { requireUser, type RequestContext } from "./context";
import { ServerError } from "./errors";

/**
 * How each reader arranged the library and statistics pages, as Convex's
 * `dashboardRuntime` keeps them: one reader's preference in one library,
 * never synced. Custom widgets are not stored on the web.
 */

type Layouts = { -readonly [K in DashboardId]?: DashboardPlacement[] };

export async function layouts(context: RequestContext, libraryId: string): Promise<Layouts> {
  const user = requireUser(context);
  const rows = await context.client.query<{ dashboard: string; layout: unknown }>(
    "SELECT dashboard, layout FROM leaflogue_web.dashboard_layouts WHERE library_id = $1 AND user_id = $2",
    [libraryId, user.userId],
  );
  const result: Layouts = {};
  for (const row of rows.rows) {
    if (!isDashboardId(row.dashboard)) continue;
    const stored = typeof row.layout === "string" ? JSON.parse(row.layout) as unknown : row.layout;
    // A layout an older server saved that no longer validates falls back to the default.
    try { result[row.dashboard] = parseDashboardLayout(stored, { customWidgets: false }); } catch { /* default */ }
  }
  return result;
}

export async function saveLayout(context: RequestContext, libraryId: string, dashboard: DashboardId, layout: unknown[] | null): Promise<Layouts> {
  const user = requireUser(context);
  if (layout === null) {
    await context.client.query(
      "DELETE FROM leaflogue_web.dashboard_layouts WHERE library_id = $1 AND user_id = $2 AND dashboard = $3",
      [libraryId, user.userId, dashboard],
    );
  } else {
    let checked: DashboardPlacement[];
    try {
      checked = parseDashboardLayout(layout, { customWidgets: false });
    } catch (error) {
      throw new ServerError("LEAFLOGUE_INVALID_LAYOUT", error instanceof Error ? error.message : "That layout is not valid");
    }
    await context.client.query(`
      INSERT INTO leaflogue_web.dashboard_layouts (library_id, user_id, dashboard, layout, updated_at) VALUES ($1, $2, $3, $4::jsonb, now())
      ON CONFLICT (library_id, user_id, dashboard) DO UPDATE SET layout = excluded.layout, updated_at = now()
    `, [libraryId, user.userId, dashboard, JSON.stringify(checked)]);
  }
  return layouts(context, libraryId);
}
