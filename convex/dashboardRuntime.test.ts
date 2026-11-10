// @vitest-environment edge-runtime

import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "./schema";
import { convexModules } from "./test.setup";

const OWNER = "https://host.example|owner";
const VIEWER = "https://host.example|viewer";
const STRANGER = "https://host.example|stranger";

type Placement = { widget: string; width?: string; tall?: boolean };
type Layouts = { library?: Placement[]; statistics?: Placement[] };

const provisionHostOwner = makeFunctionReference<"mutation", { identityTokenIdentifier: string }, { libraryId: string }>("access:provisionHostOwner");
const provisionLibrary = makeFunctionReference<"mutation", { libraryId: string; identityTokenIdentifier: string; role?: "owner" | "editor" | "viewer" }, unknown>("access:provisionLibrary");
const layouts = makeFunctionReference<"query", { libraryId: string }, Layouts>("dashboardRuntime:layouts");
const saveLayout = makeFunctionReference<"mutation", { libraryId: string; dashboard: "library" | "statistics"; layout: Placement[] | null }, Layouts>("dashboardRuntime:saveLayout");

async function library() {
  const t = convexTest(schema, convexModules);
  const { libraryId } = await t.mutation(provisionHostOwner, { identityTokenIdentifier: OWNER });
  await t.mutation(provisionLibrary, { libraryId, identityTokenIdentifier: VIEWER, role: "viewer" });
  return { t, libraryId, owner: t.withIdentity({ tokenIdentifier: OWNER }), viewer: t.withIdentity({ tokenIdentifier: VIEWER }) };
}

describe("dashboard layouts for web readers", () => {
  it("keeps each reader's own arrangement, and returns to the default", async () => {
    const { owner, viewer, libraryId } = await library();
    expect(await owner.query(layouts, { libraryId })).toEqual({});
    const saved = await owner.mutation(saveLayout, { libraryId, dashboard: "library", layout: [{ widget: "on-this-day", width: "half", tall: true }, { widget: "shelf" }, { widget: "passages", width: "full" }] });
    // Tiles and the books take no width; the stored layout is the checked one.
    expect(saved).toEqual({ library: [{ widget: "on-this-day", width: "half", tall: true }, { widget: "shelf" }, { widget: "passages" }] });
    // A viewer may arrange their own view without touching the owner's.
    await viewer.mutation(saveLayout, { libraryId, dashboard: "statistics", layout: [{ widget: "hours" }] });
    expect(await viewer.query(layouts, { libraryId })).toEqual({ statistics: [{ widget: "hours" }] });
    expect(await owner.query(layouts, { libraryId })).toEqual(saved);
    expect(await owner.mutation(saveLayout, { libraryId, dashboard: "library", layout: null })).toEqual({});
  });

  it("refuses custom widgets, unknown widgets, and readers outside the library", async () => {
    const { t, owner, libraryId } = await library();
    await expect(owner.mutation(saveLayout, { libraryId, dashboard: "library", layout: [{ widget: "custom:my-widget" }] })).rejects.toThrow();
    await expect(owner.mutation(saveLayout, { libraryId, dashboard: "library", layout: [{ widget: "nonsense" }] })).rejects.toThrow();
    await expect(owner.mutation(saveLayout, { libraryId, dashboard: "library", layout: [{ widget: "months" }, { widget: "months" }] })).rejects.toThrow();
    const stranger = t.withIdentity({ tokenIdentifier: STRANGER });
    await expect(stranger.query(layouts, { libraryId })).rejects.toThrow();
    await expect(stranger.mutation(saveLayout, { libraryId, dashboard: "library", layout: [] })).rejects.toThrow();
    await expect(t.query(layouts, { libraryId })).rejects.toThrow();
  });
});
