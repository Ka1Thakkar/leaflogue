import { useState } from "react";
import { Pencil, Trash2 } from "../components/icons";
import type { BookId, HighlightId, HighlightListEntry, Note } from "@leaflogue/contracts";
import { useConfirm } from "./Confirm";
import { InlineError, PassageText } from "./shared";
import styles from "./knowledge.module.css";

export function HighlightForm({
  bookId,
  highlight,
  onClose,
  onSaved,
}: {
  readonly bookId: BookId;
  readonly highlight?: HighlightListEntry;
  readonly onClose: () => void;
  readonly onSaved: () => Promise<void> | void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [committed, setCommitted] = useState(false);
  return (
    <form
      className={styles.form}
      onSubmit={async (event) => {
        event.preventDefault();
        if (pending || committed) return;
        const form = new FormData(event.currentTarget);
        const text = String(form.get("text") ?? "");
        const note = String(form.get("note") ?? "").trim();
        setPending(true);
        setError("");
        try {
          if (highlight) {
            await window.leaflogue.library.updateHighlight({
              id: highlight.id,
              bookId,
              text,
              ...(highlight.sourceLocation ? { sourceLocation: highlight.sourceLocation } : {}),
              expectedRevision: highlight.revision,
            });
          } else {
            await window.leaflogue.library.createHighlight({
              bookId,
              text,
              ...(note ? { noteMarkdown: note } : {}),
            });
          }
        } catch {
          setError(highlight
            ? "This passage changed before it could be saved. Close this form and try again."
            : "The passage could not be saved. Check its text, then try again.");
          setPending(false);
          return;
        }
        window.dispatchEvent(new Event("leaflogue:annotations-changed"));
        setCommitted(true);
        try {
          await onSaved();
          onClose();
        } catch {
          setError("The passage was saved, but this view could not refresh. Close and reopen it to see the committed change.");
        } finally {
          setPending(false);
        }
      }}
    >
      <fieldset disabled={pending} className={styles.fields}>
        <label className="ll-label">
          Quote
          <textarea autoFocus className="ll-field font-reader" name="text" rows={7} required maxLength={100_000} defaultValue={highlight?.text} />
        </label>
        {!highlight && (
          <label className="ll-label">
            Note
            <textarea className="ll-field" name="note" rows={4} maxLength={100_000} placeholder="What would you like to remember?" />
          </label>
        )}
      </fieldset>
      <InlineError>{error}</InlineError>
      <div className={styles.actions}>
        <button className="ll-button" disabled={pending || committed}>{pending ? "Saving…" : committed ? "Saved" : highlight ? "Save changes" : "Add highlight"}</button>
        <button type="button" className="ll-button-secondary" disabled={pending} onClick={onClose}>{committed ? "Close" : "Cancel"}</button>
      </div>
    </form>
  );
}

export function NoteForm({
  bookId,
  highlightId,
  note,
  onClose,
  onSaved,
}: {
  readonly bookId: BookId;
  readonly highlightId?: HighlightId;
  readonly note?: Note;
  readonly onClose: () => void;
  readonly onSaved: () => Promise<void> | void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [committed, setCommitted] = useState(false);
  return (
    <form
      className={styles.form}
      onSubmit={async (event) => {
        event.preventDefault();
        if (pending || committed) return;
        const markdown = String(new FormData(event.currentTarget).get("text") ?? "");
        setPending(true);
        setError("");
        try {
          if (note) await window.leaflogue.library.updateNote({ id: note.id, bookId, markdown, expectedRevision: note.revision });
          else await window.leaflogue.library.createNote({ bookId, ...(highlightId ? { highlightId } : {}), markdown });
        } catch {
          setError(note
            ? "This note changed before it could be saved. Close this form and try again."
            : "The note could not be saved. Check its text, then try again.");
          setPending(false);
          return;
        }
        window.dispatchEvent(new Event("leaflogue:annotations-changed"));
        setCommitted(true);
        try {
          await onSaved();
          onClose();
        } catch {
          setError("The note was saved, but this view could not refresh. Close and reopen it to see the committed change.");
        } finally {
          setPending(false);
        }
      }}
    >
      <label className="ll-label">
        Your note
        <textarea autoFocus required className="ll-field" name="text" rows={5} maxLength={100_000} defaultValue={note?.markdown} placeholder="What would you like to remember?" />
      </label>
      <InlineError>{error}</InlineError>
      <div className={styles.actions}>
        <button className="ll-button" disabled={pending || committed}>{pending ? "Saving…" : committed ? "Saved" : note ? "Save note" : "Add note"}</button>
        <button type="button" className="ll-button-secondary" disabled={pending} onClick={onClose}>{committed ? "Close" : "Cancel"}</button>
      </div>
    </form>
  );
}

export function NoteCard({ note, readOnly, onSaved }: { readonly note: Note; readonly readOnly: boolean; readonly onSaved: () => Promise<void> | void }) {
  const [confirm, confirmDialog] = useConfirm();
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [deleted, setDeleted] = useState(false);
  if (editing) {
    return (
      <div className={styles.localNoteEditor}>
        <NoteForm bookId={note.bookId} note={note} onClose={() => setEditing(false)} onSaved={onSaved} />
      </div>
    );
  }
  return (
    <aside className={styles.localNoteRecord} aria-label={note.origin === "import" ? "Imported note" : "Your note"}>
      <PassageText text={note.markdown} note generated={note.origin === "ai"} />
      {!readOnly && !deleted && (
        <div className={styles.localNoteActions}>
          <button className="ll-icon-button" aria-label="Edit note" title="Edit note" disabled={pending} onClick={() => setEditing(true)}>
            <Pencil size={16} aria-hidden="true" />
          </button>
          <button
            className="ll-icon-button ll-danger"
            aria-label="Delete note"
            title="Delete note"
            disabled={pending}
            onClick={async () => {
              if (!await confirm({ title: "Delete note?", message: "This cannot be undone.", confirmLabel: "Delete note", destructive: true })) return;
              setPending(true);
              setError("");
              try {
                await window.leaflogue.library.deleteNote({ id: note.id, bookId: note.bookId, expectedRevision: note.revision });
              } catch {
                setError("This note changed before it could be deleted. Reload and try again.");
                setPending(false);
                return;
              }
              setDeleted(true);
              try {
                await onSaved();
              } catch {
                setError("The note was deleted, but this view could not refresh. Reopen the book to update it.");
              } finally {
                setPending(false);
              }
            }}
          >
            <Trash2 size={16} aria-hidden="true" />
          </button>
        </div>
      )}
      {deleted && !error && <p role="status" className="ll-muted">Note deleted.</p>}
      <InlineError>{error}</InlineError>
      {confirmDialog}
    </aside>
  );
}
