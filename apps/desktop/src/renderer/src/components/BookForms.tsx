import { useCallback, useEffect, useRef, useState } from "react";
import type { CatalogBook, CatalogSearch, Book, BookMetadataField, BookMetadataSource, UpdateBookMetadata } from "@leaflogue/contracts";
import { InlineError } from "./shared";
import styles from "./knowledge.module.css";
import { useAction } from "./useAction";

export function BookForm({ onClose, onSaved }: { readonly onClose: () => void; readonly onSaved: (book: Book) => void }) {
  const { pending, error, run } = useAction();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [results, setResults] = useState<CatalogSearch>();
  const [selected, setSelected] = useState<CatalogBook>();
  const [created, setCreated] = useState<Book>();
  const request = useRef(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [composing, setComposing] = useState(false);
  const invalidateSearch = useCallback(() => { request.current++; clearTimeout(debounce.current); }, []);
  const searchBooks = useCallback(async (value: string, token: number) => {
    if (!value.trim() || !window.leaflogue.catalog) return;
    if (new TextEncoder().encode(value).byteLength > 200) { setSearchError("Search must be at most 200 bytes. Try a shorter title or an ISBN."); return; }
    setSearching(true); setSearchError(""); setResults(undefined);
    try {
      const next = await window.leaflogue.catalog.search(value.trim());
      if (token === request.current) setResults(next);
    } catch {
      if (token === request.current) setSearchError("Book search is unavailable. Try again or enter the book manually below.");
    } finally { if (token === request.current) setSearching(false); }
  }, []);
  useEffect(() => {
    const token = ++request.current;
    if (!created && !composing && query.trim().length >= 2) {
      debounce.current = setTimeout(() => { void searchBooks(query, token); }, 400);
    }
    return invalidateSearch;
  }, [query, created, composing, searchBooks, invalidateSearch]);
  function changeQuery(value: string) {
    request.current++; clearTimeout(debounce.current);
    setQuery(value); setResults(undefined); setSearchError(""); setSearching(false);
  }
  function choose(item: CatalogBook) {
    setSelected(item);
  }
  return <>
    {window.leaflogue.catalog && <form className={styles.form} aria-label="Search book catalogue" onSubmit={(event) => {
      event.preventDefault();
      if (composing || created) return;
      clearTimeout(debounce.current);
      void searchBooks(String(new FormData(event.currentTarget).get("query") ?? ""), ++request.current);
    }}>
      <label className="ll-label">Search books online
        <input className="ll-field" placeholder="Title, author, or ISBN" autoFocus name="query" value={query} onChange={(event) => changeQuery(event.target.value)} onCompositionStart={() => { request.current++; clearTimeout(debounce.current); setComposing(true); }} onCompositionEnd={() => setComposing(false)} maxLength={200} disabled={Boolean(created)} />
      </label>
      <p className="ll-muted">Search sends your query to Google Books, with Open Library as a fallback. Your library and notes are not sent.</p>
      <button className="ll-button-secondary" disabled={searching || !query.trim() || Boolean(created)}>{searching ? "Searching…" : "Search books"}</button>
      {searching && <p role="status" className="ll-muted">Searching for books…</p>}
      <InlineError>{searchError}</InlineError>
      {results && <div aria-live="polite">
        <p className="ll-muted">{results.source === "google-books" ? "Google Books" : "Open Library"} · {results.items.length ? "Choose an edition to fill in the details below." : "No books found. Try another search or enter the details below."}</p>
        <ul className={styles.catalogResults} aria-label="Book search results">
          {results.items.map((item) => <li key={`${item.provider}:${item.providerId}`}>
            <button type="button" disabled={pending || Boolean(created)} aria-pressed={selected?.provider === item.provider && selected.providerId === item.providerId} onClick={() => choose(item)}>
              <strong>{item.title}</strong><span>{item.authors.join(", ") || "Unknown author"}</span>
              <small>{[item.publisher, item.language, item.isbn13 ? `ISBN ${item.isbn13}` : undefined].filter(Boolean).join(" · ")}</small>
            </button>
          </li>)}
        </ul>
      </div>}
    </form>}
    <form key={selected ? `${selected.provider}:${selected.providerId}` : "manual"} className={styles.form} aria-label="Book details" onSubmit={async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const title = String(form.get("title") ?? "");
      const authors = String(form.get("authors") ?? "");
      const isbn = String(form.get("isbn") ?? "");
      await run(async () => {
        const details = { title, authors: authors.split(/[;\n]/u).map((author) => author.trim()).filter(Boolean), ...(isbn.trim() ? { isbn13: isbn.trim() } : {}) };
        const book = created ?? await window.leaflogue.library.createBook(details);
        setCreated(book);
        let saved = book;
        if (selected) {
          saved = await window.leaflogue.library.updateBookMetadata({
            id: book.id, expectedRevision: book.revision, ...details,
            ...(selected.description ? { description: selected.description } : {}),
            ...(selected.publisher ? { publisher: selected.publisher } : {}),
            ...(selected.language ? { language: selected.language } : {}),
            ...(selected.coverUrl ? { coverUrl: selected.coverUrl } : {}),
          });
        }
        onClose(); onSaved(saved);
      }, created ? "The book was added, but its extra details could not be saved. Retry to finish saving this book." : "The book could not be saved completely. Check its title and ISBN-13, then try again.");
    }}>
      <fieldset disabled={pending} className={styles.fields}>
        <legend>{selected ? "Review book details" : "Or enter book details manually"}</legend>
        <label className="ll-label">Title<input autoFocus={!window.leaflogue.catalog} required name="title" className="ll-field" maxLength={1000} defaultValue={selected?.title ?? ""} /></label>
        <label className="ll-label">Authors<textarea name="authors" className="ll-field" rows={2} defaultValue={selected?.authors.join("\n") ?? ""} /><span className="ll-muted">Separate authors with a new line or semicolon.</span></label>
        <label className="ll-label">ISBN<input className="ll-field" name="isbn" defaultValue={selected?.isbn13 ?? ""} /></label>
      </fieldset>
      {created && error && <p role="status">The book already exists in your library. Retry saves its remaining details.</p>}
      <InlineError>{error}</InlineError>
      <div className={styles.actions}>
        <button className="ll-button" disabled={pending}>{pending ? "Saving…" : created ? "Retry saving details" : "Add book"}</button>
        <button type="button" className="ll-button-secondary" disabled={pending} onClick={onClose}>Cancel</button>
      </div>
    </form>
  </>;
}

