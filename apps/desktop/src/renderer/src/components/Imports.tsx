
import { Select, SelectItem } from "@leaflogue/ui";
import { useCallback, useEffect, useState } from "react";
import { Bell, Check, CheckCheck, CircleAlert, Download, FolderOpen, History, Usb, X } from "../components/icons";
import { Panel, StatTile, TitleRow } from "@leaflogue/ui";
import type { ConnectedReader, ImportAnnotation, ImportConflict, ImportReceipt, PendingImport } from "@leaflogue/contracts";
import { useDesktop } from "../host";
import { href } from "../router";
import { importRequests } from "../palette/actions";
import { countOf, Empty, ImportTrigger, InlineError, Loading, PageHeader } from "./shared";
import sheet from "./import.module.css";

/** Every reader Leaflogue reads, what to choose for it, and where that lives. */
/** `web` is what to choose instead in the web app, which cannot open a folder. */
const SOURCES: readonly { readonly name: string; readonly file: string; readonly where: string; readonly folder?: boolean; readonly web?: { readonly file: string; readonly where: string } }[] = [
  { name: "Kobo", file: "KoboReader.sqlite", where: "In the reader's hidden .kobo folder" },
  { name: "Kindle", file: "My Clippings.txt", where: "In the documents folder on the Kindle" },
  { name: "KOReader", file: "The reader's drive", where: "Or your books folder; every book is found", folder: true, web: { file: "metadata.*.lua", where: "In each book's .sdr folder; choose them all at once" } },
  { name: "PocketBook or Vivlio", file: "books.db", where: "In system/config on the reader" },
  { name: "Tolino", file: "notes.txt", where: "At the top of the reader's drive" },
  { name: "Boox", file: "Exported highlights", where: "Export from NeoReader, then choose the .txt or its folder", folder: true, web: { file: "Exported highlights", where: "Export from NeoReader, then choose every .txt at once" } },
  { name: "Leaflogue", file: "Library JSON", where: "An export from another Leaflogue library" },
];

/** One import run during this session, kept for the notification list. */
export interface ImportRecord {
  readonly id: string;
  readonly fileName: string;
  readonly sourceName: string;
  readonly finishedAt: number;
  readonly receipt?: ImportReceipt;
  readonly failed?: boolean;
}

const PROVIDERS: Record<PendingImport["provider"], { readonly file: string; readonly placeholder: string }> = {
  kobo: { file: "Kobo database", placeholder: "My Kobo Clara" },
  kindle: { file: "Kindle My Clippings.txt", placeholder: "My Kindle" },
  koreader: { file: "KOReader highlights", placeholder: "KOReader on my Kobo" },
  pocketbook: { file: "PocketBook library", placeholder: "My PocketBook" },
  tolino: { file: "Tolino notes.txt", placeholder: "My Tolino" },
  boox: { file: "Boox highlights export", placeholder: "My Boox" },
  portable: { file: "Portable JSON", placeholder: "Reading export" },
};

/** What a plugged-in reader is called in the import dialog. */
const READER_NAMES: Record<ConnectedReader["kind"], string> = {
  kobo: "Kobo",
  kindle: "Kindle",
  koreader: "KOReader",
  pocketbook: "PocketBook",
  tolino: "Tolino",
  boox: "Boox",
};

function providerLabel(provider: PendingImport["provider"]): string {
  return PROVIDERS[provider].file;
}

export function receiptSummary(receipt: ImportReceipt): string {
  const added = receipt.highlightsCreated + receipt.notesCreated;
  return `${added.toLocaleString()} added, ${receipt.annotationsUpdated.toLocaleString()} updated${receipt.booksCreated ? `, ${receipt.booksCreated.toLocaleString()} new ${receipt.booksCreated === 1 ? "book" : "books"}` : ""}`;
}

