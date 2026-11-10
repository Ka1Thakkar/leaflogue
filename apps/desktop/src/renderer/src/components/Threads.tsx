import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Network, Pencil, Plus, Trash2, X } from "../components/icons";
import type { Book, BookId, Thread, ThreadDetails, ThreadId, ThreadPassage } from "@leaflogue/contracts";
import { Icon, StatTile, TitleRow } from "@leaflogue/ui";
import { href, navigate } from "../router";
import { MarkdownText, PlainText } from "./MarkdownText";
import { useConfirm } from "./Confirm";
import { countOf, Cover, Empty, InlineError, Loading, useCrumb } from "./shared";
import styles from "./threads.module.css";
import { useAction } from "./useAction";

const shortDate = (at: number) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** What a thread's passages add up to, for the list and the tiles. */
interface ThreadFigures {
  readonly books: number;
  readonly lastAdded?: number;
}

function figuresOf(details: ThreadDetails | undefined): ThreadFigures {
  if (!details) return { books: 0 };
  const lastAdded = details.passages.reduce<number | undefined>((latest, { addedAt }) => latest === undefined || addedAt > latest ? addedAt : latest, undefined);
  return { books: new Set(details.passages.map(({ bookId }) => bookId)).size, ...(lastAdded !== undefined ? { lastAdded } : {}) };
}

