import { useContextWorkspace } from "./ContextPanel";

import { Menu, MenuItem } from "@leaflogue/ui";

import { Select, SelectItem } from "@leaflogue/ui";
import { useCallback, useContext, useDeferredValue, useEffect, useId, useRef, useState, type RefObject } from "react";
import { ArrowDownWideNarrow, BookOpen, CalendarDays, Filter, History, MoreHorizontal, Network, Pencil, Plus, Rows3, Search, Sparkles, StickyNote, Tags, Trash2, X } from "../components/icons";
import type { Book, BookId, HighlightId, HighlightListEntry, HighlightQuery, LibraryStatistics, Tag, TagId } from "@leaflogue/contracts";
import { Bars, Facet, Panel, StatTile, TitleRow } from "@leaflogue/ui";
import { href } from "../router";
import { aiAvailable } from "../palette/actions";
import { useCommands } from "../palette/commands";
import { useConfirm } from "./Confirm";
import { DatePicker } from "./DatePicker";
import { countOf, Dialog, Empty, FilterToggle, ImportTrigger, InlineError, Loading, PassageText } from "./shared";
import styles from "./knowledge.module.css";
import sheet from "./highlights.module.css";
import { HighlightForm, NoteCard, NoteForm } from "./PassageForms";
import { HighlightTags, HighlightThreads, ImportedOriginal, PassageContext } from "./PassageActions";

const PAGE_SIZE = 20;

