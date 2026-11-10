
import { Select, SelectItem } from "@leaflogue/ui";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArrowDownWideNarrow, Folder, Library as LibraryIcon, Plus, Search, Tags } from "../components/icons";
import type { Book, BookId, BookOrganization, Collection, CollectionId, LibraryBookStatistics, LibraryDuplicates, LibraryStatistics, ReadingStatus, Tag, TagId } from "@leaflogue/contracts";
import { TitleRow } from "@leaflogue/ui";
import { useDesktop } from "../host";
import { href, navigate } from "../router";
import { Dashboard, DashboardControls, useDashboard } from "./dashboard/Dashboard";
import { authorsLabel, countOf, Cover, Dialog, Empty, FilterToggle, ImportTrigger, InlineError, Loading, statusLabel } from "./shared";
import { readingSummary } from "./reading-summary";
import { addBookRequests } from "../palette/actions";
import { useCommands } from "../palette/commands";
import styles from "./knowledge.module.css";
import sheet from "./library.module.css";
import { BookForm } from "./BookForms";
import { CollectionManager, TagManager } from "./Organization";

type Sort = "series" | "recent" | "title" | "author" | "highlights";
type StatusTab = "all" | ReadingStatus;

function sortBooks(books: readonly Book[], sort: Sort): Book[] {
  return [...books].sort((a, b) =>
    sort === "series"
      ? (a.series?.trim() ? 1 : 0) - (b.series?.trim() ? 1 : 0) ||
        (a.series ?? "").localeCompare(b.series ?? "", undefined, { numeric: true }) ||
        (a.seriesNumber ?? "").localeCompare(b.seriesNumber ?? "", undefined, { numeric: true }) ||
        a.title.localeCompare(b.title)
      : sort === "title"
        ? a.title.localeCompare(b.title)
        : sort === "author"
          ? a.authors.join(", ").localeCompare(b.authors.join(", "))
          : sort === "highlights"
            ? b.highlightCount - a.highlightCount
            : b.updatedAt - a.updatedAt);
}

