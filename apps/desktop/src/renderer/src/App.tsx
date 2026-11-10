import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Leaf, RefreshCw } from "./components/icons";
import type { SyncStatus, SystemCapabilities } from "@leaflogue/contracts";
import { AppHeader, Icon, NavRail, RAIL_WIDTH, Status, type Crumb, type IconName } from "@leaflogue/ui";
import { activateAppearance } from "./appearance";
import { describeSyncStatus, useSyncStatus, type SyncTone } from "./sync-status";
import { HostContext, hostOf } from "./host";
import { HighlightsPage } from "./components/Highlights";
import { ConflictsPage, ImportNotifications, ImportTool, type ImportRecord } from "./components/Imports";
import { BookPage } from "./components/BookPage";
import { LibraryPage } from "./components/Library";
import { SettingsPage } from "./components/Settings";
import { SyncConflictsPage } from "./components/SyncConflicts";
import { FirstRunSetup } from "./components/Setup";
import { CrumbProvider, ImportDialogProvider, Page } from "./components/shared";
import { ThreadsPage } from "./components/Threads";
import { StatisticsPage } from "./components/Statistics";
import { href, navigate, parseRoute, useHash, type Route } from "./router";
import { Dictionary } from "./components/Dictionary";
import { CommandPalette } from "./palette/CommandPalette";
import { CommandRegistryProvider } from "./palette/commands";


const links = [
  { href: href.library(), label: "Library", icon: "library" as IconName, matches: (route: Route) => route.name === "library" || route.name === "book" },
  { href: href.highlights(), label: "Highlights", icon: "passages" as IconName, matches: (route: Route) => route.name === "highlights" },
  { href: href.threads(), label: "Threads", icon: "threads" as IconName, matches: (route: Route) => route.name === "threads" || route.name === "thread" },
  { href: href.statistics(), label: "Statistics", icon: "statistics" as IconName, matches: (route: Route) => route.name === "statistics" },
] as const;

/** Where the header's breadcrumb starts for each page; a page may add its own last step. */
function baseCrumbs(route: Route): Crumb[] {
  switch (route.name) {
    case "library": return [{ label: "Library" }];
    case "book": return [{ label: "Library", href: href.library() }];
    case "highlights": return [{ label: "Highlights" }];
    case "threads": return [{ label: "Threads" }];
    case "thread": return [{ label: "Threads", href: href.threads() }];
    case "statistics": return [{ label: "Statistics" }];
    case "settings": return [{ label: "Settings" }];
    case "import": return [{ label: "Import" }];
    case "conflicts": return [{ label: "Library", href: href.library() }, { label: "Review import changes" }];
    case "sync-conflicts": return [{ label: "Settings", href: href.settings() }, { label: "Review synced changes" }];
  }
}

const titles: Readonly<Record<Route["name"], string>> = {
  library: "Library",
  book: "Book",
  highlights: "Highlights",
  threads: "Threads",
  thread: "Thread",
  statistics: "Statistics",
  settings: "Settings",
  import: "Import",
  conflicts: "Review import changes",
  "sync-conflicts": "Review synced changes",
};

const RAIL_KEY = "leaflogue.sidebar";

/** Whether the sidebar shows its labels, and how wide it is: a per-device convenience kept in this window's storage. */
function useSidebar() {
  const [state, setState] = useState<{ expanded: boolean; width: number }>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(RAIL_KEY) ?? "null") as { expanded?: unknown; width?: unknown } | null;
      return {
        expanded: saved?.expanded === true,
        width: typeof saved?.width === "number" && Number.isFinite(saved.width) ? saved.width : RAIL_WIDTH.default,
      };
    } catch {
      return { expanded: false, width: RAIL_WIDTH.default };
    }
  });
  useEffect(() => {
    try { localStorage.setItem(RAIL_KEY, JSON.stringify(state)); } catch { /* storage unavailable: the choice lasts this session */ }
  }, [state]);
  // ⌘B (Ctrl B) folds or opens the sidebar from anywhere.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== "b" || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
      setState((current) => ({ ...current, expanded: !current.expanded }));
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  return {
    ...state,
    setExpanded: (expanded: boolean) => setState((current) => ({ ...current, expanded })),
    toggle: () => setState((current) => ({ ...current, expanded: !current.expanded })),
    setWidth: (width: number) => setState((current) => ({ ...current, width })),
  };
}