function Annotation({ highlight, showBook, focused = false }: { readonly highlight: HighlightListEntry; readonly showBook: boolean; readonly focused?: boolean }) {
  const contextWorkspace = useContextWorkspace();
  const { tags, reload, readOnly, aiEnabled, activeId, setActiveId } = useContext(PassageContext);
  const [confirm, confirmDialog] = useConfirm();
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [deleted, setDeleted] = useState(false);
  const explainTrigger = useRef<HTMLButtonElement>(null);
  const noteTrigger = useRef<HTMLButtonElement>(null);
  const excerpt = highlight.text.length > 70 ? `${highlight.text.slice(0, 70).trimEnd()}…` : highlight.text;
  // The passage in hand offers its actions in the palette.
  useCommands(activeId === highlight.id && !readOnly && !deleted && !editing ? [
    ...(aiEnabled ? [{ id: "passage.explain", title: "Explain this passage", subtitle: excerpt, icon: "explain" as const, keywords: "ai companion reading", ai: true, run: () => explainTrigger.current?.click() }] : []),
    { id: "passage.add-note", title: "Add a note to this passage", subtitle: excerpt, icon: "note-paper" as const, run: () => noteTrigger.current?.click() },
    { id: "passage.edit", title: "Edit this passage", subtitle: excerpt, icon: "edit" as const, run: () => setEditing(true) },
  ] : []);

  async function remove() {
    const notes = highlight.notes.length;
    if (!await confirm({
      title: "Delete highlight?",
      message: `This deletes the highlight${notes ? ` and its ${notes === 1 ? "note" : `${notes} notes`}` : ""}. This cannot be undone.`,
      confirmLabel: "Delete highlight",
      destructive: true,
    })) return;
    setPending(true);
    setError("");
    try {
      await window.leaflogue.library.deleteHighlight({ id: highlight.id, bookId: highlight.bookId, expectedRevision: highlight.revision });
    } catch {
      setError("This highlight changed before it could be deleted. Reload and try again.");
      setPending(false);
      return;
    }
    setDeleted(true);
    try {
      await reload();
    } catch {
      setError("The highlight was deleted, but this view could not refresh. Reopen the page to update it.");
    } finally {
      setPending(false);
    }
  }

  const tagNames = highlight.tagIds.map((id) => tags.find((tag) => tag.id === id)).filter((tag): tag is Tag => tag !== undefined);
  return (
    <article
      id={`highlight-${highlight.id}`}
      className={styles.annotation}
      aria-label={`Highlight from ${highlight.bookTitle}`}
      onFocus={() => setActiveId?.(highlight.id)}
      // The passage a link opened, e.g. from Today's highlight: marked so the eye lands on it.
      {...(focused ? { "data-focused": "", "aria-current": "true" as const, tabIndex: -1 } : {})}
    >
      <p className={styles.passageMeta}>
        {showBook && <a href={href.book(highlight.bookId)}>{highlight.bookTitle}</a>}
        <time dateTime={new Date(highlight.sourceCreatedAt ?? highlight.createdAt).toISOString()}>
          {new Date(highlight.sourceCreatedAt ?? highlight.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
        </time>
        <span>{highlight.text.length.toLocaleString()} chars</span>
      </p>
      {deleted && !error && <p role="status" className="ll-muted">Highlight deleted.</p>}
      {editing ? (
        <HighlightForm bookId={highlight.bookId} highlight={highlight} onClose={() => setEditing(false)} onSaved={reload} />
      ) : (
        <div className={styles.record}>
          <div className={styles.passage}>
            <blockquote className={styles.quote}>
              <PassageText text={highlight.text} />
            </blockquote>
            {window.leaflogue.epub && contextWorkspace && <button className={styles.contextLink} onClick={() => contextWorkspace.showPassage(highlight)}><BookOpen size={15} aria-hidden="true" />Read in context</button>}
            {highlight.notes.map((note) => <NoteCard key={note.id} note={note} readOnly={readOnly} onSaved={reload} />)}
            {tagNames.length > 0 && <ul className={styles.tagChips} aria-label="Tags">{tagNames.map((tag) => <li key={tag.id}>{tag.name}</li>)}</ul>}
          </div>
          {!readOnly && !deleted && (
            <div className={styles.actions}>
              {aiEnabled && (
                <button className="ll-icon-button" aria-label="Explain this passage" title="Explain this passage" ref={explainTrigger} onClick={() => contextWorkspace?.showAssistant({ highlight, reload, readOnly })}><Sparkles size={18} aria-hidden="true" /></button>
              )}
              <Dialog label="Add to thematic thread" title="Thematic threads" icon={Network} iconOnly>
                {(close) => <HighlightThreads highlight={highlight} onClose={close} />}
              </Dialog>
              <Dialog label="Manage tags" title="Tags for this highlight" icon={Tags} iconOnly>
                {(close) => <HighlightTags highlight={highlight} onClose={close} />}
              </Dialog>
              <Dialog label="Add another note" title="Add a note" icon={StickyNote} iconOnly triggerRef={noteTrigger}>
                {(close) => <NoteForm bookId={highlight.bookId} highlightId={highlight.id} onClose={close} onSaved={reload} />}
              </Dialog>
              <button className="ll-icon-button" aria-label="Edit quote" title="Edit quote" disabled={pending} onClick={() => setEditing(true)}>
                <Pencil size={18} aria-hidden="true" />
              </button>
                  {highlight.imported && (
                    <Dialog label="View imported original" title="Imported original" icon={History} iconOnly>
                      {(close) => <ImportedOriginal highlight={highlight} onClose={close} />}
                    </Dialog>
                  )}
              <Menu trigger={<button type="button" className="ll-icon-button" aria-label="More passage actions" title="More passage actions"><MoreHorizontal size={18} aria-hidden="true" /></button>}>



                  <MenuItem asChild disabled={pending} onSelect={() => void remove()}><button type="button" className={`${styles.menuAction} ${styles.danger}`} disabled={pending}>
                    <Trash2 size={16} aria-hidden="true" />Delete highlight
                  </button></MenuItem>

              </Menu>
              {pending && <span role="status" className="ll-muted">Saving…</span>}
            </div>
          )}
        </div>
      )}
      <InlineError>{error}</InlineError>
      {confirmDialog}
    </article>
  );
}

export interface HighlightFilters {
  readonly search: string;
  readonly source?: "imported" | "manual";
  readonly notes?: "with" | "without";
  readonly tagId?: Tag["id"];
  readonly date?: string;
  readonly dateKind: "created" | "imported";
  readonly sort: "oldest" | "newest" | "updated";
  readonly density: "comfortable" | "compact";
  readonly bookId?: BookId;
}

const DEFAULT_FILTERS: HighlightFilters = { search: "", dateKind: "created", sort: "oldest", density: "compact" };

function localDayBounds(date: string): { readonly dateFrom: number; readonly dateBefore: number } | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  if (!match) return undefined;
  const start = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { dateFrom: start.getTime(), dateBefore: end.getTime() };
}

export function HighlightList({
  bookId,
  filters,
  focusHighlightId,
  readOnly = false,
  aiEnabled = false,
  tags,
  version,
  onChanged,
}: {
  readonly bookId?: BookId;
  readonly filters: HighlightFilters;
  readonly focusHighlightId?: HighlightId;
  readonly readOnly?: boolean;
  readonly aiEnabled?: boolean;
  readonly tags: readonly Tag[];
  readonly version?: number;
  readonly onChanged?: () => void;
}) {
  const search = useDeferredValue(filters.search.trim());
  const [results, setResults] = useState<readonly HighlightListEntry[]>();
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const scrolledTo = useRef("");
  const loaded = useRef(0);
  const [activeId, setActiveId] = useState<HighlightId | undefined>(focusHighlightId);
  const query: HighlightQuery = {
    ...(bookId ?? filters.bookId ? { bookId: bookId ?? filters.bookId } : {}),
    ...(search ? { search } : {}),
    ...(filters.source ? { source: filters.source } : {}),
    ...(filters.notes ? { notes: filters.notes } : {}),
    ...(filters.tagId ? { tagId: filters.tagId } : {}),
    ...(filters.date ? { dateKind: filters.dateKind, ...localDayBounds(filters.date) } : {}),
    sort: search ? "relevance" : filters.sort,
  };
  const queryKey = JSON.stringify(query);

  const fetchRange = useCallback(async (count: number) => {
    const parsed = JSON.parse(queryKey) as HighlightQuery;
    const entries: HighlightListEntry[] = [];
    let more = true;
    while (more && entries.length < count) {
      const limit = Math.min(100, count - entries.length);
      const page = await window.leaflogue.library.listHighlights({ ...parsed, offset: entries.length, limit });
      entries.push(...page.entries);
      more = page.hasMore;
      if (page.entries.length < limit) break;
    }
    return { entries, more };
  }, [queryKey]);

  const load = useCallback(async (count: number, propagateError = false) => {
    const current = request.current + 1;
    request.current = current;
    setError("");
    try {
      const page = await fetchRange(count);
      if (request.current !== current) return;
      loaded.current = page.entries.length;
      setResults(page.entries);
      setHasMore(page.more);
    } catch {
      if (request.current === current) {
        setResults((existing) => existing ?? []);
        setError(propagateError
          ? "Leaflogue could not refresh these passages. Your saved changes were not undone."
          : "Leaflogue could not read these passages. Your library was not changed.");
      }
      if (propagateError) throw new Error("Passage refresh failed");
    }
  }, [fetchRange]);

  useEffect(() => {
    setResults(undefined);
    void load(PAGE_SIZE);
  }, [load]);

  // A changed version means the parent committed a passage elsewhere on the
  // page. Refresh even when nothing was loaded yet: the first passage added to
  // an empty book must replace the empty state. The mount load above already
  // covers the initial version.
  const refreshedVersion = useRef(version);
  useEffect(() => {
    if (version === undefined || version === refreshedVersion.current) return;
    refreshedVersion.current = version;
    void load(Math.max(PAGE_SIZE, loaded.current));
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps

  const reload = useCallback(async () => {
    await load(Math.max(PAGE_SIZE, loaded.current), true);
    onChanged?.();
    window.dispatchEvent(new Event("leaflogue:annotations-changed"));
  }, [load, onChanged]);

  // Appends the next page instead of re-reading everything already shown.
  const loadingMoreRef = useRef(false);
  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setError("");
    const current = request.current;
    setLoadingMore(true);
    try {
      const parsed = JSON.parse(queryKey) as HighlightQuery;
      const page = await window.leaflogue.library.listHighlights({ ...parsed, offset: loaded.current, limit: PAGE_SIZE });
      // A refresh or a new filter started meanwhile; its results win.
      if (request.current !== current) return;
      loaded.current += page.entries.length;
      setResults((existing) => {
        const seen = new Set(existing?.map(({ id }) => id));
        return [...(existing ?? []), ...page.entries.filter(({ id }) => !seen.has(id))];
      });
      setHasMore(page.hasMore && page.entries.length > 0);
    } catch {
      if (request.current === current) setError("Leaflogue could not load more passages. Scroll down or choose Load more highlights to try again.");
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [queryKey]);

  // Load the next page as the end of the list comes into view.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = sentinel.current;
    if (!element || !hasMore || error || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(({ isIntersecting }) => isIntersecting)) void loadMore();
    }, { rootMargin: "0px 0px 800px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasMore, error, loadMore, results]);

  useEffect(() => {
    if (!focusHighlightId || !results || scrolledTo.current === focusHighlightId) return;
    const article = document.getElementById(`highlight-${focusHighlightId}`);
    if (article) {
      article.scrollIntoView?.({ block: "center" });
      article.focus({ preventScroll: true });
      scrolledTo.current = focusHighlightId;
    } else if (hasMore && !loadingMore && !filters.search && !filters.source && !filters.notes && !filters.tagId && !filters.date) {
      // A daily passage may be beyond the first page of this book.
      void loadMore();
    }
  });

  const filtered = Boolean(filters.search || filters.source || filters.notes || filters.tagId || filters.date);
  return (
    <PassageContext.Provider value={{ tags, reload, readOnly, aiEnabled, activeId, setActiveId }}>
      <div className={filters.density === "compact" ? styles.compactHighlights : undefined} aria-busy={results === undefined || filters.search.trim() !== search}>
        {search && <p className="sr-only" role="status">Search results are sorted by relevance</p>}
        <InlineError>{error}</InlineError>
        {results === undefined ? (
          <Loading>Finding your passages…</Loading>
        ) : (
          <>
            {results.length === 0 && !error && (
              <Empty title={filtered ? "No matching passages" : "No highlights yet"} level="h3">
                <p className="ll-muted">
                  {filtered
                    ? "Try another word from a quote or note, or clear your filters."
                    : bookId
                      ? "Keep a passage from this book with Add highlight, or import annotations from your reader."
                      : "Open a book to add your first passage, or import annotations from your reader."}
                </p>
                {!filtered && (bookId
                  ? <ImportTrigger className="ll-text-button">Import highlights</ImportTrigger>
                  : <a className="ll-text-button" href={href.library()}>Go to your library</a>)}
              </Empty>
            )}
            {results.length > 0 && (
              <div className={`ui-panel ${styles.passageList}`}>
                {results.map((highlight) => <Annotation key={highlight.id} highlight={highlight} showBook={!bookId} focused={highlight.id === focusHighlightId} />)}
              </div>
            )}
            {hasMore && (
              <div className={styles.loadMore} ref={sentinel}>
                <button className="ll-button-secondary" disabled={loadingMore} onClick={() => void loadMore()}>
                  {loadingMore ? "Loading more…" : "Load more highlights"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </PassageContext.Provider>
  );
}

export function HighlightBrowser({
  bookId: fixedBookId,
  focusHighlightId,
  readOnly,
  version,
  onChanged,
  initialSearch,
  initialTagId,
  initialBookId,
}: {
  readonly initialSearch?: string;
  readonly initialTagId?: TagId;
  readonly initialBookId?: BookId;
  readonly bookId?: BookId;
  readonly focusHighlightId?: HighlightId;
  readonly readOnly?: boolean;
  readonly version?: number;
  readonly onChanged?: () => void;
}) {
  const [filters, setFilters] = useState<HighlightFilters>(() => ({
    ...DEFAULT_FILTERS,
    ...(initialSearch ? { search: initialSearch } : {}),
    ...(initialTagId ? { tagId: initialTagId } : {}),
    ...(initialBookId && !fixedBookId ? { bookId: initialBookId } : {}),
  }));
  const [books, setBooks] = useState<readonly Book[]>();
  const [tags, setTags] = useState<readonly Tag[]>([]);
  const [aiEnabled, setAiEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    void window.leaflogue.organization.listTags().then((next) => active && setTags(next), () => undefined);
    // A disabled provider must not leave an AI action visible on a passage.
    void window.leaflogue.ai.describe().then(
      (summary) => active && setAiEnabled(aiAvailable(summary)),
      () => undefined,
    );
    if (!fixedBookId) void window.leaflogue.library.listBooks().then((next) => active && setBooks(next), () => active && setBooks([]));
    return () => { active = false; };
  }, [fixedBookId, version]);
  const change = <K extends keyof HighlightFilters>(key: K, value: HighlightFilters[K]) =>
    setFilters((current) => ({ ...current, [key]: value }));
  const [filtersOpen, setFiltersOpen] = useState(false);
  const panelId = useId();
  const activeFilters = [!fixedBookId && filters.bookId, filters.source, filters.notes, filters.tagId, filters.date].filter(Boolean).length;
  const changed = filters.search || filters.source || filters.notes || filters.tagId || filters.date ||
    filters.dateKind !== "created" || filters.sort !== "oldest" || filters.density !== "compact" || (!fixedBookId && filters.bookId);
  const browser = (
    <>
      <div className={styles.toolbar}>
        <label className={styles.iconField}>
          <Search size={18} aria-hidden="true" />
          <span className={styles.srOnly}>{fixedBookId ? "Search quotes and notes in this book" : "Search quotes and notes"}</span>
          <input className="ll-field" type="search" maxLength={200} placeholder="Find a word you kept…" value={filters.search} onChange={(event) => change("search", event.target.value)} />
        </label>
        <label className={styles.iconField}>
          <Rows3 size={16} aria-hidden="true" />
          <span className={styles.srOnly}>Reading density</span>
          <Select className="ll-field" value={filters.density} onValueChange={(value) => change("density", value as HighlightFilters["density"])}>
            <SelectItem value="comfortable">Comfortable</SelectItem>
            <SelectItem value="compact">Compact</SelectItem>
          </Select>
        </label>
        <label className={styles.iconField}>
          <ArrowDownWideNarrow size={16} aria-hidden="true" />
          <span className={styles.srOnly}>Sort by</span>
          <Select className="ll-field" value={filters.sort} onValueChange={(value) => change("sort", value as HighlightFilters["sort"])}>
            <SelectItem value="oldest">Oldest</SelectItem>
            <SelectItem value="newest">Newest</SelectItem>
            <SelectItem value="updated">Recently updated</SelectItem>
          </Select>
        </label>
        <FilterToggle open={filtersOpen} count={activeFilters} controls={panelId} onToggle={() => setFiltersOpen((open) => !open)} />
        {changed && (
          <button className="ll-icon-button" aria-label="Clear filters" title="Clear filters" onClick={() => setFilters(DEFAULT_FILTERS)}>
            <X size={18} aria-hidden="true" />
          </button>
        )}
        <div id={panelId} className="ll-filter-panel" hidden={!filtersOpen}>
          {!fixedBookId && (
            <label className={styles.iconField}>
              <BookOpen size={18} aria-hidden="true" />
              <span className={styles.srOnly}>Book</span>
              <Select className="ll-field" value={filters.bookId ?? ""} onValueChange={(value) => change("bookId", (value || undefined) as BookId | undefined)}>
                <SelectItem value="">All books</SelectItem>
                {books?.map((book) => <SelectItem key={book.id} value={book.id}>{book.title}</SelectItem>)}
              </Select>
            </label>
          )}
          <label className={styles.iconField}>
            <Filter size={16} aria-hidden="true" />
            <span className={styles.srOnly}>Source</span>
            <Select className="ll-field" value={filters.source ?? ""} onValueChange={(value) => change("source", (value || undefined) as HighlightFilters["source"])}>
              <SelectItem value="">All sources</SelectItem>
              <SelectItem value="imported">Imported</SelectItem>
              <SelectItem value="manual">Manual</SelectItem>
            </Select>
          </label>
          <label className={styles.iconField}>
            <StickyNote size={16} aria-hidden="true" />
            <span className={styles.srOnly}>Notes</span>
            <Select className="ll-field" value={filters.notes ?? ""} onValueChange={(value) => change("notes", (value || undefined) as HighlightFilters["notes"])}>
              <SelectItem value="">All notes</SelectItem>
              <SelectItem value="with">With notes</SelectItem>
              <SelectItem value="without">Without notes</SelectItem>
            </Select>
          </label>
          <label className={styles.iconField}>
            <Tags size={16} aria-hidden="true" />
            <span className={styles.srOnly}>Tag</span>
            <Select className="ll-field" value={filters.tagId ?? ""} onValueChange={(value) => change("tagId", (value || undefined) as Tag["id"] | undefined)}>
              <SelectItem value="">All tags</SelectItem>
              {tags.map((tag) => <SelectItem key={tag.id} value={tag.id}>{tag.name}</SelectItem>)}
            </Select>
          </label>
          <label className={styles.iconField}>
            <CalendarDays size={16} aria-hidden="true" />
            <span className={styles.srOnly}>Date type</span>
            <Select className="ll-field" value={filters.dateKind} onValueChange={(value) => change("dateKind", value === "imported" ? "imported" : "created")}>
              <SelectItem value="created">Date added</SelectItem>
              <SelectItem value="imported">Last imported</SelectItem>
            </Select>
          </label>
          <DatePicker label="Filter date" value={filters.date} onChange={(value) => change("date", value)} />
        </div>
      </div>
      {!fixedBookId && filters.bookId && books === undefined ? (
        <Loading>Loading books…</Loading>
      ) : (
        <HighlightList
          bookId={fixedBookId}
          filters={filters}
          focusHighlightId={focusHighlightId}
          readOnly={readOnly}
          aiEnabled={aiEnabled}
          tags={tags}
          version={version}
          onChanged={onChanged}
        />
      )}
    </>
  );
  if (fixedBookId) return browser;
  const shelved = (books ?? []).filter((book) => book.highlightCount > 0).sort((a, b) => b.highlightCount - a.highlightCount || a.title.localeCompare(b.title));
  return (
    <div className={sheet.browse}>
      <aside className={`ui-panel ${sheet.facets}`} aria-label="Narrow passages">
        <h2 className="ui-label">Notes</h2>
        <div className="ui-facets">
          <Facet label="All passages" pressed={!filters.notes} onSelect={() => change("notes", undefined)} />
          <Facet label="With notes" pressed={filters.notes === "with"} onSelect={() => change("notes", filters.notes === "with" ? undefined : "with")} />
          <Facet label="Without notes" pressed={filters.notes === "without"} onSelect={() => change("notes", filters.notes === "without" ? undefined : "without")} />
        </div>
        <h2 className="ui-label">Books</h2>
        <div className="ui-facets">
          {shelved.length === 0 ? <p className="ui-sub">No passages yet.</p> : shelved.map((book) => (
            <Facet key={book.id} label={book.title} count={book.highlightCount} pressed={filters.bookId === book.id} onSelect={() => change("bookId", filters.bookId === book.id ? undefined : book.id)} />
          ))}
        </div>
        <h2 className="ui-label">Tags</h2>
        <div className="ui-facets">
          {tags.length === 0 ? <p className="ui-sub">No tags yet.</p> : tags.map((tag) => (
            <Facet key={tag.id} label={tag.name} pressed={filters.tagId === tag.id} onSelect={() => change("tagId", filters.tagId === tag.id ? undefined : tag.id)} />
          ))}
        </div>
      </aside>
      <div className={sheet.results}>{browser}</div>
    </div>
  );
}

/** The month name for a `YYYY-MM` key. */
function monthName(month: string, style: "short" | "long"): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, { month: style, timeZone: "UTC" });
}

function HighlightsOverview() {
  const [statistics, setStatistics] = useState<LibraryStatistics>();
  useEffect(() => {
    let active = true;
    window.leaflogue.statistics.get().then((next) => { if (active) setStatistics(next); }, () => undefined);
    return () => { active = false; };
  }, []);
  if (!statistics || statistics.totals.highlights === 0) return null;
  const recent = statistics.highlightsByMonth.slice(-3);
  const busiest = [...statistics.highlightsByMonth].sort((a, b) => b.highlights - a.highlights)[0];
  const booksWithPassages = statistics.books.filter((book) => book.highlights > 0).length;
  return (
    <div className={sheet.tiles}>
      <StatTile label="Passages" value={statistics.totals.highlights.toLocaleString()} sub={`across ${countOf(booksWithPassages, "book")}`} />
      <StatTile label="With notes" tone="mark" value={statistics.highlightsWithNotes.toLocaleString()} sub={`${((statistics.highlightsWithNotes / statistics.totals.highlights) * 100).toFixed(1)}% of passages · ${countOf(statistics.totals.notes, "note")}`} />
      <StatTile label="Average length" value={statistics.averageLength.toLocaleString()} sub={`characters · longest ${statistics.longestLength.toLocaleString()}`} />
      {busiest && busiest.highlights > 0 && <StatTile label="Busiest month" value={busiest.highlights.toLocaleString()} sub={`${monthName(busiest.month, "long")} ${busiest.month.slice(0, 4)}`} />}
      <Panel className={sheet.miniChart} title="Last three months" padded>
        <Bars title="Passages in the last three months" height={44} unit="passage" bars={recent.map(({ month, highlights }) => ({ label: monthName(month, "short"), detail: `${monthName(month, "long")} ${month.slice(0, 4)}`, value: highlights, highlight: busiest !== undefined && month === busiest.month }))} />
      </Panel>
    </div>
  );
}

export function HighlightsPage({ initialSearch, initialTagId, initialBookId }: { readonly initialSearch?: string; readonly initialTagId?: TagId; readonly initialBookId?: BookId } = {}) {
  return (
    <div className={`${styles.knowledgePage} ${sheet.page}`}>
      <TitleRow
        title="Your highlights"
        meta="Every passage and note across your library"
        actions={<><ImportTrigger className="ll-button-secondary">Import</ImportTrigger><a className="ll-button-secondary" href={href.library()}>Browse books</a></>}
      />
      <HighlightsOverview />
      <HighlightBrowser {...(initialSearch ? { initialSearch } : {})} {...(initialTagId ? { initialTagId } : {})} {...(initialBookId ? { initialBookId } : {})} />
    </div>
  );
}

export function AddHighlight({ bookId, onSaved, triggerRef }: { readonly bookId: BookId; readonly onSaved: () => Promise<void> | void; readonly triggerRef?: RefObject<HTMLButtonElement | null> }) {
  return (
    <Dialog label="Add highlight" title="Keep a passage" icon={Plus} secondary {...(triggerRef ? { triggerRef } : {})}>
      {(close) => <HighlightForm bookId={bookId} onClose={close} onSaved={onSaved} />}
    </Dialog>
  );
}