export function LibraryPage({ initialCollectionId, initialTagId }: { readonly initialCollectionId?: CollectionId; readonly initialTagId?: TagId } = {}) {
  const [shelf, setShelf] = useState<"active" | "archived">("active");
  const [books, setBooks] = useState<readonly Book[]>();
  const [collections, setCollections] = useState<readonly Collection[]>([]);
  const [tags, setTags] = useState<readonly Tag[]>([]);
  const [organizations, setOrganizations] = useState<ReadonlyMap<BookId, BookOrganization>>(new Map());
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort>("series");
  const [collection, setCollection] = useState<CollectionId | "">(initialCollectionId ?? "");
  const [tag, setTag] = useState<TagId | "">(initialTagId ?? "");
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((current) => current + 1), []);
  const [duplicates, setDuplicates] = useState<LibraryDuplicates["books"]>([]);
  const [statistics, setStatistics] = useState<LibraryStatistics>();
  const [statusTab, setStatusTab] = useState<StatusTab>("all");

  useEffect(() => {
    let active = true;
    // The overview is a bonus on top of the shelf: if it cannot be counted, the books still show.
    window.leaflogue.statistics.get().then((next) => { if (active) setStatistics(next); }, () => undefined);
    return () => { active = false; };
  }, [version]);

  useEffect(() => {
    let active = true;
    window.leaflogue.library.findDuplicates().then(({ books: groups }) => { if (active) setDuplicates(groups); }, () => undefined);
    return () => { active = false; };
  }, [version]);

  useEffect(() => {
    let active = true;
    setError("");
    void (async () => {
      try {
        const [result, nextCollections, nextTags] = await Promise.all([
          window.leaflogue.library.listBooks(shelf === "archived" ? { includeArchived: true } : undefined),
          window.leaflogue.organization.listCollections(),
          window.leaflogue.organization.listTags(),
        ]);
        const entries = await Promise.all(result.map(async (book) => [book.id, await window.leaflogue.organization.getBook(book.id)] as const));
        if (!active) return;
        setBooks(result.filter((book) => book.archived === (shelf === "archived")));
        setCollections(nextCollections);
        setTags(nextTags);
        setCollection((current) => current && !nextCollections.some(({ id }) => id === current) ? "" : current);
        setTag((current) => current && !nextTags.some(({ id }) => id === current) ? "" : current);
        setOrganizations(new Map(entries.filter((entry): entry is readonly [BookId, BookOrganization] => entry[1] !== undefined)));
      } catch {
        if (active) {
          setBooks((current) => current ?? []);
          setError("Leaflogue could not open the local library.");
        }
      }
    })();
    return () => { active = false; };
  }, [shelf, version]);

  const needle = search.trim().toLocaleLowerCase();
  const [filtersOpen, setFiltersOpen] = useState(Boolean(initialCollectionId || initialTagId));
  const panelId = useId();
  const activeFilters = [collection, tag, shelf === "archived"].filter(Boolean).length;
  const matching = books?.filter((book) => {
    const organization = organizations.get(book.id);
    return `${book.title} ${book.authors.join(" ")}`.toLocaleLowerCase().includes(needle) &&
      (!collection || organization?.collectionIds.includes(collection)) &&
      (!tag || organization?.tagIds.includes(tag));
  });
  const filtered = matching && sortBooks(matching.filter((book) => statusTab === "all" || book.status === statusTab), sort);
  const statusCounts = (["reading", "finished", "unread", "paused"] as const)
    .map((status) => [status, matching?.filter((book) => book.status === status).length ?? 0] as const)
    .filter(([status, count]) => count > 0 || status === statusTab);
  const perBook = new Map<BookId, LibraryBookStatistics>(statistics?.books.map((entry) => [entry.bookId, entry]) ?? []);
  const summary = statistics && shelf === "active" && statistics.totals.highlights > 0 ? readingSummary(statistics) : undefined;
  const dashboard = useDashboard("library");
  const showDashboard = shelf === "active" && statistics !== undefined && statistics.totals.highlights > 0;
  const addBookTrigger = useRef<HTMLButtonElement>(null);
  const collectionsTrigger = useRef<HTMLButtonElement>(null);
  const tagsTrigger = useRef<HTMLButtonElement>(null);
  addBookRequests.useReceiver(() => addBookTrigger.current?.click());
  useCommands(dashboard.editing ? [] : [
    ...(showDashboard && dashboard.layout ? [{ id: "page.customise", title: "Customise this page", subtitle: "Arrange the library's widgets", keywords: "dashboard widgets layout", icon: "layout" as const, run: dashboard.start }] : []),
    { id: "library.collections", title: "Manage collections", icon: "folder", run: () => collectionsTrigger.current?.click() },
    { id: "library.tags", title: "Manage tags", icon: "tag", run: () => tagsTrigger.current?.click() },
    { id: "library.archived", title: shelf === "archived" ? "Show active books" : "Show archived books", icon: "archive", run: () => setShelf(shelf === "archived" ? "active" : "archived") },
  ]);

  // The shelf: everything about the books themselves, placed among the widgets where the reader put it.
  const shelfSection = (
    <>
      {shelf === "active" && duplicates.length > 0 && (
        <div className={styles.duplicates} role="note">
          <p>These may be the same book imported twice. Review each to merge its copies:</p>
          <ul>
            {duplicates.map(({ bookIds, title }) => (
              <li key={bookIds.join()}>
                <span>{title} ({bookIds.length} copies)</span>
                <a className="ll-text-link" href={href.mergeBooks(bookIds[0]!, bookIds[1]!)}>Review</a>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className={sheet.tabsRow}>
        <div className="ui-tabs" role="tablist" aria-label="Reading status">
          {([["all", matching?.length ?? 0] as const, ...statusCounts]).map(([status, count]) => (
            <button key={status} type="button" role="tab" className="ui-tab" aria-selected={statusTab === status} onClick={() => setStatusTab(status)}>
              {status === "all" ? "All" : statusLabel(status)} {count}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.toolbar}>
        <label className={styles.iconField}>
          <Search size={18} aria-hidden="true" />
          <span className={styles.srOnly}>Search your library</span>
          <input className="ll-field" type="search" placeholder="Title or author" value={search} onChange={(event) => setSearch(event.target.value)} />
        </label>
        <label className={styles.iconField}>
          <ArrowDownWideNarrow size={18} aria-hidden="true" />
          <span className={styles.srOnly}>Sort by</span>
          <Select className="ll-field" value={sort} onValueChange={(value) => setSort(value as Sort)}>
            <SelectItem value="series">Series name</SelectItem>
            <SelectItem value="recent">Recently updated</SelectItem>
            <SelectItem value="title">Title</SelectItem>
            <SelectItem value="author">Author</SelectItem>
            <SelectItem value="highlights">Most highlights</SelectItem>
          </Select>
        </label>
        <FilterToggle open={filtersOpen} count={activeFilters} controls={panelId} onToggle={() => setFiltersOpen((open) => !open)} />
        <div id={panelId} className="ll-filter-panel" hidden={!filtersOpen}>
          <label className={styles.iconField}>
            <Folder size={16} aria-hidden="true" />
            <span className={styles.srOnly}>Collection</span>
            <Select className="ll-field" value={collection} onValueChange={(value) => setCollection(value as CollectionId | "")}>
              <SelectItem value="">All collections</SelectItem>
              {collections.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}
            </Select>
          </label>
          <label className={styles.iconField}>
            <Tags size={16} aria-hidden="true" />
            <span className={styles.srOnly}>Tag</span>
            <Select className="ll-field" value={tag} onValueChange={(value) => setTag(value as TagId | "")}>
              <SelectItem value="">All tags</SelectItem>
              {tags.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}
            </Select>
          </label>
          <label className={styles.iconField}>
            <LibraryIcon size={16} aria-hidden="true" />
            <span className={styles.srOnly}>Shelf</span>
            <Select className="ll-field" value={shelf} onValueChange={(value) => { setBooks(undefined); setShelf(value === "archived" ? "archived" : "active"); }}>
              <SelectItem value="active">On your shelf</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
            </Select>
          </label>
        </div>
      </div>
      <InlineError>{error}</InlineError>
      {books === undefined ? (
        <Loading>Loading your books…</Loading>
      ) : books.length === 0 ? (
        shelf === "archived" ? (
          <Empty title="No archived books">
            <p className="ll-muted">Books you archive from their page wait here, with their passages and notes intact.</p>
          </Empty>
        ) : (
          <div className="ll-empty">
            <div className={styles.emptyBook} aria-hidden="true" />
            <h2 className="font-reader">A place for what stays with you.</h2>
            <p className="ll-muted">
              Add a book to start collecting passages and your own notes.
              <br />
              Already reading on Kobo or Kindle? Import your books and annotations together.
            </p>
          </div>
        )
      ) : filtered?.length === 0 ? (
        <Empty title="No books match your search">
          <button className="ll-text-button" onClick={() => { setSearch(""); setCollection(""); setTag(""); setStatusTab("all"); }}>Clear search</button>
        </Empty>
      ) : (
        <>
          <p className="ll-muted sr-only" role="status">{countOf(filtered?.length ?? 0, "book")}</p>
          <div className={sheet.books}>
            {filtered?.map((book) => {
              const counted = perBook.get(book.id);
              return (
                <a className={`ui-panel ${sheet.book}`} href={href.book(book.id)} key={book.id} aria-label={`Open ${book.title}`}>
                  <Cover book={book} />
                  <div>
                    <h2>{book.title}</h2>
                    <p className="ui-sub">{authorsLabel(book.authors)}</p>
                    <dl>
                      <div><dt className="ui-label">Passages</dt><dd className="ui-number">{book.highlightCount.toLocaleString()}</dd></div>
                      <div><dt className="ui-label">Notes</dt><dd className="ui-number">{(counted?.notes ?? 0).toLocaleString()}</dd></div>
                      <div><dt className="ui-label">Days</dt><dd className="ui-number">{(counted?.activeDays ?? 0).toLocaleString()}</dd></div>
                    </dl>
                  </div>
                </a>
              );
            })}
          </div>
        </>
      )}
    </>
  );

  return (
    <div className={styles.knowledgePage}>
      <div className={sheet.page}>
      <TitleRow
        title={shelf === "archived" ? "Archived books" : "Your library"}
        meta={summary ? `${summary.range} · ${countOf(statistics!.totals.books, "book")}` : books ? countOf(books.length, "book") : undefined}
        actions={(
          <>
            {!dashboard.editing && (
              <>
                <Dialog label="Add book" title="Add a book" icon={Plus} triggerRef={addBookTrigger}>
                  {(close) => <BookForm onClose={close} onSaved={(book) => navigate(href.book(book.id))} />}
                </Dialog>
                <Dialog label="Collections" title="Manage collections" icon={Folder} secondary triggerRef={collectionsTrigger}>
                  {(close) => <CollectionManager onClose={close} onChanged={refresh} />}
                </Dialog>
                <Dialog label="Tags" title="Manage tags" icon={Tags} secondary triggerRef={tagsTrigger}>
                  {(close) => <TagManager onClose={close} onChanged={refresh} />}
                </Dialog>
                <ImportTrigger className="ll-button-secondary">Import</ImportTrigger>
              </>
            )}
            {showDashboard && <DashboardControls state={dashboard} />}
          </>
        )}
      />
      {showDashboard && statistics ? <Dashboard state={dashboard} statistics={statistics} {...(summary ? { summary } : {})} shelf={shelfSection} /> : shelfSection}
      <ExportLibrary />
      </div>
    </div>
  );
}

type ExportFormat = "markdown" | "json";

/** One export button; the dialog chooses the format and what to include. */
export function ExportLibrary() {
  // Exports are written through a save dialog, which only the desktop app has.
  if (!useDesktop()) return null;
  return <ExportLibraryForm />;
}

function ExportLibraryForm() {
  const [format, setFormat] = useState<ExportFormat>("markdown");
  const [includeArchived, setIncludeArchived] = useState(true);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const run = async (close: () => void) => {
    close();
    setRunning(true);
    setError("");
    setStatus(format === "markdown" ? "Choose a folder for the Markdown files." : "Choose where to save the file.");
    try {
      if (format === "markdown") {
        const result = await window.leaflogue.exports.createMarkdown({ includeArchived });
        setStatus(result
          ? `Saved ${countOf(result.booksExported, "book")} as Markdown in “${result.folderName}”.`
          : "Export cancelled. No files were written.");
      } else {
        const result = await window.leaflogue.exports.create();
        setStatus(result
          ? `Exported ${countOf(result.booksExported, "book")}, ${countOf(result.highlightsExported, "highlight")}, and ${countOf(result.notesExported, "note")} to ${result.fileName}.`
          : "Export cancelled. No file was written.");
      }
    } catch {
      setStatus("");
      setError("Leaflogue could not export your library. Nothing was left behind.");
    } finally {
      setRunning(false);
    }
  };
  return (
    <div className={`ll-export ${styles.export}`}>
      <Dialog label={running ? "Exporting…" : "Export your library"} title="Export your library" secondary disabled={running}>
        {(close) => (
          <form className={styles.form} onSubmit={(event) => { event.preventDefault(); void run(close); }}>
            <fieldset className={styles.exportChoices}>
              <legend className="ll-label">Format</legend>
              <label className={styles.exportChoice}>
                <input type="radio" name="export-format" checked={format === "markdown"} onChange={() => setFormat("markdown")} />
                <span><strong>Markdown</strong><small>One file per book plus a single library.md, for notes apps like Obsidian or for pasting into an AI tool.</small></span>
              </label>
              <label className={styles.exportChoice}>
                <input type="radio" name="export-format" checked={format === "json"} onChange={() => setFormat("json")} />
                <span><strong>JSON</strong><small>Everything in one file, including organisation and reading history, so another Leaflogue library can import it.</small></span>
              </label>
            </fieldset>
            {format === "markdown" && (
              <label className={styles.checkRow}>
                <input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} />
                Include archived books
              </label>
            )}
            <p className="ll-muted">Leaflogue never uploads an export. Exports are not backups: they leave out settings, keys, and sync setup.</p>
            <div className={styles.actions}>
              <button type="submit" className="ll-button">Export</button>
              <button type="button" className="ll-button-secondary" onClick={close}>Cancel</button>
            </div>
          </form>
        )}
      </Dialog>
      <span role="status" className={`ll-muted ${styles.exportStatus}`}>{status}</span>
      <InlineError>{error}</InlineError>
    </div>
  );
}
