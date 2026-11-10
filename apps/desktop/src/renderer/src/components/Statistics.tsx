import { useEffect, useState } from "react";
import type { LibraryStatistics } from "@leaflogue/contracts";
import { TitleRow } from "@leaflogue/ui";
import { useDesktop } from "../host";
import { href } from "../router";
import { Empty, InlineError, Loading } from "./shared";
import { readingSummary } from "./reading-summary";
import { Dashboard, DashboardControls, useDashboard } from "./dashboard/Dashboard";
import styles from "./statistics.module.css";
import { useCommands } from "../palette/commands";

export function StatisticsPage() {
  const [statistics, setStatistics] = useState<LibraryStatistics>();
  const [error, setError] = useState("");
  const dashboard = useDashboard("statistics");
  const desktop = useDesktop();
  useCommands(statistics && !dashboard.editing && dashboard.layout && !(statistics.totals.books === 0 && statistics.totals.highlights === 0)
    ? [{ id: "page.customise", title: "Customise this page", subtitle: "Arrange the statistics widgets", keywords: "dashboard widgets layout", icon: "layout", run: dashboard.start }]
    : []);
  useEffect(() => {
    let active = true;
    window.leaflogue.statistics.get().then(
      (result) => { if (active) setStatistics(result); },
      () => { if (active) setError("Leaflogue could not work out your reading statistics."); },
    );
    return () => { active = false; };
  }, []);

  const empty = statistics && statistics.totals.books === 0 && statistics.totals.highlights === 0;
  const summary = statistics ? readingSummary(statistics) : undefined;

  return (
    <div className={styles.page}>
      <TitleRow
        title="Your reading"
        meta={desktop ? "Drawn from your library on this computer. Nothing extra is tracked." : "Drawn from your library as it is. Nothing extra is tracked."}
        actions={statistics && !empty ? <DashboardControls state={dashboard} /> : undefined}
      />
      <InlineError>{error}</InlineError>
      {!statistics && !error && <Loading>Counting your books…</Loading>}
      {empty && (
        <Empty title="Nothing to count yet">
          <p className="ll-muted">Add or import some books and these numbers will fill in. <a className="ll-text-link" href={href.library()}>Go to your library</a></p>
        </Empty>
      )}
      {statistics && !empty && <Dashboard state={dashboard} statistics={statistics} {...(summary ? { summary } : {})} />}
    </div>
  );
}
