import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import type { DictionaryResult } from "@leaflogue/contracts";
import { BookOpen, X } from "./icons";
import { useCommands } from "../palette/commands";
import styles from "./dictionary.module.css";

/** Local dictionary shared by every reading surface in the desktop renderer. */
export function Dictionary() {
  const lookup = window.leaflogue.system.lookupWord;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<DictionaryResult>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [selection, setSelection] = useState<{ word: string; left: number; top: number }>();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const request = useRef(0);
  const search = useCallback(async (word: string) => {
    if (!lookup || !word.trim()) return;
    const token = ++request.current;
    setPending(true); setError(""); setResult(undefined);
    try { const next = await lookup(word); if (request.current === token) setResult(next); }
    catch { if (request.current === token) setError("The dictionary could not look up that word. Check the spelling and try again."); }
    finally { if (request.current === token) setPending(false); }
  }, [lookup]);
  useEffect(() => {
    if (open) { dialog.current?.showModal(); input.current?.focus(); }
    else dialog.current?.close();
  }, [open]);
  useEffect(() => {
    if (!lookup) return;
    const selectedWord = (event: MouseEvent) => {
      if (open || !(event.target instanceof Element) || event.target.closest('input, textarea, [contenteditable="true"], dialog, [data-dictionary-control]')) return;
      const selected = window.getSelection();
      const word = selected?.toString().trim() ?? "";
      if (!selected?.rangeCount || !/^[\p{L}][\p{L}\p{M}'’-]{0,59}$/u.test(word) || !event.target.closest("#content")) { setSelection(undefined); return; }
      const rect = selected.getRangeAt(0).getBoundingClientRect();
      setSelection({ word, left: Math.max(8, Math.min(rect.left, innerWidth - 190)), top: Math.max(8, Math.min(rect.bottom + 8, innerHeight - 48)) });
    };
    const clear = () => setSelection(undefined);
    document.addEventListener("mouseup", selectedWord);
    window.addEventListener("scroll", clear, true);
    window.addEventListener("resize", clear);
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") clear(); };
    window.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mouseup", selectedWord); window.removeEventListener("scroll", clear, true); window.removeEventListener("resize", clear); window.removeEventListener("keydown", escape); };
  }, [lookup, open]);
  const close = () => { ++request.current; setPending(false); setOpen(false); setSelection(undefined); trigger.current?.focus(); };
  const show = (word = "") => { setQuery(word); setResult(undefined); setError(""); setSelection(undefined); setOpen(true); if (word) void search(word); };
  function submit(event: FormEvent) { event.preventDefault(); void search(query); }
  useCommands(lookup ? [{ id: "dictionary.open", title: "Open offline dictionary", subtitle: "English definitions and synonyms, on this computer", keywords: "define word meaning vocabulary wordnet lookup", icon: "library", run: () => show() }] : []);
  if (!lookup) return null;
  return <>
    <button ref={trigger} type="button" className="ll-icon-button" aria-label="Offline dictionary" title="Offline dictionary" onClick={() => show()}><BookOpen size={18} aria-hidden="true" /></button>
    {createPortal(<>
      {selection && <button type="button" data-dictionary-control className={styles.selection} style={{ left: selection.left, top: selection.top }} onMouseDown={event => event.preventDefault()} onClick={() => show(selection.word)}><BookOpen size={15} aria-hidden="true" />Define “{selection.word}”</button>}
      <dialog ref={dialog} className={`ll-dialog ${styles.dialog}`} aria-labelledby="dictionary-heading" onCancel={event => { event.preventDefault(); close(); }} onClose={close}>
        <header className={styles.heading}><h2 id="dictionary-heading">Offline dictionary</h2><button type="button" className="ll-icon-button" aria-label="Close dictionary" onClick={close}><X size={18} aria-hidden="true" /></button></header>
        <form className={styles.search} onSubmit={submit}><label className="sr-only" htmlFor="dictionary-word">Word or phrase</label><input ref={input} id="dictionary-word" className="ll-field" value={query} maxLength={80} required autoComplete="off" spellCheck={false} placeholder="Look up a word…" onChange={event => setQuery(event.target.value)} /><button className="ll-button" disabled={pending || !query.trim()}>{pending ? "Looking up…" : "Define"}</button></form>
        <p className="ll-muted">English · WordNet 3.1 · Works entirely on this computer.</p>
        <div className={styles.results} aria-live="polite" aria-busy={pending}>
          {error && <p role="alert" className="ll-inline-error">{error}</p>}
          {result && <><h3>{result.word}</h3>{result.definitions.length ? <ol>{result.definitions.map((entry, i) => <li key={i}><p className={styles.part}>{entry.partOfSpeech}</p><p>{entry.definition}</p>{entry.synonyms.length > 0 && <p className={styles.synonyms}>Also: {entry.synonyms.join(", ")}</p>}</li>)}</ol> : <p>No entry found. Try the singular or base form, or check the spelling.</p>}</>}
          {!pending && !result && !error && <p>Select a word in a passage and choose Define, or enter a word above.</p>}
        </div>
        <p className={styles.credit}>Definitions: Princeton University WordNet. Licence included in Third-party notices.</p>
      </dialog>
    </>, document.body)}
  </>;
}