export function ImportTool({ history, onImported }: {
  readonly history: readonly ImportRecord[];
  readonly onImported: (record: ImportRecord) => void;
}) {
  const [pending, setPending] = useState<PendingImport>();
  const [sourceId, setSourceId] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<ImportReceipt>();
  const [readers, setReaders] = useState<readonly ConnectedReader[]>([]);
  const desktop = useDesktop();

  // Offer a plugged-in Kobo or Kindle directly, so no file has to be found.
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    window.leaflogue.imports.listReaders().then((found) => { if (active) setReaders(found); }, () => undefined);
    const stop = window.leaflogue.imports.onReadersChanged(setReaders);
    return () => { active = false; stop(); };
  }, [desktop]);

  // The palette's "Import from your Kobo" or "Import from a file" starts here.
  importRequests.useReceiver((request) => void choose(request.kind === "file" ? "file" : request.reader));

  async function choose(from: ConnectedReader | "file" | "folder") {
    setBusy(true);
    setError("");
    setReceipt(undefined);
    setStage(from === "file" ? (desktop ? "Reading the file on this computer…" : "Reading the file…") : from === "folder" ? "Looking for highlights in that folder…" : `Reading your ${READER_NAMES[from.kind]}…`);
    try {
      const next = from === "file"
        ? await window.leaflogue.imports.chooseFile()
        : from === "folder"
          ? await window.leaflogue.imports.chooseFolder()
          : await window.leaflogue.imports.chooseReader(from.id);
      if (next) {
        setPending(next);
        setSourceId(next.suggestedSourceId ?? "");
        setSourceName(next.suggestedSourceName);
        setStage("");
      } else {
        setStage("");
      }
    } catch {
      setStage("");
      setError(from === "folder"
        ? "Leaflogue found no KOReader or Boox highlights in that folder. Choose the reader's drive, your books folder, or the folder of Boox exports."
        : "Leaflogue could not read that file. Check that it is one of the files listed under \u201cWhere to find your highlights\u201d.");
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!pending) return;
    const creating = !sourceId;
    setBusy(true);
    setError("");
    // The desktop saves an import all at once; the web app sends it in batches.
    setStage(desktop ? "Saving books and annotations in one transaction…" : "Saving books and annotations…");
    const chosenProfile = pending.sourceProfiles.find((profile) => profile.id === sourceId);
    try {
      const result = await window.leaflogue.imports.commit({
        token: pending.token,
        sourceId: creating ? pending.newSourceId : sourceId,
        ...(creating ? { newSourceName: sourceName.trim() } : {}),
      });
      setReceipt(result);
      setStage("");
      onImported({ id: crypto.randomUUID(), fileName: pending.fileName, sourceName: creating ? sourceName.trim() : chosenProfile?.name ?? "", finishedAt: Date.now(), receipt: result });
      setPending(undefined);
    } catch {
      setStage("");
      setError(desktop
        ? "The import was not saved. Your existing library was not changed."
        : "The import stopped before it finished. Anything already saved stays; import the same file again to finish.");
      onImported({ id: crypto.randomUUID(), fileName: pending.fileName, sourceName: creating ? sourceName.trim() : chosenProfile?.name ?? "", finishedAt: Date.now(), failed: true });
    } finally {
      setBusy(false);
    }
  }

  const books = pending?.preview.document.books ?? [];
  const annotations = pending?.preview.document.annotations ?? [];
  const passages = annotations.filter(({ text }) => text !== undefined).length;
  const notes = annotations.filter(({ note }) => note !== undefined).length;
  const dated = annotations.filter(({ createdAt }) => createdAt !== undefined).length;
  const perBook = new Map<string, { passages: number; notes: number }>();
  for (const annotation of annotations) {
    const entry = perBook.get(annotation.bookProviderRecordId) ?? { passages: 0, notes: 0 };
    if (annotation.text !== undefined) entry.passages += 1;
    if (annotation.note !== undefined) entry.notes += 1;
    perBook.set(annotation.bookProviderRecordId, entry);
  }
  const rows = [...books].sort((a, b) => (perBook.get(b.providerRecordId)?.passages ?? 0) - (perBook.get(a.providerRecordId)?.passages ?? 0));
  return (
    <div className={sheet.page}>
      <TitleRow title="Import" meta={desktop ? "Bring highlights and notes in from your e-reader. Files are read on this computer and never changed." : "Bring highlights and notes in from your e-reader. Files are read in this browser and never changed."} />
      <form className={sheet.form} onSubmit={(event) => { event.preventDefault(); void commit(); }}>
        <fieldset disabled={busy} className={sheet.fieldset}>
          <legend className="sr-only">Import</legend>
          <Panel title="1 · Choose your reader">
            {readers.length > 0 && (
              <ul className={sheet.connected} aria-label="Connected readers">
                {readers.map((reader) => (
                  <li key={reader.id}>
                    <Usb size={16} aria-hidden="true" />
                    <span>{reader.kind === "koreader" ? <>KOReader highlights are on <strong>{reader.label}</strong>.</> : <>Your {READER_NAMES[reader.kind]} <strong>{reader.label}</strong> is plugged in.</>}</span>
                    <button type="button" className="ll-button" onClick={() => void choose(reader)}>
                      Import from {READER_NAMES[reader.kind]}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <ul className={sheet.sources} aria-label="Where to find your highlights">
              {SOURCES.map((source) => (
                <li key={source.name} data-current={pending && providerLabel(pending.provider).toLocaleLowerCase().includes(source.name.split(" ")[0]!.toLocaleLowerCase()) ? "" : undefined}>
                  <strong>{source.name}</strong>
                  <code>{(!desktop && source.web?.file) || source.file}</code>
                  <span className="ui-sub">{(!desktop && source.web?.where) || source.where}</span>
                </li>
              ))}
            </ul>
            <div className={sheet.choose}>
              <button type="button" className={pending ? "ll-button-secondary" : "ll-button"} onClick={() => void choose("file")}>
                <FolderOpen size={15} aria-hidden="true" />{pending ? "Choose a different file" : "Choose file"}
              </button>
              {desktop ? (
                <>
                  <button type="button" className="ll-button-secondary" onClick={() => void choose("folder")}>Choose folder</button>
                  <span className="ui-sub">A folder is for KOReader or a set of Boox exports.</span>
                </>
              ) : <span className="ui-sub">For KOReader or Boox exports, choose all their files at once.</span>}
            </div>
          </Panel>

          {pending && (
            <>
              <div className={sheet.tiles}>
                <StatTile label="Books in this file" value={books.length.toLocaleString()} />
                <StatTile label="Passages" tone="chart" value={passages.toLocaleString()} />
                <StatTile label="Notes" tone="mark" value={notes.toLocaleString()} />
                <StatTile label="With a highlight date" tone="good" value={`${dated.toLocaleString()}`} sub={`of ${countOf(annotations.length, "annotation")}`} />
              </div>
              <Panel title={<h2 className="ui-label">2 · Check what is in it <span className={sheet.caption}>{pending.fileName} ({providerLabel(pending.provider)}) · nothing is saved until you import</span></h2>}>
                <table className={sheet.table}>
                  <caption className="sr-only">Books in this file</caption>
                  <thead>
                    <tr><th scope="col" className="ui-label">Book</th><th scope="col" className="ui-label">Passages</th><th scope="col" className="ui-label">Notes</th></tr>
                  </thead>
                  <tbody>
                    {rows.map((book) => (
                      <tr key={book.providerRecordId}>
                        <th scope="row"><span>{book.title}</span><small className="ui-sub">{book.authors.join(", ") || "Author unknown"}</small></th>
                        <td className="ui-number">{(perBook.get(book.providerRecordId)?.passages ?? 0).toLocaleString()}</td>
                        <td className="ui-number">{(perBook.get(book.providerRecordId)?.notes ?? 0).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {pending.preview.warnings.length > 0 && (
                  <ul className={sheet.warnings}>
                    {pending.preview.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}>{warning.message}</li>)}
                  </ul>
                )}
                <div className={sheet.source}>
                  <div>
                    <label className="ll-label" htmlFor="import-source">Import source</label>
                    <Select id="import-source" className="ll-field" value={sourceId} onValueChange={(value) => setSourceId(value)} aria-describedby="source-help">
                      <SelectItem value="">Create a new source</SelectItem>
                      {pending.sourceProfiles.map((profile) => (
                        <SelectItem key={profile.id} value={profile.id}>{profile.name}{profile.id === pending.suggestedSourceId ? " (used for this file before)" : ""}</SelectItem>
                      ))}
                    </Select>
                  </div>
                  {!sourceId && (
                    <div>
                      <label className="ll-label" htmlFor="import-source-name">Name this source</label>
                      <input
                        id="import-source-name"
                        className="ll-field"
                        value={sourceName}
                        onChange={(event) => setSourceName(event.target.value)}
                        placeholder={PROVIDERS[pending.provider].placeholder}
                        maxLength={200}
                        required
                      />
                    </div>
                  )}
                  <p id="source-help" className="ui-sub">Reuse a source to update what you imported before instead of duplicating it.</p>
                </div>
                <div className={sheet.footer}>
                  <span className="ui-sub">Edits you made here are always kept. Anything that changed in both places waits for you to review.</span>
                  <button type="button" className="ll-button-secondary" disabled={busy} onClick={() => { setPending(undefined); setError(""); }}>Cancel import</button>
                  <button type="submit" className="ll-button" disabled={busy || (!sourceId && !sourceName.trim())}>Import highlights and notes</button>
                </div>
              </Panel>
            </>
          )}
        </fieldset>
        <InlineError>{error}</InlineError>
        <div role="status" aria-live="polite" className={sheet.status}>
          {stage && <p>{stage}</p>}
          {busy && stage && <progress aria-label="Import progress" />}
          {receipt && (
            <>
              <p>Import complete: {receiptSummary(receipt)}.</p>
              <div className={sheet.tiles}>
                <StatTile label="New passages and notes" tone="chart" value={(receipt.highlightsCreated + receipt.notesCreated).toLocaleString()} />
                <StatTile label="Updated" value={receipt.annotationsUpdated.toLocaleString()} />
                <StatTile label="New books" tone="good" value={receipt.booksCreated.toLocaleString()} sub={`${receipt.booksReused.toLocaleString()} already here`} />
                <StatTile label="Need review" tone="mark" value={receipt.conflictsCreated.toLocaleString()} sub={receipt.conflictsCreated > 0 ? "edited here and on the reader" : "nothing to review"} />
              </div>
              {receipt.conflictsCreated > 0 && <p><a className="ll-text-link" href={href.conflicts()}>{receipt.conflictsCreated} conflicting {receipt.conflictsCreated === 1 ? "version" : "versions"} saved for review</a></p>}
            </>
          )}
        </div>
      </form>
      <Panel title="Import history" actions={<a className="ui-sub" href={href.conflicts()}>Review import conflicts</a>}>
        {history.length === 0 ? (
          <p className={`ui-sub ${sheet.historyEmpty}`}>{desktop ? "No imports on this computer since Leaflogue opened." : "No imports since Leaflogue opened."}</p>
        ) : (
          <ul className={sheet.history}>
            {history.map((record) => (
              <li key={record.id}>
                <div><strong>{record.fileName}</strong><span className="ui-chip" data-tone={record.failed ? "danger" : "accent"}>{record.failed ? "Failed" : "Completed"}</span></div>
                <p className="ui-sub">{new Date(record.finishedAt).toLocaleString()}{record.sourceName ? ` · ${record.sourceName}` : ""}</p>
                {record.receipt && <p>{receiptSummary(record.receipt)}</p>}
                {!!record.receipt?.conflictsCreated && (
                  <p><a className="ll-text-link" href={href.conflicts()}>{record.receipt.conflictsCreated} conflicting {record.receipt.conflictsCreated === 1 ? "version" : "versions"} saved for review</a></p>
                )}
                {record.failed && <p className="ll-inline-error">{desktop ? "The import was rolled back. Your library was not changed." : "The import stopped before it finished. Import the same file again to finish."}</p>}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

export function ImportNotifications({ history, syncConflicts = 0, updateVersion, onDismiss, onOpenImport }: {
  readonly history: readonly ImportRecord[];
  /** Preserved sync versions awaiting review; they stay listed until resolved. */
  readonly syncConflicts?: number;
  /** A verified newer version an automatic check found. */
  readonly updateVersion?: string;
  readonly onDismiss: (id?: string) => void;
  readonly onOpenImport: () => void;
}) {
  return (
    <details className="ll-notifications">
      <summary
        className="ll-icon-button"
        aria-label={syncConflicts || updateVersion
          ? `Notifications, ${[syncConflicts ? syncReviewLabel(syncConflicts) : "", updateVersion ? `Leaflogue ${updateVersion} is available` : ""].filter(Boolean).join(", ")}`
          : "Import notifications"}
        title="Import notifications"
      >
        <Bell size={18} strokeWidth={1.6} aria-hidden="true" />
        {(syncConflicts > 0 || updateVersion) && <span className="ll-notification-count" aria-hidden="true">{syncConflicts + (updateVersion ? 1 : 0)}</span>}
      </summary>
      <section className="ll-popover" aria-label="Import notifications">
        <div className="ll-popover-heading">
          <h2>Notifications</h2>
          <div>
            {history.length > 0 && <button type="button" className="ll-icon-button" aria-label="Clear finished notifications" title="Clear finished notifications" onClick={() => onDismiss()}><CheckCheck size={18} aria-hidden="true" /></button>}
            <button type="button" className="ll-icon-button" title="Close notifications" aria-label="Close notifications" onClick={(event) => event.currentTarget.closest("details")?.removeAttribute("open")}><X size={18} aria-hidden="true" /></button>
          </div>
        </div>
        {syncConflicts > 0 && (
          <p className="ll-popover-alert">
            <CircleAlert size={16} className="ll-status-alert" aria-hidden="true" />
            <a className="ll-text-link" href={href.syncConflicts()}>{syncReviewLabel(syncConflicts)}</a>
          </p>
        )}
        {updateVersion && (
          <p className="ll-popover-alert">
            <Download size={16} aria-hidden="true" />
            <a className="ll-text-link" href={href.settings()}>Leaflogue {updateVersion} is available</a>
          </p>
        )}
        {history.length === 0 ? (
          syncConflicts === 0 && !updateVersion && <p className="ll-muted">All caught up.</p>
        ) : (
          <ul>
            {history.slice(0, 10).map((record) => (
              <li key={record.id}>
                <div>
                  {record.failed ? <CircleAlert size={16} className="ll-status-alert" aria-hidden="true" /> : <Check size={16} className="ll-status-ok" aria-hidden="true" />}
                  <p>{record.fileName}</p>
                  <button type="button" className="ll-icon-button" aria-label={`Dismiss ${record.fileName}`} title="Dismiss notification" onClick={() => onDismiss(record.id)}><X size={16} aria-hidden="true" /></button>
                </div>
                <p className="ll-muted">{record.receipt ? receiptSummary(record.receipt) : "Import needs attention"}</p>
              </li>
            ))}
          </ul>
        )}
        <div className="ll-popover-footer">
          <button
            type="button"
            className="ll-text-button"
            onClick={(event) => {
              event.currentTarget.closest("details")?.removeAttribute("open");
              onOpenImport();
            }}
          >
            <History size={16} aria-hidden="true" />Import history
          </button>
        </div>
      </section>
    </details>
  );
}

function syncReviewLabel(count: number): string {
  return `${count} synced ${count === 1 ? "version" : "versions"} to review`;
}

function Version({ title, data }: { readonly title: string; readonly data: ImportAnnotation }) {
  return (
    <section className="ll-conflict-version">
      <h3>{title}</h3>
      <blockquote>{data.text || "No quote text"}</blockquote>
      {data.location && <p className="ll-muted ll-conflict-note">{data.location}</p>}
      {data.note && (
        <div>
          <p className="ll-muted">Note</p>
          <p>{data.note}</p>
        </div>
      )}
    </section>
  );
}

function Review({ conflict, onResolved }: { readonly conflict: ImportConflict; readonly onResolved: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function choose(resolution: "keep-local" | "use-incoming") {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await window.leaflogue.imports.resolveConflict({ id: conflict.id, resolution });
      await onResolved();
    } catch {
      setError("This review could not be saved. The source may have changed; reopen the review and check the current version.");
      setPending(false);
    }
  }
  return (
    <article>
      <div className="ll-conflict-heading">
        <div>
          <h2>{conflict.bookTitle}</h2>
          <p className="ll-muted">{conflict.kind === "note" ? "Note" : "Highlight"} from {conflict.sourceName}</p>
        </div>
        <button className="ll-button-secondary" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Close review" : "Compare versions"}</button>
      </div>
      {open && (
        <>
          <Version title="Your current version" data={conflict.local} />
          <div className="ll-conflict-versions">
            <Version title="Previously accepted source" data={conflict.base} />
            <Version title="Incoming source version" data={conflict.incoming} />
          </div>
          <p className="ll-muted ll-conflict-note">
            Keeping your version remembers the new source state but preserves your edit. Accepting the incoming version
            replaces this imported {conflict.kind} only. Nothing else is changed.
          </p>
          <div className="ll-conflict-actions">
            <button className="ll-button-secondary" disabled={pending} onClick={() => void choose("keep-local")}>Keep my version</button>
            <button className="ll-button" disabled={pending} onClick={() => void choose("use-incoming")}>{pending ? "Saving…" : "Accept incoming source"}</button>
          </div>
        </>
      )}
      <InlineError>{error}</InlineError>
    </article>
  );
}

export function ConflictsPage() {
  const [conflicts, setConflicts] = useState<readonly ImportConflict[]>();
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setConflicts(await window.leaflogue.imports.listConflicts());
    } catch {
      setConflicts((current) => current ?? []);
      setError("Leaflogue could not load import conflicts.");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return (
    <>
      <PageHeader
        title="Review import changes"
        subtitle="Edited here and changed in the source. Both versions are kept until you choose."
        actions={<ImportTrigger className="ll-button-secondary">Open imports</ImportTrigger>}
      />
      <InlineError>{error}</InlineError>
      {conflicts === undefined ? (
        <Loading>Loading changes…</Loading>
      ) : conflicts.length === 0 && !error ? (
        <Empty title="No import conflicts need review." />
      ) : (
        <div className="ll-conflicts">
          {conflicts.map((conflict) => <Review key={conflict.id} conflict={conflict} onResolved={load} />)}
        </div>
      )}
    </>
  );
}