/** Threads beside the open one: a list of every thread, and the selected thread's passages. */
export function ThreadsPage({ selectedId }: { readonly selectedId?: ThreadId } = {}) {
  const [confirm, confirmDialog] = useConfirm();
  const [threads, setThreads] = useState<readonly Thread[]>();
  const [details, setDetails] = useState<ReadonlyMap<ThreadId, ThreadDetails>>(new Map());
  const [books, setBooks] = useState<ReadonlyMap<BookId, Book>>(new Map());
  const [totalPassages, setTotalPassages] = useState<number>();
  const [creating, setCreating] = useState(false);
  const { pending, error, setError, run } = useAction();

  const load = useCallback(async () => {
    let list: readonly Thread[];
    try {
      list = await window.leaflogue.threads.list();
      setThreads(list);
    } catch {
      setThreads((current) => current ?? []);
      setError("Leaflogue could not open your threads.");
      return;
    }
    // Everything below only adds detail; the list works without it.
    const [found, shelf, statistics] = await Promise.all([
      Promise.all(list.map((thread) => window.leaflogue.threads.get(thread.id).catch(() => undefined))),
      window.leaflogue.library.listBooks().catch(() => [] as readonly Book[]),
      window.leaflogue.statistics.get().catch(() => undefined),
    ]);
    setDetails(new Map(found.filter((entry): entry is ThreadDetails => !!entry).map((entry) => [entry.thread.id, entry])));
    setBooks(new Map(shelf.map((book) => [book.id, book])));
    setTotalPassages(statistics?.totals.highlights);
  }, [setError]);
  useEffect(() => { void load(); }, [load]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await run(async () => {
      const thread = await window.leaflogue.threads.create(formValues(form));
      setCreating(false);
      await load();
      navigate(href.thread(thread.id));
    }, "That thread could not be saved. Its name must be unique and up to date.");
  }

  const figures = new Map((threads ?? []).map((thread) => [thread.id, figuresOf(details.get(thread.id))]));
  // Most recently added to first; a thread nothing was added to yet goes by when it was made.
  const ordered = [...(threads ?? [])].sort((a, b) =>
    (figures.get(b.id)?.lastAdded ?? b.createdAt) - (figures.get(a.id)?.lastAdded ?? a.createdAt) || a.name.localeCompare(b.name));
  const selected = selectedId ?? ordered[0]?.id;
  const allPassages = [...details.values()].flatMap(({ passages }) => passages);
  const connected = new Set(allPassages.map(({ bookId }) => bookId)).size;
  const threaded = new Set(allPassages.map(({ highlightId }) => highlightId)).size;
  const largest = ordered.reduce<Thread | undefined>((best, thread) => !best || thread.passageCount > best.passageCount ? thread : best, undefined);
  const share = totalPassages ? (threaded / totalPassages) * 100 : undefined;

  const newButton = <button className="ll-button" onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" />New thread</button>;
  return (
    <div className={styles.page}>
      <TitleRow title="Threads" meta="Ideas you follow across books" actions={threads && threads.length > 0 ? newButton : undefined} />
      {creating && <ThreadForm pending={pending} onSubmit={(event) => void create(event)} onCancel={() => setCreating(false)} />}
      <InlineError>{error}</InlineError>
      {threads === undefined ? (
        <Loading>Opening your threads…</Loading>
      ) : threads.length === 0 && !selectedId ? (
        !creating && (
          <section className={styles.empty} aria-labelledby="empty-threads-title">
            <div className={styles.emptyLead}>
              <Network size={32} aria-hidden="true" />
              <h2 id="empty-threads-title">What keeps appearing in your reading?</h2>
              <button className="ll-button" onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" />Create your first thread</button>
            </div>
            <ol className={styles.guide}>
              <li><span>01</span><div><strong>Name the idea</strong></div></li>
              <li><span>02</span><div><strong>Collect passages</strong></div></li>
              <li><span>03</span><div><strong>Read across books</strong></div></li>
            </ol>
          </section>
        )
      ) : (
        <>
          {threads.length > 0 && (
            <div className={styles.tiles}>
              <StatTile label="Threads" value={threads.length.toLocaleString()} />
              <StatTile label="Passages in threads" value={threaded.toLocaleString()} sub={share !== undefined ? `${share < 1 && share > 0 ? share.toFixed(1) : Math.round(share)}% of your passages` : undefined} />
              <StatTile label="Books connected" value={connected.toLocaleString()} sub={books.size > 0 ? `of ${books.size.toLocaleString()}` : undefined} />
              <StatTile label="Largest" tone="mark" value={(largest?.passageCount ?? 0).toLocaleString()} sub={largest?.name} />
            </div>
          )}
          <div className={styles.layout}>
            {threads.length > 0 && (
              <nav className={`ui-panel ${styles.list}`} aria-label="Your threads">
                <div className="ui-panel-head"><h2 className="ui-label">Your threads</h2><span className="ui-sub">Recently added</span></div>
                <ul>
                  {ordered.map((thread) => {
                    const { books: bookCount, lastAdded } = figures.get(thread.id) ?? { books: 0 };
                    return (
                      <li key={thread.id}>
                        <a href={href.thread(thread.id)} aria-current={thread.id === selected ? "page" : undefined}>
                          <strong>{thread.name}</strong>
                          {thread.description && <span className="ui-sub">{thread.description}</span>}
                          <dl>
                            <div><dt className="ui-label">Passages</dt><dd className="ui-number">{thread.passageCount.toLocaleString()}</dd></div>
                            <div><dt className="ui-label">Books</dt><dd className="ui-number">{bookCount.toLocaleString()}</dd></div>
                            <div><dt className="ui-label">Last added</dt><dd className="ui-number">{lastAdded ? shortDate(lastAdded) : "–"}</dd></div>
                          </dl>
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </nav>
            )}
            {selected && (
              <ThreadPanel
                key={selected}
                threadId={selected}
                books={books}
                onChanged={load}
                onDeleted={async () => { await load(); navigate(href.threads()); }}
                confirm={confirm}
              />
            )}
          </div>
        </>
      )}
      {confirmDialog}
    </div>
  );
}


function formValues(form: FormData) {
  return { name: String(form.get("name") ?? ""), description: String(form.get("description") ?? "").trim() || undefined };
}

function ThreadForm({ pending, initial, onSubmit, onCancel }: {
  readonly pending: boolean;
  readonly initial?: Pick<Thread, "name" | "description">;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly onCancel: () => void;
}) {
  return (
    <form className={styles.form} onSubmit={onSubmit}>
      <label className="ll-label">Thread name<input autoFocus className="ll-field" name="name" required maxLength={120} defaultValue={initial?.name} placeholder="Power, exile, belonging…" /></label>
      <label className="ll-label">What connects these passages? <span className="ll-muted">Optional</span><textarea className="ll-field" name="description" rows={3} maxLength={1000} defaultValue={initial?.description} /></label>
      <div className={styles.actions}>
        <button className="ll-button" disabled={pending}>{pending ? "Saving…" : "Save thread"}</button>
        <button type="button" className="ll-button-secondary" onClick={onCancel}><X size={16} aria-hidden="true" />Cancel</button>
      </div>
    </form>
  );
}

function Thumb({ book, title }: { readonly book?: Book; readonly title: string }) {
  return <span className={styles.thumb}><Cover book={book ?? { title, authors: [] }} /></span>;
}

function ThreadPanel({ threadId, books, onChanged, onDeleted, confirm }: {
  readonly threadId: ThreadId;
  readonly books: ReadonlyMap<BookId, Book>;
  readonly onChanged: () => Promise<void>;
  readonly onDeleted: () => Promise<void>;
  readonly confirm: ReturnType<typeof useConfirm>[0];
}) {
  const [thread, setThread] = useState<ThreadDetails | null>();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const { pending, error, setError, run } = useAction();
  const load = useCallback(async () => {
    try {
      setThread((await window.leaflogue.threads.get(threadId)) ?? null);
    } catch {
      setThread((current) => current ?? null);
      setError("Leaflogue could not open this thread.");
    }
  }, [threadId, setError]);
  useEffect(() => { void load(); }, [load]);
  useCrumb(thread?.thread.name);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!thread) return;
    const form = new FormData(event.currentTarget);
    await run(async () => {
      await window.leaflogue.threads.update({ id: thread.thread.id, ...formValues(form), expectedRevision: thread.thread.revision });
      setEditing(false);
      await Promise.all([load(), onChanged()]);
    }, "That thread could not be saved. Its name must be unique and up to date.");
  }

  async function remove() {
    if (!thread) return;
    const { name, id, revision } = thread.thread;
    if (!await confirm({
      title: "Delete thread?",
      message: `“${name}” will be deleted. The passages themselves will stay in your library.`,
      confirmLabel: "Delete thread",
      destructive: true,
    })) return;
    await run(async () => {
      await window.leaflogue.threads.delete({ id, expectedRevision: revision });
      await onDeleted();
    }, "That thread changed before it could be deleted. Review it and try again.");
  }

  async function removePassage(passage: ThreadPassage) {
    setRemoving(passage.highlightId);
    setError("");
    try {
      const [contents, memberships] = await Promise.all([
        window.leaflogue.library.getBookContents(passage.bookId),
        window.leaflogue.threads.getHighlightMembership(passage.bookId, passage.highlightId),
      ]);
      const highlight = contents?.highlights.find(({ id }) => id === passage.highlightId);
      if (!highlight) throw new Error("Passage is no longer available");
      await window.leaflogue.threads.setHighlightMembership({
        bookId: passage.bookId,
        highlightId: passage.highlightId,
        threadIds: memberships.filter((id) => id !== threadId),
        expectedHighlightRevision: highlight.revision,
      });
      await Promise.all([load(), onChanged()]);
    } catch {
      setError("That passage changed before it could be removed. Reload the thread and try again.");
    } finally {
      setRemoving(null);
    }
  }

  if (thread === undefined) return <section className={`ui-panel ${styles.detail}`}><Loading>Gathering passages…</Loading></section>;
  if (thread === null) {
    return (
      <section className={`ui-panel ${styles.detail}`}>
        <InlineError>{error}</InlineError>
        {!error && <Empty title="Thread not found"><p className="ll-muted">This thread may have been deleted. Its passages remain in your library.</p></Empty>}
      </section>
    );
  }

  const { passages } = thread;
  const perBook = new Map<BookId, { title: string; count: number }>();
  for (const passage of passages) {
    const entry = perBook.get(passage.bookId) ?? { title: passage.bookTitle, count: 0 };
    entry.count += 1;
    perBook.set(passage.bookId, entry);
  }
  const { name, description } = thread.thread;
  return (
    <section className={`ui-panel ${styles.detail}`} aria-labelledby="thread-title">
      <header className={styles.head}>
        {editing ? (
          <ThreadForm pending={pending} initial={thread.thread} onSubmit={(event) => void save(event)} onCancel={() => setEditing(false)} />
        ) : (
          <>
            <div className={styles.headText}>
              <p className={styles.eyebrow}>Thread · {countOf(passages.length, "passage")} · {countOf(perBook.size, "book")}</p>
              <h2 id="thread-title">{name}</h2>
              {description && <MarkdownText className="ui-sub" text={description} />}
            </div>
            <div className={styles.headActions}>
              <button type="button" className="ll-button-secondary" aria-label={`Edit ${name}`} disabled={pending} onClick={() => setEditing(true)}><Pencil size={15} aria-hidden="true" />Edit</button>
              <button type="button" className="ui-icon-btn" data-outline="" aria-label={`Delete ${name}`} title="Delete thread" disabled={pending} onClick={() => void remove()}><Trash2 size={15} aria-hidden="true" /></button>
            </div>
          </>
        )}
        {perBook.size > 0 && (
          <ul className={styles.books} aria-label="Books in this thread">
            {[...perBook].map(([bookId, { title, count }]) => (
              <li key={bookId}>
                <a href={href.book(bookId)}>
                  <Thumb book={books.get(bookId)} title={title} />
                  <span><span>{title}</span><span className="ui-sub">{countOf(count, "passage")}</span></span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </header>
      <InlineError>{error}</InlineError>
      {passages.length === 0 ? (
        <p className={`ui-sub ${styles.none}`}>No passages yet. Use the thread action beside any highlight to connect it here.</p>
      ) : (
        <ol className={styles.passages}>
          {passages.map((passage) => (
            <li key={passage.highlightId}>
              <Thumb book={books.get(passage.bookId)} title={passage.bookTitle} />
              <div className={styles.passageBody}>
                <p className={styles.passageMeta}>
                  <a href={href.book(passage.bookId, passage.highlightId)}>{passage.bookTitle}</a>
                  <span>added {shortDate(passage.addedAt)}</span>
                  <span>{passage.text.length.toLocaleString()} chars</span>
                </p>
                <blockquote><PlainText text={passage.text} /></blockquote>
                {passage.notes.map((note) => (
                  <div key={note.id} className={styles.note}><span>Note</span><MarkdownText text={note.markdown} /></div>
                ))}
              </div>
              <div className={styles.passageActions}>
                <a className="ui-icon-btn" href={href.book(passage.bookId, passage.highlightId)} aria-label={`Open in ${passage.bookTitle}`} title="Open in its book"><Icon name="arrow-right" size={14} /></a>
                <button type="button" className="ui-icon-btn" aria-label="Remove from thread" title="Remove from thread" disabled={removing === passage.highlightId} onClick={() => void removePassage(passage)}><X size={15} aria-hidden="true" /></button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