const METADATA_LABELS: Readonly<Record<BookMetadataField, string>> = {
  title: "Title",
  authors: "Authors",
  description: "Description",
  publisher: "Publisher",
  series: "Series",
  seriesNumber: "Series number",
  language: "Language",
  isbn13: "ISBN",
  coverUrl: "Cover image URL",
};

function metadataOf(book: Book): Omit<UpdateBookMetadata, "id" | "expectedRevision"> {
  return {
    title: book.title,
    authors: book.authors,
    ...(book.description ? { description: book.description } : {}),
    ...(book.publisher ? { publisher: book.publisher } : {}),
    ...(book.series ? { series: book.series } : {}),
    ...(book.seriesNumber ? { seriesNumber: book.seriesNumber } : {}),
    ...(book.language ? { language: book.language } : {}),
    ...(book.isbn13 ? { isbn13: book.isbn13 } : {}),
    ...(book.coverUrl ? { coverUrl: book.coverUrl } : {}),
  };
}

function metadataValue(metadata: Partial<Omit<UpdateBookMetadata, "id" | "expectedRevision">>, field: BookMetadataField): string {
  const value = metadata[field];
  return Array.isArray(value) ? value.join("\u0000") : (value as string | undefined) ?? "";
}

/** Fields where the reader's value differs from the latest source value. */
export function resettableFields(book: Book, source: BookMetadataSource | undefined): BookMetadataField[] {
  if (!source) return [];
  const current = metadataOf(book);
  return (Object.keys(METADATA_LABELS) as BookMetadataField[])
    .filter((field) => metadataValue(current, field) !== metadataValue(source.values, field));
}