export function App() {
  const sidebar = useSidebar();
  const hash = useHash();
  const route = parseRoute(hash);
  const [capabilities, setCapabilities] = useState<SystemCapabilities>();
  const [failed, setFailed] = useState(false);
  const [crumb, setCrumb] = useState<string>();
  const [importHistory, setImportHistory] = useState<readonly ImportRecord[]>([]);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [libraryVersion, setLibraryVersion] = useState(0);
  const [syncConflicts, setSyncConflicts] = useState(0);
  const [updateVersion, setUpdateVersion] = useState<string>();
  const previousHash = useRef(hash);

  // Import is a page; anything that offers it goes there.
  const openImport = useCallback(() => navigate(href.import()), []);
  const setupFinished = useRef(false);
  const completeSetup = useCallback((next: SystemCapabilities) => {
    setupFinished.current = true;
    setCapabilities(next);
  }, []);

  // The setup wizard has no trigger to hand focus back to, and unmounting its
  // dialog would otherwise leave focus nowhere. Start the reader at the page.
  useEffect(() => {
    if (!setupFinished.current || capabilities?.setupRequired) return;
    setupFinished.current = false;
    document.getElementById("content")?.focus();
  }, [capabilities]);

  useEffect(() => {
    if (!window.location.hash) window.history.replaceState(null, "", href.library());
    let active = true;
    window.leaflogue.system.getCapabilities().then(
      (result) => active && setCapabilities(result),
      () => active && setFailed(true),
    );
    const stop = window.leaflogue.appearance.onChanged((result) => activateAppearance(result));
    const stopUpdates = window.leaflogue.updates.onAvailable((version) => setUpdateVersion(version));
    return () => {
      active = false;
      stop();
      stopUpdates();
    };
  }, []);

  useEffect(() => {
    if (previousHash.current !== hash) {
      if (route.name !== "book" || !route.highlightId) window.scrollTo?.({ top: 0 });
    }
    previousHash.current = hash;
    document.querySelectorAll("details[open]").forEach((details) => details.removeAttribute("open"));
    document.title = `${titles[route.name]} | Leaflogue`;
  }, [hash, route.name]); // eslint-disable-line react-hooks/exhaustive-deps

  const countSyncConflicts = useCallback(() => {
    window.leaflogue.sync.listConflicts().then(
      (page) => setSyncConflicts(page.total),
      () => undefined,
    );
  }, []);
  useEffect(countSyncConflicts, [countSyncConflicts, hash, libraryVersion]);

  // When a sync brings in changes, the open page reloads to show them.
  const sync = useSyncStatus();
  const seenSync = useRef<number | undefined>(undefined);
  useEffect(() => {
    const finishedAt = sync?.lastFinishedAt;
    if (finishedAt === undefined || finishedAt === seenSync.current) return;
    seenSync.current = finishedAt;
    const result = sync?.lastResult;
    if (result && result.pulled + result.bootstrapped > 0) setLibraryVersion((current) => current + 1);
    else countSyncConflicts();
  }, [sync, countSyncConflicts]);

  const recordImport = useCallback((record: ImportRecord) => {
    setImportHistory((current) => [record, ...current].slice(0, 50));
    if (record.receipt) setLibraryVersion((current) => current + 1);
  }, []);
  const notifications = importHistory.filter((record) => !dismissed.has(record.id));
  // Settings and Import keep their state while the library changes under them.
  // Threads keep their list while a different thread is opened beside it.
  const pageKey = route.name === "settings" || route.name === "import"
    ? route.name
    : route.name === "threads" || route.name === "thread"
    ? `threads:${libraryVersion}`
    : route.name === "highlights"
    ? `highlights:${route.search ?? ""}:${route.tagId ?? ""}:${route.bookId ?? ""}:${libraryVersion}`
    : route.name === "library"
    ? `library:${route.collectionId ?? ""}:${route.tagId ?? ""}:${libraryVersion}`
    : `${route.name}:${"bookId" in route ? route.bookId : ""}:${libraryVersion}`;

  const crumbs = [...baseCrumbs(route), ...(crumb ? [{ label: crumb }] : [])];
  const { expanded: sidebarExpanded, toggle: toggleSidebar } = sidebar;
  const syncOn = sync !== undefined && sync.state !== "off";
  const host = hostOf(capabilities?.host);
  const paletteShell = useMemo(() => ({ host, sidebarExpanded, toggleSidebar, syncOn }), [host, sidebarExpanded, toggleSidebar, syncOn]);
  const mac = document.documentElement.dataset.platform === "darwin";

  return (
    <HostContext.Provider value={host}>
    <ImportDialogProvider value={openImport}>
    <CrumbProvider value={setCrumb}>
    <CommandRegistryProvider>
      <a href="#content" className="ll-skip" onClick={(event) => { event.preventDefault(); document.getElementById("content")?.focus(); }}>Skip to content</a>
      <AppHeader brand="Leaflogue" brandHref={href.library()} brandIcon={<Leaf size={16} strokeWidth={1.8} aria-hidden="true" />} crumbs={crumbs} {...(mac ? { inset: "traffic-lights" as const } : {})}>
        <Dictionary />
        <CommandPalette shell={paletteShell} />
        <LocalState capabilities={capabilities} failed={failed} sync={sync} />
        <ImportNotifications
          history={notifications}
          syncConflicts={syncConflicts}
          updateVersion={updateVersion}
          onOpenImport={openImport}
          onDismiss={(id) => setDismissed((current) => new Set([...current, ...(id ? [id] : notifications.map((record) => record.id))]))}
        />
      </AppHeader>
      <div className="ui-frame">
        <NavRail
          label="Main navigation"
          expanded={sidebar.expanded}
          width={sidebar.width}
          onExpandedChange={sidebar.setExpanded}
          onWidthChange={sidebar.setWidth}
          toggleShortcut={document.documentElement.dataset.platform === "darwin" ? "⌘B" : "Ctrl+B"}
          items={[
            ...links.map(({ href: target, label, icon, matches }) => ({ href: target, label, icon: <Icon name={icon} />, current: matches(route) })),
            { href: href.import(), label: "Import", icon: <Icon name="import" />, current: route.name === "import" || route.name === "conflicts", placement: "gap" as const, hideOnPhone: true },
            { href: href.settings(), label: "Settings", icon: <Icon name="settings" />, current: route.name === "settings" || route.name === "sync-conflicts", placement: "end" as const },
          ]}
        />
        <div id="content" tabIndex={-1} className="ui-main">
          <Page key={pageKey}>
            {route.name === "library" && <LibraryPage {...(route.collectionId ? { initialCollectionId: route.collectionId } : {})} {...(route.tagId ? { initialTagId: route.tagId } : {})} />}
            {route.name === "book" && <BookPage bookId={route.bookId} focusHighlightId={route.highlightId} mergeWith={route.mergeWith} />}
            {route.name === "highlights" && <HighlightsPage {...(route.search ? { initialSearch: route.search } : {})} {...(route.tagId ? { initialTagId: route.tagId } : {})} {...(route.bookId ? { initialBookId: route.bookId } : {})} />}
            {(route.name === "threads" || route.name === "thread") && <ThreadsPage {...(route.name === "thread" ? { selectedId: route.threadId } : {})} />}
            {route.name === "statistics" && <StatisticsPage />}
            {route.name === "settings" && <SettingsPage
              capabilities={capabilities}
              onLibraryReplaced={() => setLibraryVersion((current) => current + 1)}
              onConfigLocationChanged={() => void window.leaflogue.system.getCapabilities().then(setCapabilities)}
            />}
            {route.name === "import" && <ImportTool history={importHistory} onImported={recordImport} />}
            {route.name === "conflicts" && <ConflictsPage />}
            {route.name === "sync-conflicts" && <SyncConflictsPage onChanged={countSyncConflicts} />}
          </Page>
        </div>
      </div>
      {capabilities?.setupRequired && (
        <FirstRunSetup capabilities={capabilities} onComplete={completeSetup} />
      )}
    </CommandRegistryProvider>
    </CrumbProvider>
    </ImportDialogProvider>
    </HostContext.Provider>
  );
}

