import { useEffect, useRef, useState } from "react";
import type { ArticlePreview, Book } from "@leaflogue/contracts";
import { InlineError } from "./shared";
import styles from "./knowledge.module.css";

/** A capture adapter; saving/reopening uses the ordinary library page and reader. */
export function ArticleForm({ onClose, onSaved, onBusyChange }: { readonly onClose: () => void; readonly onSaved: (book: Book) => void; readonly onBusyChange?: (busy: boolean) => void }) {
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<ArticlePreview>();
  const [busy, setBusy] = useState<"retrieve" | "save">();
  useEffect(() => { onBusyChange?.(busy !== undefined); }, [busy, onBusyChange]);
  const [error, setError] = useState("");
  const operation = useRef<string | undefined>(undefined);
  const request = useRef(0);
  useEffect(() => () => {
    request.current++;
    if (operation.current) void window.leaflogue.articles?.cancel(operation.current).catch(() => undefined);
  }, []);
  function cancel() {
    request.current++;
    if (operation.current) void window.leaflogue.articles?.cancel(operation.current).catch(() => undefined);
    operation.current = undefined; setBusy(undefined); setPreview(undefined);
  }
  async function retrieve() {
    const service = window.leaflogue.articles; if (!service) return;
    cancel(); const ticket = ++request.current; const token = crypto.randomUUID(); operation.current = token;
    setError(""); setBusy("retrieve");
    try {
      const next = await service.preview(url, token);
      if (ticket === request.current) setPreview(next);
    } catch {
      if (ticket === request.current) setError("The article could not be retrieved. Use a public HTTPS page that does not require sign-in, then try again. Your library has not been changed.");
    } finally { if (ticket === request.current) setBusy(undefined); }
  }
  async function save() {
    if (!preview || !window.leaflogue.articles) return;
    setBusy("save"); setError("");
    try { const book = await window.leaflogue.articles.save(preview.token); onSaved(book); onClose(); }
    catch (failure) {
      if (failure instanceof Error && failure.message.includes("preview expired")) {
        setPreview(undefined); setError("This preview expired or the library changed. Preview the article again before saving.");
      } else setError("The article could not be saved completely. Keep this preview and retry to finish linking it without creating another entry.");
    }
    finally { setBusy(undefined); }
  }
  return <div className={styles.form}>
    <p className="ll-muted">Capture readable text from a public web page. The page is fetched on this computer only after you choose Preview. Images, scripts and login sessions are not loaded.</p>
    <form className={styles.form} aria-label="Capture web article" onSubmit={(event) => { event.preventDefault(); void retrieve(); }}>
      <label className="ll-label">Article URL<input className="ll-field" type="url" required maxLength={4096} placeholder="https://example.com/article" value={url} disabled={busy === "save"} onChange={event => { cancel(); setUrl(event.target.value); }} /></label>
      <div>{busy === "retrieve" ? <button type="button" className="ll-button-secondary" onClick={cancel}>Cancel retrieval</button> : <button className="ll-button-secondary" disabled={busy === "save"}>Preview article</button>}</div>
    </form>
    <InlineError>{error}</InlineError>
    {preview && <section aria-label="Article preview">
      <h3>{preview.title}</h3><p className="ll-muted" style={{ overflowWrap: "anywhere" }}>{preview.url}</p><p className="ll-muted">{preview.author || "Author not supplied"} · {preview.paragraphs} paragraphs</p>
      <p style={{ whiteSpace: "pre-wrap" }}>{preview.excerpt}</p>
      <p className="ll-muted">{preview.existing ? "Already in this library. Opening it keeps the original captured version and its annotations." : "Confirm to save a local capture. Library backups and ordinary sync do not include its full text."}</p>
      <button className="ll-button" disabled={busy !== undefined} onClick={() => void save()}>{busy === "save" ? "Saving article…" : preview.existing ? "Open saved article" : "Save article"}</button>
    </section>}
  </div>;
}
