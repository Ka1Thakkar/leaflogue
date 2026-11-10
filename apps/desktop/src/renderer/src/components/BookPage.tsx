
import { Menu, MenuItem } from "@leaflogue/ui";

import { Select, SelectItem, DatePicker } from "@leaflogue/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Archive, ArchiveRestore, GitMerge, MoreHorizontal, Pencil, RotateCcw, StickyNote } from "../components/icons";
import type { Book, BookContents, BookId, BookMetadataSource, BookOrganization, Collection, CollectionId, HighlightId, LibraryBookStatistics, LibraryStatistics, ReadingStatus, ReadingStatusEvent, Tag, TagId } from "@leaflogue/contracts";
import { Bars, Panel, StatTile } from "@leaflogue/ui";
import { bookDescriptionText } from "../book-description";
import { href, navigate } from "../router";
import { AddHighlight, HighlightBrowser } from "./Highlights";
import { NoteCard, NoteForm } from "./PassageForms";
import { useConfirm } from "./Confirm";
import { authorsLabel, Cover, Dialog, InlineError, Loading, SearchableMultiSelect, statusLabel, useCrumb } from "./shared";
import { bookPositions, bookTimeline } from "./book-charts";
import { formatDay } from "./reading-summary";
import styles from "./knowledge.module.css";
import sheet from "./book.module.css";
import { useAction } from "./useAction";
import { useCommands } from "../palette/commands";
import { MetadataForm, ResetMetadata, resettableFields } from "./BookForms";