const syncTones: Record<SyncTone, "good" | "busy" | "bad" | undefined> = {
  ready: undefined,
  syncing: "busy",
  synced: "good",
  attention: "busy",
  failed: "bad",
};

/** Where the library lives: on this computer, and once sync is set up, how it stands with the others. */
function LocalState({ capabilities, failed, sync }: {
  readonly capabilities?: SystemCapabilities;
  readonly failed: boolean;
  readonly sync?: SyncStatus;
}) {
  const available = capabilities?.persistenceAvailable === true;
  if (capabilities?.host?.kind === "web") {
    return <Status tone="good" label="Saved online" {...(capabilities.host.account ? { detail: `Signed in as ${capabilities.host.account}` } : {})} />;
  }
  if (!available || !sync || sync.state === "off") {
    return (
      <Status
        tone={available ? "good" : failed ? "bad" : undefined}
        label={available ? "Saved locally" : failed ? "Storage unavailable" : "Opening library…"}
        {...(available ? { detail: `Local database schema ${capabilities.databaseSchemaVersion}` } : {})}
      />
    );
  }
  const { label, tone, detail } = describeSyncStatus(sync);
  return (
    <span className="ll-sync-state">
      <Status tone={syncTones[tone]} label={label} detail={detail} href={href.settings()} />
      <button
        type="button"
        className="ui-icon-btn ll-sync-button"
        aria-label="Sync now"
        title="Sync now"
        aria-busy={tone === "syncing"}
        onClick={() => { void window.leaflogue.sync.run().catch(() => undefined); }}
      >
        <RefreshCw size={15} strokeWidth={1.7} aria-hidden="true" />
      </button>
    </span>
  );
}
