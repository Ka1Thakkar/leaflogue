import { useCallback, useEffect, useRef, useState } from "react";
import { StickyNote, Sun } from "../components/icons";
import { Icon } from "@leaflogue/ui";
import type { DailyHighlight as DailyHighlightRecord } from "@leaflogue/contracts";
import { href } from "../router";
import { PassageText } from "./shared";
import styles from "./knowledge.module.css";
import { useCommands } from "../palette/commands";

/** Something dug out and pinned up for today, inside the library. */
export function DailyHighlight() {
  const [timezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [daily, setDaily] = useState<DailyHighlightRecord | null>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(false);

  const request = useCallback(async (another = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    try {
      const result = await window.leaflogue.daily.ensure(another ? { timezone, another: true } : { timezone });
      if (mounted.current) setDaily(result ?? null);
    } catch {
      if (mounted.current) {
        setDaily((current) => current ?? null);
        setError("Today's highlight could not be chosen. Your library was not changed.");
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    }
  }, [timezone]);

  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout>;
    function refresh() {
      if (document.visibilityState === "visible") void request();
    }
    function schedule() {
      const now = new Date();
      const midnight = new Date(now);
      midnight.setHours(24, 0, 0, 0);
      timer = setTimeout(() => { refresh(); schedule(); }, midnight.getTime() - now.getTime() + 50);
    }
    refresh();
    schedule();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      mounted.current = false;
      clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [request]);

  useCommands(daily?.hasAlternatives ? [{ id: "daily.another", title: "Another passage for today's highlight", keywords: "daily shuffle random today", icon: "shuffle", run: () => void request(true) }] : []);
  const passage = daily?.passage;
  const noteId = passage ? `daily-note-${passage.highlightId}` : undefined;
  const revealed = !!passage && revealedId === passage.highlightId;
  const refreshLabel = `Refreshes daily at midnight in ${daily?.selection.timezone ?? timezone}`;
  return (
    <section className={`ui-panel ${styles.daily}`} aria-labelledby="daily-heading" aria-busy={pending}>
      <div className="ui-panel-head">
        <h2 id="daily-heading" className="ui-label">
          Today&apos;s highlight
          <span tabIndex={0} role="img" aria-label={refreshLabel} title={refreshLabel}><Sun size={13} strokeWidth={1.8} aria-hidden="true" /></span>
        </h2>
        {passage && (
          <div className={styles.actions}>
            {passage.notes.length > 0 && (
              <button className="ui-icon-btn" data-outline="" aria-label={revealed ? "Hide notes" : "Reveal notes"} title={revealed ? "Hide notes" : "Reveal notes"} aria-expanded={revealed} aria-controls={noteId} onClick={() => setRevealedId(revealed ? null : passage.highlightId)}>
                <StickyNote size={15} aria-hidden="true" />
              </button>
            )}
            {daily.hasAlternatives && (
              <button className="ui-icon-btn" data-outline="" aria-label="Another passage" title="Another passage" disabled={pending} onClick={() => void request(true)}>
                <Icon name="shuffle" size={15} />
              </button>
            )}
            <a className="ui-icon-btn" data-outline="" aria-label="Open book" title="Open book" href={href.book(passage.bookId, passage.highlightId)}>
              <Icon name="open" size={15} />
            </a>
          </div>
        )}
      </div>
      <div className={styles.dailyBody}>
        {passage ? (
          <>
            <blockquote className={styles.quote} key={passage.highlightId}><PassageText text={passage.text} /></blockquote>
            <a className={styles.dailySource} href={href.book(passage.bookId, passage.highlightId)}>{passage.bookTitle}</a>
            {passage.notes.length > 0 && (
              <div id={noteId} hidden={!revealed} className={styles.dailyNotes}>
                {passage.notes.map((note) => <PassageText key={note.id} text={note.markdown} note generated={note.origin === "ai"} />)}
              </div>
            )}
          </>
        ) : (
          !error && <p className="ll-muted" role="status">{daily === null && !pending ? "No passage is available to revisit yet." : "Preparing today's passage…"}</p>
        )}
        {error && (
          <div role="alert">
            <p className="ll-inline-error">{error}</p>
            <button className="ll-text-button" disabled={pending} onClick={() => void request()}>Try again</button>
          </div>
        )}
      </div>
    </section>
  );
}