function formatDate(value: number | string): string {
  const date = typeof value === "string" ? new Date(`${value}T00:00:00`) : new Date(value);
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

function historySource(event: ReadingStatusEvent): string {
  return event.source === "reader" ? "Set by you"
    : event.source === "merge" ? "From a merged copy"
      : event.source === "kobo" ? "From Kobo"
        : event.source === "kindle" ? "From Kindle"
          : "From an import";
}

/** " · Quiet wonders": which of these the book is already in, visible while collapsed. */
function memberNames(options: readonly { readonly id: string; readonly name: string }[], ids: readonly string[] = []) {
  const names = options.filter((option) => ids.includes(option.id)).map((option) => option.name);
  return names.length > 0 ? <span className="ll-muted"> · {names.join(", ")}</span> : null;
}

/** Open a picker's disclosure, bring it into view, and put the cursor in its search. */
function openPicker(details: HTMLDetailsElement | null): void {
  if (!details) return;
  details.open = true;
  details.scrollIntoView?.({ block: "center" });
  details.querySelector<HTMLElement>("input, button")?.focus({ preventScroll: true });
}

export function BookPage({ bookId, focusHighlightId, mergeWith }: { readonly bookId: BookId; readonly focusHighlightId?: HighlightId; readonly mergeWith?: BookId }) {
  const [confirm, confirmDialog] = useConfirm();
  const [contents, setContents] = useState<BookContents | null>();
  const [organization, setOrganization] = useState<BookOrganization>();
  const [collections, setCollections] = useState<readonly Collection[]>([]);
  const [tags, setTags] = useState<readonly Tag[]>([]);
  const [history, setHistory] = useState<readonly ReadingStatusEvent[]>();
  const [historyTruncated, setHistoryTruncated] = useState(false);
  const [candidates, setCandidates] = useState<readonly Book[]>([]);
  const [statusPending, setStatusPending] = useState(false);
  const { pending, error, setError, run } = useAction();
  const [mergePending, setMergePending] = useState(false);
  const [mergeCandidateId, setMergeCandidateId] = useState<BookId | "">(mergeWith ?? "");
  const [repeats, setRepeats] = useState<readonly (readonly HighlightId[])[]>([]);
  useEffect(() => {
    let active = true;
    window.leaflogue.library.findDuplicates().then(
      ({ passages }) => { if (active) setRepeats(passages.filter((group) => group.bookId === bookId).map(({ highlightIds }) => highlightIds)); },
      () => undefined,
    );
    return () => { active = false; };
  }, [bookId]);
  const [mergeTarget, setMergeTarget] = useState<"current" | "candidate">("current");
  const [mergeSearch, setMergeSearch] = useState("");
  const [passagesVersion, setPassagesVersion] = useState(0);
  const [metadataSource, setMetadataSource] = useState<BookMetadataSource>();
  const [bookAccent, setBookAccent] = useState<string>();
  const [statistics, setStatistics] = useState<LibraryStatistics>();
  useEffect(() => {
    let active = true;
    window.leaflogue.statistics.get().then((next) => { if (active) setStatistics(next); }, () => undefined);
    return () => { active = false; };
  }, [bookId]);

  const refreshBook = useCallback(async () => {
    const next = await window.leaflogue.library.getBookContents(bookId);
    setContents(next ?? null);
    return next;
  }, [bookId]);

  const refreshHistory = useCallback(async () => {
    try {
      const page = await window.leaflogue.library.listReadingStatusHistory(bookId);
      setHistory(page.events);
      setHistoryTruncated(page.hasMore);
    } catch {
      setHistory((current) => current ?? []);
      setError("Reading history could not be refreshed.");
    }
  }, [bookId, setError]);

  useEffect(() => {
    let active = true;
    setContents(undefined);
    setError("");
    void (async () => {
      try {
        const [next, nextOrganization, nextCollections, nextTags, books, source] = await Promise.all([
          window.leaflogue.library.getBookContents(bookId),
          window.leaflogue.organization.getBook(bookId),
          window.leaflogue.organization.listCollections(),
          window.leaflogue.organization.listTags(),
          window.leaflogue.library.listBooks(),
          window.leaflogue.library.getMetadataSource(bookId).catch(() => undefined),
        ]);
        if (!active) return;
        setContents(next ?? null);
        setMetadataSource(source);
        setOrganization(nextOrganization);
        setCollections(nextCollections);
        setTags(nextTags);
        setCandidates(books.filter((book) => book.id !== bookId && !book.archived));
      } catch {
        if (active) setContents(null);
      }
    })();
    void refreshHistory();
    return () => { active = false; };
  }, [bookId, refreshHistory, setError]);

  const book = contents?.book;
  useCrumb(book?.title);
  const addHighlightTrigger = useRef<HTMLButtonElement>(null);
  const addNoteTrigger = useRef<HTMLButtonElement>(null);
  const metadataTrigger = useRef<HTMLButtonElement>(null);
  const collectionsDetails = useRef<HTMLDetailsElement>(null);
  const tagsDetails = useRef<HTMLDetailsElement>(null);
  // What the palette offers while this book is open.
  useCommands(book && !book.archived ? [
    ...(["reading", "finished", "paused", "unread"] as const).filter((status) => status !== book.status).map((status) => ({
      id: `book.mark-${status}`,
      title: `Mark as ${statusLabel(status).toLocaleLowerCase()}`,
      keywords: "reading status",
      icon: "check" as const,
      run: () => void setStatus(status),
    })),
    { id: "book.add-highlight", title: "Add a highlight", keywords: "passage quote keep", icon: "plus", run: () => addHighlightTrigger.current?.click() },
    { id: "book.add-note", title: "Add a note to this book", icon: "note-paper", run: () => addNoteTrigger.current?.click() },
    { id: "book.edit-metadata", title: "Edit book details", keywords: "metadata title author series isbn publisher", icon: "edit", run: () => metadataTrigger.current?.click() },
    ...(collections.length > 0 ? [{ id: "book.collections", title: "Add to a collection", icon: "folder" as const, run: () => openPicker(collectionsDetails.current) }] : []),
    ...(tags.length > 0 ? [{ id: "book.tags", title: "Tag this book", icon: "tag" as const, run: () => openPicker(tagsDetails.current) }] : []),
    { id: "book.passages", title: "Show this book's passages in Highlights", icon: "passages", run: () => navigate(href.highlights(undefined, { bookId: book.id })) },
    { id: "book.archive", title: "Archive this book", icon: "archive", run: () => void setShelf(true) },
  ] : book ? [
    { id: "book.restore", title: "Restore this book to the library", icon: "restore", run: () => void setShelf(false) },
  ] : []);
  const highlights = contents?.highlights;
  const timeline = useMemo(() => highlights ? bookTimeline(highlights) : undefined, [highlights]);
  const positions = useMemo(() => highlights ? bookPositions(highlights) : undefined, [highlights]);
  const needle = mergeSearch.trim().toLocaleLowerCase();
  const mergeCandidates = candidates.filter((candidate) => `${candidate.title} ${candidate.authors.join(" ")}`.toLocaleLowerCase().includes(needle));
  const chosenCandidate = mergeCandidates.find((candidate) => candidate.id === mergeCandidateId) ?? mergeCandidates[0];

  if (contents === undefined) return <Loading>Opening your book…</Loading>;
  if (contents === null || !book) {
    return (
      <div className="ll-empty">
        <h1 className="ll-title">Book not found</h1>
        <p className="ll-muted">This book is not in your local library, or has been merged into another copy.</p>
        <a className="ll-button-secondary" href={href.library()}>Back to library</a>
      </div>
    );
  }

  async function setStatus(status: ReadingStatus) {
    if (!book) return;
    setStatusPending(true);
    setError("");
    try {
      const change = await window.leaflogue.library.setBookReadingStatus({ id: book.id, status, expectedRevision: book.revision });
      setContents((current) => current ? { ...current, book: change.book } : current);
      await refreshHistory();
    } catch {
      setError("This reading status changed elsewhere. Reload the book and try again.");
    } finally {
      setStatusPending(false);
    }
  }

  async function setCompletionDate(completedOn: string | undefined) {
    if (!book) return;
    setStatusPending(true);
    setError("");
    try {
      const updated = await window.leaflogue.library.setBookCompletionDate({
        id: book.id,
        ...(completedOn ? { completedOn } : {}),
        expectedRevision: book.revision,
      });
      setContents((current) => current ? { ...current, book: updated } : current);
    } catch {
      setError("This completion date changed elsewhere. Reload the book and try again.");
    } finally {
      setStatusPending(false);
    }
  }

  async function setShelf(archived: boolean) {
    if (!book) return;
    if (archived && !await confirm({
      title: "Archive this book?",
      message: `“${book.title}” and its passages and notes will be hidden from your active library until you restore it.`,
      confirmLabel: "Archive book",
    })) return;
    await run(async () => {
      await window.leaflogue.library.setBookArchived({ id: book.id, archived, expectedRevision: book.revision });
      if (archived) navigate(href.library());
      else await refreshBook();
    }, "This book changed before it could be moved. Reload it and try again.");
  }

  async function changeMembership(kind: "collection" | "tag", next: readonly string[]) {
    if (!book) return;
    const current = new Set<string>(kind === "collection" ? organization?.collectionIds ?? [] : organization?.tagIds ?? []);
    const wanted = new Set(next);
    const options = kind === "collection" ? collections : tags;
    for (const option of options) {
      if (current.has(option.id) === wanted.has(option.id)) continue;
      setOrganization(kind === "collection"
        ? await window.leaflogue.organization.setBookCollection({ bookId: book.id, collectionId: option.id as CollectionId, included: wanted.has(option.id) })
        : await window.leaflogue.organization.setBookTag({ bookId: book.id, tagId: option.id as TagId, included: wanted.has(option.id) }));
    }
    await refreshBook();
  }

  const readOnly = book.archived;
  const applyBook = (updated: Book) => setContents((current) => current ? { ...current, book: updated } : current);
  const standaloneNotes = contents.standaloneNotes;
  return (
    <div
      className={`${styles.knowledgePage} ${styles.bookWorkspace} ${sheet.page}`}
      style={bookAccent ? { "--book-accent": bookAccent } as CSSProperties : undefined}
    >
      <section className={`ui-panel ${sheet.hero}`} aria-label="About this book">
        <div className={sheet.heroCover}><Cover book={book} onAccent={setBookAccent} /></div>
        <div className={sheet.heroText}>
          <span className="ui-label" data-tone={book.status === "finished" && !book.archived ? "good" : undefined}>{book.archived ? "Archived" : statusLabel(book.status)}{book.status === "finished" && book.completedOn ? ` · ${formatDate(book.completedOn)}` : ""}</span>
          <h1 className={sheet.title}>{book.title}</h1>
          <p className={sheet.authors}>{authorsLabel(book.authors)}{book.series ? ` · ${book.series}${book.seriesNumber ? ` ${book.seriesNumber}` : ""}` : ""}</p>
          <div className={styles.actions}>
            {!readOnly && (
              <>
                <AddHighlight bookId={book.id} triggerRef={addHighlightTrigger} onSaved={async () => { setPassagesVersion((current) => current + 1); await refreshBook(); }} />
                <Dialog label="Add a note without a passage" title="Add a note" icon={StickyNote} iconOnly triggerRef={addNoteTrigger}>
                  {(close) => <NoteForm bookId={book.id} onClose={close} onSaved={async () => { await refreshBook(); }} />}
                </Dialog>
              </>
            )}
            {!readOnly && (
              <Dialog label="Edit metadata" title="Edit book metadata" icon={Pencil} secondary triggerRef={metadataTrigger}>
                {(close) => <MetadataForm book={book} onClose={close} onSaved={applyBook} />}
              </Dialog>
            )}
            {!readOnly && metadataSource && resettableFields(book, metadataSource).length > 0 && (
              <Dialog label="Reset metadata field" title="Reset metadata" icon={RotateCcw} iconOnly>
                {(close) => <ResetMetadata book={book} source={metadataSource} onClose={close} onSaved={applyBook} />}
              </Dialog>
            )}
            <Menu trigger={<button type="button" className="ll-icon-button" aria-label="More book actions" title="More book actions"><MoreHorizontal size={18} aria-hidden="true" /></button>}>


                {book.archived ? (
                  <MenuItem asChild disabled={pending} onSelect={() => void setShelf(false)}><button type="button" className={styles.menuAction} disabled={pending}>
                    <ArchiveRestore size={16} aria-hidden="true" />Restore to library
                  </button></MenuItem>
                ) : (
                  <MenuItem asChild disabled={pending} onSelect={() => void setShelf(true)}><button type="button" className={`${styles.menuAction} ${styles.danger}`} disabled={pending}>
                    <Archive size={16} aria-hidden="true" />Archive book
                  </button></MenuItem>
                )}

            </Menu>
          </div>
        </div>
        <div className={sheet.heroTiles}>
          <BookTiles book={book} contents={contents} statistics={statistics} activeDays={timeline?.activeDays} firstDay={timeline?.firstDay} lastDay={timeline?.lastDay} />
        </div>
      </section>
      {timeline && (
        <div className={sheet.charts} data-columns={positions ? 3 : 2}>
          <Panel title="When you highlighted" actions={<span className="ui-sub">passages per {timeline.unit}</span>} padded>
            <Bars title={`Passages per ${timeline.unit}`} bars={timeline.bars} height={110} showValues={timeline.bars.length <= 16} unit="passage" />
          </Panel>
          {positions && (
            <Panel title="Where in the book" actions={<span className="ui-sub">{positions.placed === contents.highlights.length ? "by position" : `${positions.placed} of ${contents.highlights.length} placed`}</span>} padded>
              <Bars title="Passages by position in the book" bars={positions.bars} height={110} showValues={false} unit="passage" share />
            </Panel>
          )}
          <Revisit contents={contents} />
        </div>
      )}
      <div className={sheet.body}>
        <section aria-label="Book highlights" className={sheet.passages}>
          {readOnly && (
            <p className={styles.archivedNotice}>This book is archived. Restore it from the book actions to add or edit its passages and notes.</p>
          )}
          <HighlightBrowser
            bookId={book.id}
            focusHighlightId={focusHighlightId}
            readOnly={readOnly}
            version={passagesVersion}
            onChanged={() => void refreshBook()}
          />
          {standaloneNotes.length > 0 && (
            <section className={styles.standaloneNotes} aria-labelledby="standalone-notes-title">
              <h2 id="standalone-notes-title">Notes without passages</h2>
              {standaloneNotes.map((note) => <NoteCard key={note.id} note={note} readOnly={readOnly} onSaved={async () => { await refreshBook(); }} />)}
            </section>
          )}
        </section>
        <aside className={`ui-panel ${sheet.details}`} aria-label="Book details">
          <div className="ui-panel-head"><h2 className="ui-label">Details</h2></div>
          <div className={sheet.detailsBody}>
          <dl>
            <dt>Reading status</dt>
            <dd>
              <Select
                className={`ll-field ${styles.readingStatus}`}
                value={book.status}
                disabled={statusPending || readOnly}
                aria-label="Reading status"
                onValueChange={(value) => void setStatus(value as ReadingStatus)}
              >
                <SelectItem value="unread">Unread</SelectItem>
                <SelectItem value="reading">Reading</SelectItem>
                <SelectItem value="paused">Paused</SelectItem>
                <SelectItem value="finished">Finished</SelectItem>
              </Select>
            </dd>
            {book.status === "finished" && (
              <>
                <dt>Completed on</dt>
                <dd>
                  <DatePicker
                    className={`ll-field ${styles.readingStatus}`}

                    aria-label="Completion date"
                    value={book.completedOn ?? ""}
                    disabled={statusPending || readOnly}
                    onValueChange={(value) => void setCompletionDate(value || undefined)}
                  />
                </dd>
              </>
            )}
            {book.publisher && <><dt>Publisher</dt><dd>{book.publisher}</dd></>}
            {book.series && <><dt>Series</dt><dd>{book.series}{book.seriesNumber ? `, ${book.seriesNumber}` : ""}</dd></>}
            {book.isbn13 && <><dt>ISBN</dt><dd>{book.isbn13}</dd></>}
          </dl>
          {!!history?.length && (
            <details className={`ll-disclosure ${styles.descriptionDetails}`}>
              <summary>Reading history</summary>
              <ol className={styles.readingHistory} aria-label="Reading history">
                {history.map((event) => (
                  <li key={event.id}>
                    <span className="ui-chip" data-tone={event.status === "finished" ? "good" : event.status === "reading" ? "accent" : event.status === "paused" ? "mark" : undefined}>{statusLabel(event.status)}</span>
                    <time dateTime={new Date(event.changedAt).toISOString()}>{formatDate(event.changedAt)}</time>
                    <small>{historySource(event)}</small>
                  </li>
                ))}
              </ol>
              {historyTruncated && <p className="ll-muted">Showing the latest 100 changes.</p>}
            </details>
          )}
          {collections.length > 0 && (
            <details ref={collectionsDetails} className={`ll-disclosure ${styles.descriptionDetails}`}>
              <summary>Collections{memberNames(collections, organization?.collectionIds)}</summary>
              <SearchableMultiSelect
                inline
                label="Collections"
                disabled={readOnly}
                options={collections.map((item) => ({ id: item.id, label: item.name }))}
                selected={organization?.collectionIds ?? []}
                onChange={(ids) => changeMembership("collection", ids)}
              />
            </details>
          )}
          {tags.length > 0 && (
            <details ref={tagsDetails} className={`ll-disclosure ${styles.descriptionDetails}`}>
              <summary>Tags{memberNames(tags, organization?.tagIds)}</summary>
              <SearchableMultiSelect
                inline
                label="Tags"
                disabled={readOnly}
                options={tags.map((item) => ({ id: item.id, label: item.name }))}
                selected={organization?.tagIds ?? []}
                onChange={(ids) => changeMembership("tag", ids)}
              />
            </details>
          )}
          {book.description && (
            <details className={`ll-disclosure ${styles.descriptionDetails}`}>
              <summary>Book description</summary>
              <p className={styles.description}>{bookDescriptionText(book.description)}</p>
            </details>
          )}
          <InlineError>{error}</InlineError>
          {repeats.length > 0 && contents && (
            <div className={styles.repeats} role="note">
              <p>Some passages appear more than once, perhaps from two imports. Open the extra copies to edit or delete them:</p>
              <ul>
                {repeats.map((group) => {
                  const text = contents.highlights.find(({ id }) => id === group[0])?.text ?? "";
                  return (
                    <li key={group[0]}>
                      <span>“{text.length > 80 ? `${text.slice(0, 80)}…` : text}”</span>
                      {group.slice(1).map((highlightId, index) => (
                        <a key={highlightId} className="ll-text-link" href={href.book(bookId, highlightId)}>{group.length > 2 ? `Copy ${index + 2}` : "Show the copy"}</a>
                      ))}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {!readOnly && (
            <details className={styles.mergeDetails} open={mergeWith ? true : undefined}>
              <summary>
                <GitMerge size={16} aria-hidden="true" />
                Merge duplicate
              </summary>
              <p className="ll-muted">Choose the duplicate and which book should remain in your library.</p>
              <label className="ll-label">Find another copy<input className="ll-field" type="search" value={mergeSearch} placeholder="Title or author" onChange={(event) => { setMergeSearch(event.target.value); setMergeCandidateId(""); }} /></label>
              {mergeCandidates.length === 0 && <p className="ll-muted">No other active book matches. Try a word from the other title or its author.</p>}
              {chosenCandidate && (
                <form className={styles.mergeForm} onSubmit={async (event) => {
                  event.preventDefault();
                  const target = mergeTarget === "current" ? book : chosenCandidate;
                  const source = mergeTarget === "current" ? chosenCandidate : book;
                  if (!await confirm({
                    title: "Merge these books?",
                    message: `Passages, notes, and import links move to “${target.title}”, and “${source.title}” moves to Archived.`,
                    confirmLabel: "Merge books",
                  })) return;
                  setMergePending(true);
                  setError("");
                  try {
                    await window.leaflogue.library.mergeBooks({
                      sourceBookId: source.id,
                      targetBookId: target.id,
                      expectedSourceRevision: source.revision,
                      expectedTargetRevision: target.revision,
                    });
                    if (target.id === book.id) {
                      setCandidates((current) => current.filter((candidate) => candidate.id !== source.id));
                      setMergeCandidateId("");
                      await refreshBook();
                      setPassagesVersion((current) => current + 1);
                    } else {
                      navigate(href.book(target.id));
                    }
                  } catch {
                    setError("One of these books changed before the merge completed. Review them and try again.");
                  } finally {
                    setMergePending(false);
                  }
                }}>
                  <label className="ll-label">Duplicate book<Select className="ll-field" value={chosenCandidate.id} disabled={mergePending} onValueChange={(value) => setMergeCandidateId(value as BookId)}>{mergeCandidates.map((candidate) => <SelectItem key={candidate.id} value={candidate.id}>{candidate.title} — {authorsLabel(candidate.authors)}</SelectItem>)}</Select></label>
                  <label className="ll-label">Merge into<Select className="ll-field" value={mergeTarget} disabled={mergePending} onValueChange={(value) => setMergeTarget(value as "current" | "candidate")}><SelectItem value="current">{book.title} (this book)</SelectItem><SelectItem value="candidate">{chosenCandidate.title}</SelectItem></Select></label>
                  <button className="ll-button-secondary" disabled={mergePending}>{mergePending ? "Merging books…" : "Merge books"}</button>
                </form>
              )}
            </details>
          )}
          </div>
        </aside>
      </div>
      {confirmDialog}
    </div>
  );
}

/** "#3 of 15": where this book stands among the books with passages, by some measure. */
function rankOf(books: readonly LibraryBookStatistics[], bookId: string, measure: (entry: LibraryBookStatistics) => number): string | undefined {
  const eligible = books.filter((entry) => entry.highlights > 0);
  if (eligible.length < 2) return undefined;
  const place = [...eligible].sort((a, b) => measure(b) - measure(a)).findIndex((entry) => entry.bookId === bookId);
  return place >= 0 ? `#${place + 1} of ${eligible.length}` : undefined;
}

function BookTiles({ book, contents, statistics, activeDays, firstDay, lastDay }: {
  readonly book: Book;
  readonly contents: BookContents;
  readonly statistics?: LibraryStatistics;
  readonly activeDays?: number;
  readonly firstDay?: string;
  readonly lastDay?: string;
}) {
  const passages = contents.highlights.length;
  const notes = contents.standaloneNotes.length + contents.highlights.reduce((sum, highlight) => sum + highlight.notes.length, 0);
  const withNotes = contents.highlights.filter((highlight) => highlight.notes.length > 0).length;
  const averageLength = passages ? Math.round(contents.highlights.reduce((sum, highlight) => sum + highlight.text.length, 0) / passages) : 0;
  const perDay = activeDays ? Math.round(passages / activeDays) : 0;
  const books = statistics?.books ?? [];
  const libraryRate = statistics && statistics.totals.highlights > 0 ? (statistics.highlightsWithNotes / statistics.totals.highlights) * 100 : undefined;
  const percent = (value: number) => `${value >= 10 || value === 0 ? Math.round(value) : value.toFixed(1)}%`;
  return (
    <>
      <StatTile label="Passages" value={passages.toLocaleString()} badge={rankOf(books, book.id, (entry) => entry.highlights)} size={26} />
      <StatTile label="Notes" value={notes.toLocaleString()} badge={notes > 0 ? rankOf(books, book.id, (entry) => entry.notes) : undefined} size={26} />
      <StatTile label="Avg length" value={averageLength.toLocaleString()} badge={passages ? rankOf(books, book.id, (entry) => entry.averageLength) : undefined} size={26} />
      {activeDays !== undefined && firstDay && lastDay && (
        <StatTile label="Highlighted over" value={`${activeDays.toLocaleString()} ${activeDays === 1 ? "day" : "days"}`} badge={firstDay === lastDay ? formatDay(firstDay) : `${formatDay(firstDay)} – ${formatDay(lastDay)}`} badgeTone="quiet" size={26} />
      )}
      {activeDays !== undefined && activeDays > 0 && (
        <StatTile label="Per active day" value={perDay.toLocaleString()} badge={rankOf(books, book.id, (entry) => entry.activeDays ? entry.highlights / entry.activeDays : 0)} size={26} />
      )}
      <StatTile label="Note rate" value={passages ? percent((withNotes / passages) * 100) : "–"} badge={libraryRate === undefined ? undefined : `Library ${percent(libraryRate)}`} badgeTone="quiet" size={26} />
    </>
  );
}

/** The first passage kept from this book, as a way back in. */
function Revisit({ contents }: { readonly contents: BookContents }) {
  const first = [...contents.highlights].sort((a, b) => (a.sourceCreatedAt ?? a.createdAt) - (b.sourceCreatedAt ?? b.createdAt))[0];
  if (!first) return null;
  const at = first.sourceCreatedAt ?? first.createdAt;
  return (
    <Panel title="Revisit" padded>
      <blockquote className={sheet.revisit}>{first.text.length > 280 ? `${first.text.slice(0, 280).trimEnd()}…` : first.text}</blockquote>
      <a className="ui-sub" href={href.book(contents.book.id, first.id)}>{formatDate(at)} · the first passage you kept</a>
    </Panel>
  );
}
