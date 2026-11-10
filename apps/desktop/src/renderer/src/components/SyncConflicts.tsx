import { useCallback, useEffect, useState } from "react";
import type { SyncConflict, SyncConflictPage } from "@leaflogue/contracts";
import { useConfirm } from "./Confirm";
import { Empty, InlineError, Loading, PageHeader } from "./shared";

function Body({ title, text, missing = "" }: { readonly title: string; readonly text?: string; readonly missing?: string }) {
  return (
    <section className="ll-conflict-version">
      <h3>{title}</h3>
      {text === undefined ? <p className="ll-muted">{missing}</p> : <blockquote>{text}</blockquote>}
    </section>
  );
}

function consequence(conflict: SyncConflict): string {
  const noun = conflict.kind === "note" ? "note" : "passage";
  if (conflict.restore === "copy") return `Restoring adds this version as a new ${noun}. The version already in your library stays untouched.`;
  return conflict.bookTitle === undefined
    ? `Its book is no longer in your library, so this ${noun} cannot be restored. You can still select and copy the text.`
    : `Its book is archived. Restore the book from the archive shelf to bring this ${noun} back, or copy the text.`;
}

function Review({ conflict, onResolved }: { readonly conflict: SyncConflict; readonly onResolved: () => Promise<void> }) {
  const [confirm, confirmDialog] = useConfirm();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const noun = conflict.kind === "note" ? "note" : "passage";
  async function choose(resolution: "restore" | "discard") {
    if (pending) return;
    if (resolution === "discard" && !await confirm({
      title: `Discard this ${noun}?`,
      message: `This version of the ${noun} is kept nowhere else and cannot be recovered.`,
      confirmLabel: "Discard version",
      destructive: true,
    })) return;
    setPending(true);
    setError("");
    try {
      await window.leaflogue.sync.resolveConflict({ id: conflict.id, resolution, expectedRevision: conflict.currentRevision });
    } catch {
      setError(`This ${noun} changed while you were reviewing it. The comparison has been refreshed; check it again.`);
      setPending(false);
    }
    // Refreshing replaces a resolved review and re-reads a stale one.
    await onResolved();
  }
  return (
    <article>
      <div className="ll-conflict-heading">
        <div>
          <h2>{conflict.bookTitle ?? "A book no longer in your library"}</h2>
          <p className="ll-muted">
            {conflict.kind === "note" ? "Note" : "Passage"} {conflict.preservedOnThisDevice ? "written on this device" : "written on another device"}
          </p>
        </div>
        <button className="ll-button-secondary" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Close review" : "Compare versions"}</button>
      </div>
      {open && (
        <>
          {conflict.passageText !== undefined && <Body title="On the passage" text={conflict.passageText} />}
          <div className="ll-conflict-versions">
            <Body title="In your library now" text={conflict.currentBody} missing={`This ${noun} was deleted.`} />
            <Body title="Version that was not kept" text={conflict.preservedBody} />
          </div>
          <p className="ll-muted ll-conflict-note">{consequence(conflict)}</p>
          <div className="ll-conflict-actions">
            <button className="ll-button-secondary" disabled={pending} onClick={() => void choose("discard")}>Discard this version</button>
            {conflict.restore !== "unavailable" && (
              <button className="ll-button" disabled={pending} onClick={() => void choose("restore")}>{pending ? "Saving…" : "Restore this version"}</button>
            )}
          </div>
        </>
      )}
      <InlineError>{error}</InlineError>
      {confirmDialog}
    </article>
  );
}

export function SyncConflictsPage({ onChanged }: { readonly onChanged?: () => void }) {
  const [page, setPage] = useState<SyncConflictPage>();
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setPage(await window.leaflogue.sync.listConflicts());
      setError("");
    } catch {
      setPage((current) => current ?? { conflicts: [], total: 0 });
      setError("Leaflogue could not load synced changes.");
    }
  }, []);
  const refresh = useCallback(async () => {
    await load();
    onChanged?.();
  }, [load, onChanged]);
  useEffect(() => { void load(); }, [load]);
  return (
    <>
      <PageHeader
        title="Review synced changes"
        subtitle={!!page?.total && "Changed on two devices. One version is in your library; the other is kept here until you choose."}
      />
      <InlineError>{error}</InlineError>
      {page === undefined ? (
        <Loading>Loading changes…</Loading>
      ) : page.conflicts.length === 0 && !error ? (
        <Empty title="No synced changes need review." />
      ) : (
        <>
          <div className="ll-conflicts">
            {page.conflicts.map((conflict) => <Review key={conflict.id} conflict={conflict} onResolved={refresh} />)}
          </div>
          {page.total > page.conflicts.length && (
            <p className="ll-muted ll-conflict-note">Showing the newest {page.conflicts.length} of {page.total}. More appear as you resolve these.</p>
          )}
        </>
      )}
    </>
  );
}
