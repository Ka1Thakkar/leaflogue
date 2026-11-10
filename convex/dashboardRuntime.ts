import { DASHBOARD_IDS, type DashboardPlacement } from "@leaflogue/contracts";
import { parseDashboardLayout } from "@leaflogue/domain";
import type { DataModelFromSchemaDefinition, GenericQueryCtx, MutationBuilder, QueryBuilder } from "convex/server";
import { mutationGeneric, queryGeneric } from "convex/server";
import { ConvexError, v } from "convex/values";
import { accessFailure, requireLibraryAccess } from "./accessControl";
import { identityKey } from "./hostIdentity";
import schema from "./schema";

/**
 * How each reader of the web app arranged the library and statistics pages.
 * A layout belongs to one reader in one library, so it is a preference, not
 * part of the library: it is never synced, and anyone who can read the
 * library may arrange their own view of it. The desktop app keeps its
 * layouts in its settings file instead. Custom widgets are not stored here.
 */

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
const query = queryGeneric as QueryBuilder<DataModel, "public">;
const mutation = mutationGeneric as MutationBuilder<DataModel, "public">;

const dashboardValidator = v.union(...DASHBOARD_IDS.map((id) => v.literal(id)));
const placementValidator = v.object({ widget: v.string(), width: v.optional(v.string()), tall: v.optional(v.boolean()) });
const layoutsValidator = v.object({
  library: v.optional(v.array(placementValidator)),
  statistics: v.optional(v.array(placementValidator)),
});

type Layouts = { library?: DashboardPlacement[]; statistics?: DashboardPlacement[] };
type ReadContext = Pick<GenericQueryCtx<DataModel>, "auth" | "db">;

async function reader(ctx: ReadContext, libraryId: string): Promise<string> {
  await requireLibraryAccess(ctx, libraryId, "read");
  const identity = await identityKey(ctx);
  if (!identity) throw accessFailure("LEAFLOGUE_AUTH_REQUIRED", "Authentication is required");
  return identity;
}

async function readLayouts(ctx: ReadContext, libraryId: string, identity: string): Promise<Layouts> {
  const rows = await ctx.db.query("dashboardLayouts")
    .withIndex("by_identity_and_library", (q) => q.eq("identityTokenIdentifier", identity).eq("libraryId", libraryId))
    .take(DASHBOARD_IDS.length);
  const layouts: Layouts = {};
  for (const row of rows) {
    // A layout saved by an older build that no longer validates falls back to the default.
    try { layouts[row.dashboard] = parseDashboardLayout(row.layout, { customWidgets: false }); } catch { /* default */ }
  }
  return layouts;
}

/** The signed-in reader's saved layouts; a dashboard left out uses the default. */
export const layouts = query({
  args: { libraryId: v.string() },
  returns: layoutsValidator,
  handler: async (ctx, args) => readLayouts(ctx, args.libraryId, await reader(ctx, args.libraryId)),
});

/** Save one dashboard's layout for the signed-in reader; `null` returns it to the default. */
export const saveLayout = mutation({
  args: { libraryId: v.string(), dashboard: dashboardValidator, layout: v.union(v.null(), v.array(placementValidator)) },
  returns: layoutsValidator,
  handler: async (ctx, args) => {
    const identity = await reader(ctx, args.libraryId);
    let layout: DashboardPlacement[] | null = null;
    if (args.layout !== null) {
      try {
        layout = parseDashboardLayout(args.layout, { customWidgets: false });
      } catch (error) {
        throw new ConvexError({ code: "LEAFLOGUE_INVALID_LAYOUT", message: error instanceof Error ? error.message : "That layout is not valid" });
      }
    }
    const saved = await ctx.db.query("dashboardLayouts")
      .withIndex("by_identity_and_library", (q) => q.eq("identityTokenIdentifier", identity).eq("libraryId", args.libraryId).eq("dashboard", args.dashboard))
      .unique();
    if (layout === null) {
      if (saved) await ctx.db.delete(saved._id);
    } else if (saved) {
      await ctx.db.patch(saved._id, { layout, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("dashboardLayouts", { libraryId: args.libraryId, identityTokenIdentifier: identity, dashboard: args.dashboard, layout, updatedAt: Date.now() });
    }
    return readLayouts(ctx, args.libraryId, identity);
  },
});
