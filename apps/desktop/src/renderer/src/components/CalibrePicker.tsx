import { useEffect, useState } from "react";
import type { BookId, CalibreBook, CalibreConnection, CalibreFormat, CalibreSearch, EpubDocument } from "@leaflogue/contracts";
import { InlineError } from "./shared";
import styles from "./epub-reader.module.css";

export function CalibrePicker({ bookId, title, onLinked, onClose }: { readonly bookId: BookId; readonly title: string; readonly onLinked: (document: EpubDocument) => void; readonly onClose: () => void }) {
  const [connection, setConnection] = useState<CalibreConnection>();
  const [query, setQuery] = useState(title.slice(0, 200));
  const [results, setResults] = useState<CalibreSearch>();
  const [selected, setSelected] = useState<CalibreBook>();
  const [format, setFormat] = useState<CalibreFormat>("EPUB");
  const [choosing, setChoosing] = useState(false);
  const [searching, setSearching] = useState(false);
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void window.leaflogue.calibre?.describe().then((next) => { if (active) setConnection(next); }).catch(() => { if (active) setError("The connected library is unavailable. Choose its current folder to reconnect."); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true;
    if (!connection) return;
    const timer = setTimeout(() => {
      setSearching(true); setError("");
      void window.leaflogue.calibre!.search(bookId, query).then((next) => { if (active) setResults(next); }).catch((failure: unknown) => { if (active) setError(String(failure)); }).finally(() => { if (active) setSearching(false); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [connection, bookId, query]);
  async function choose() {
    setChoosing(true); setError(""); setSelected(undefined);
    try { const next = await window.leaflogue.calibre!.choose(); if (next) { setResults(undefined); setConnection(next); } }
    catch { setError("Choose a Calibre library folder containing metadata.db. Leaflogue needs read access to that folder."); }
    finally { setChoosing(false); }
  }
  async function link() {
    if (!selected || !selected.formats.includes(format)) return;
    setLinking(true); setError("");
    try { onLinked(await window.leaflogue.calibre!.link(bookId, selected.uuid, format)); }
    catch (failure) { setError(String(failure)); }
    finally { setLinking(false); }
  }
  return <div className={styles.calibrePicker}>
    <div className={styles.optionHeading}><h2>Link from Calibre</h2><button className="ll-button-secondary" disabled={linking} onClick={onClose}>Back</button></div>
    <p className="ll-muted">Calibre keeps the file. Leaflogue reads it in place and never modifies your Calibre library.</p>
    <button className="ll-button-secondary" disabled={choosing || linking} onClick={() => void choose()}>{choosing ? "Choosing library…" : connection ? "Change library folder" : "Choose Calibre library"}</button>
    {connection && <>
      <p className="ll-muted">{connection.name} · {connection.bookCount} books with EPUB or KEPUB</p>
      <label className="ll-label">Search Calibre<input className="ll-field" placeholder="Title, author, or ISBN" value={query} maxLength={200} disabled={linking} onChange={(event) => { setQuery(event.target.value); setSearching(true); setSelected(undefined); }} /></label>
      {searching && <p role="status" className="ll-muted">Searching your library…</p>}
      {results && <fieldset className={styles.calibreResults} disabled={linking || searching || choosing}>
        <legend className="ll-label">Choose the matching edition</legend>
        {results.books.map((book) => <label key={book.uuid}>
          <input type="radio" name="calibre-edition" value={book.uuid} checked={selected?.uuid === book.uuid} onChange={() => { setSelected(book); setFormat(book.formats[0] ?? "EPUB"); }} />
          <span><strong>{book.title}</strong><small>{book.authors.join(", ")}{book.isbn13 ? ` · ${book.isbn13}` : ""}</small><small>{book.formats.join(" · ")}</small>{book.match !== "none" && <small>{book.match === "isbn" ? "ISBN match" : "Title and author match"}</small>}</span>
        </label>)}
        {!results.books.length && <p>No EPUB or KEPUB books found. Clear the search to browse this library.</p>}
        {results.hasMore && <p className="ll-muted">Showing the first 50 matches. Refine your search to find another edition.</p>}
      </fieldset>}
      {selected && <fieldset className={styles.calibreResults} disabled={linking || searching || choosing}>
        <legend className="ll-label">Book format</legend>
        {selected.formats.map((available) => <label key={available}><input type="radio" name="calibre-format" value={available} checked={format === available} onChange={() => setFormat(available)} /><span>{available}{available === "KEPUB" ? " (Kobo EPUB)" : ""}</span></label>)}
        <p className="ll-muted">Leaflogue links the selected format in place. It does not convert or copy the file.</p>
      </fieldset>}
      <button className="ll-button" disabled={!selected || linking || searching || choosing} onClick={() => void link()}>{linking ? "Linking…" : `Link selected ${format}`}</button>
    </>}
    <InlineError>{error}</InlineError>
  </div>;
}