export function MetadataForm({ book, onClose, onSaved }: { readonly book: Book; readonly onClose: () => void; readonly onSaved: (book: Book) => void }) {
  const { pending, setPending, error, setError } = useAction();
  return (
    <form
      className={styles.form}
      onSubmit={async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const optional = (key: string) => String(form.get(key) ?? "").trim() || undefined;
        setPending(true);
        setError("");
        try {
          const saved = await window.leaflogue.library.updateBookMetadata({
            id: book.id,
            expectedRevision: book.revision,
            title: String(form.get("title") ?? ""),
            authors: String(form.get("authors") ?? "").split(/[;\n]/u).map((author) => author.trim()).filter(Boolean),
            ...(optional("description") ? { description: optional("description") } : {}),
            ...(optional("publisher") ? { publisher: optional("publisher") } : {}),
            ...(optional("series") ? { series: optional("series") } : {}),
            ...(optional("seriesNumber") ? { seriesNumber: optional("seriesNumber") } : {}),
            ...(optional("isbn13") ? { isbn13: optional("isbn13") } : {}),
            ...(optional("coverUrl") ? { coverUrl: optional("coverUrl") } : {}),
            ...(book.language ? { language: book.language } : {}),
          });
          onSaved(saved);
          onClose();
        } catch {
          setError("The metadata could not be saved. Check the title and ISBN-13; the book may also have changed elsewhere.");
        } finally {
          setPending(false);
        }
      }}
    >
      <fieldset disabled={pending} className={styles.fields}>
        <label className="ll-label">
          Title
          <input autoFocus required name="title" className="ll-field" defaultValue={book.title} maxLength={1000} />
        </label>
        <label className="ll-label">
          Authors
          <textarea name="authors" className="ll-field" rows={2} defaultValue={book.authors.join("\n")} />
          <span className="ll-muted">Separate authors with a new line or semicolon.</span>
        </label>
        <label className="ll-label">
          Description
          <textarea name="description" className="ll-field" rows={4} defaultValue={book.description} maxLength={20_000} />
        </label>
        <div className={styles.formColumns}>
          {([["publisher", "Publisher", book.publisher], ["isbn13", "ISBN", book.isbn13], ["series", "Series", book.series], ["seriesNumber", "Series number", book.seriesNumber]] as const).map(([name, label, value]) => (
            <label className="ll-label" key={name}>
              {label}
              <input className="ll-field" name={name} defaultValue={value} />
            </label>
          ))}
        </div>
        <label className="ll-label">
          Cover image URL
          <input className="ll-field" name="coverUrl" type="url" inputMode="url" defaultValue={book.coverUrl} maxLength={2_048} placeholder="https://…" />
          <span className="ll-muted">HTTPS cover images from Google Books, Open Library, and Internet Archive are loaded through Leaflogue's private cache.</span>
        </label>
      </fieldset>
      <InlineError>{error}</InlineError>
      <div className={styles.actions}>
        <button className="ll-button" disabled={pending}>{pending ? "Saving…" : "Save metadata"}</button>
        <button type="button" className="ll-button-secondary" disabled={pending} onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}

export function ResetMetadata({ book, source, onClose, onSaved }: {
  readonly book: Book;
  readonly source: BookMetadataSource;
  readonly onClose: () => void;
  readonly onSaved: (book: Book) => void;
}) {
  const [pending, setPending] = useState<BookMetadataField | "">("");
  const [error, setError] = useState("");
  const fields = resettableFields(book, source);
  return (
    <div className={styles.collectionManager}>
      <p className="ll-muted">Restore one field from {source.sourceName}, the most recent import of this book. Your other edits stay unchanged.</p>
      {fields.length === 0 ? <p className="ll-muted">Every field already matches the import.</p> : (
        <ul className={styles.collectionList}>
          {fields.map((field) => (
            <li key={field}>
              <span><strong>{METADATA_LABELS[field]}</strong><small>{metadataValue(source.values, field).split("\u0000").join(", ") || "Empty in the import"}</small></span>
              <button className="ll-button-secondary" disabled={!!pending} onClick={async () => {
                setPending(field);
                setError("");
                try {
                  const next = { ...metadataOf(book), [field]: source.values[field] };
                  if (source.values[field] === undefined) delete (next as Record<string, unknown>)[field];
                  onSaved(await window.leaflogue.library.updateBookMetadata({ id: book.id, expectedRevision: book.revision, ...next, authors: next.authors ?? [] }));
                  onClose();
                } catch {
                  setError("That field could not be reset. The book may have changed elsewhere, or its ISBN-13 belongs to another book.");
                  setPending("");
                }
              }}>{pending === field ? "Resetting…" : "Reset"}</button>
            </li>
          ))}
        </ul>
      )}
      <InlineError>{error}</InlineError>
      <button className="ll-button-secondary" disabled={!!pending} onClick={onClose}>Cancel</button>
    </div>
  );
}
