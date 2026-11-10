import type { DashboardLayouts, DashboardPlacement, LeaflogueBridge } from "@leaflogue/contracts";
import { desktopOnly, type LibraryClient } from "./client";

/**
 * The reader's arrangement of the library and statistics pages, kept by the
 * backend for each reader, so it follows them to any browser. Custom widgets
 * are a desktop feature: the web app lists none and cannot add any.
 */

type Layouts = Pick<DashboardLayouts, "library" | "statistics">;

export function createDashboards(client: LibraryClient): LeaflogueBridge["dashboards"] {
  return {
    describe: () => client.query<Layouts>("dashboardRuntime:layouts"),
    save: (dashboard, layout: readonly DashboardPlacement[] | null) =>
      client.mutation<Layouts>("dashboardRuntime:saveLayout", { dashboard, layout: layout === null ? null : [...layout] }),
  };
}

export function createWidgets(): LeaflogueBridge["widgets"] {
  return {
    save: () => desktopOnly("Building a widget"),
    delete: () => desktopOnly("Deleting a widget"),
    // Never asked for: the web app places no custom widgets.
    evaluate: () => desktopOnly("Counting a custom widget"),
    export: () => desktopOnly("Exporting a widget"),
    import: () => desktopOnly("Importing widgets"),
  };
}
