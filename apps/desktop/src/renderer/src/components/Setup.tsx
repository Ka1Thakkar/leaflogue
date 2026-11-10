import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Cloud, Database, HardDrive, Leaf } from "../components/icons";
import type { RemoteConfigurationSummary, RemoteDatabaseStatus, SystemCapabilities } from "@leaflogue/contracts";
import { useConfirm } from "./Confirm";
import styles from "./setup.module.css";
import { InlineError } from "./shared";
import { useAction } from "./useAction";

type StorageChoice = "local" | "postgres" | "convex";

export function FirstRunSetup({ capabilities, onComplete }: {
  readonly capabilities: SystemCapabilities;
  readonly onComplete: (capabilities: SystemCapabilities) => void;
}) {
  const [confirm, confirmDialog] = useConfirm();
  const [step, setStep] = useState(0);
  const [choice, setChoice] = useState<StorageChoice>("local");
  const [connection, setConnection] = useState("");
  const [summary, setSummary] = useState<RemoteConfigurationSummary>();
  const [status, setStatus] = useState<RemoteDatabaseStatus>();
  const { pending, setPending, error, setError, run } = useAction();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);
  useEffect(() => heading.current?.focus(), [step]);

  async function finish() {
    await run(async () => {
      onComplete(await window.leaflogue.system.completeSetup());
    }, "Leaflogue could not record setup completion. Your library and saved connection were not removed.");
  }

  async function saveRemote() {
    setPending(true);
    setError("");
    setStatus(undefined);
    try {
      const saved = await window.leaflogue.remote.save(choice === "postgres"
        ? { provider: "postgres", databaseUrl: connection, location: "default" }
        : { provider: "convex", deploymentUrl: connection, location: "default" });
      if (!saved) return;
      setSummary(saved);
      setConnection("");
      try { setStatus(await window.leaflogue.remote.check()); } catch { /* The saved redacted review remains useful offline. */ }
      setStep(3);
    } catch {
      setError("Leaflogue could not save or verify that connection. Check the URL and try again.");
    } finally {
      setPending(false);
    }
  }

  async function initializePostgresSchema() {
    if (!await confirm({ title: "Initialize schema?", message: "This creates Leaflogue’s versioned schema and tables in this PostgreSQL database.", confirmLabel: "Initialize schema" })) return;
    setPending(true);
    setError("");
    try { setStatus(await window.leaflogue.remote.initialize()); }
    catch { setError("Leaflogue could not initialize this database. No local reading data was changed."); }
    finally { setPending(false); }
  }

  return (
    <dialog ref={dialog} className={styles.wizard} aria-labelledby="setup-title" onCancel={(event) => event.preventDefault()}>
        <div className={styles.brand}><Leaf size={18} aria-hidden="true" />Leaflogue</div>
        <ol className={styles.progress} aria-label="Setup progress">
          {[0, 1, 2, 3].map((item) => <li key={item} aria-current={item === step ? "step" : undefined} className={item <= step ? styles.reached : undefined}><span>{item + 1}</span></li>)}
        </ol>
        <div className={styles.step} key={step}>
          {step === 0 && (
            <>
              <h1 id="setup-title" ref={heading} tabIndex={-1}>Your library starts on this computer.</h1>
              <p className={styles.lead}>Books, passages, and notes use a private SQLite file. Online sync is optional and can be configured now or later in Settings.</p>
              <dl className={styles.paths}>
                <div><dt>Config</dt><dd><code>{capabilities.storagePaths.configFile}</code></dd></div>
                <div><dt>Library</dt><dd><code>{capabilities.storagePaths.libraryFile}</code></dd></div>
                <div><dt>Cache</dt><dd><code>{capabilities.storagePaths.cacheDirectory}</code></dd></div>
                <div><dt>State</dt><dd><code>{capabilities.storagePaths.stateDirectory}</code></dd></div>
              </dl>
            </>
          )}
          {step === 1 && (
            <>
              <h1 id="setup-title" ref={heading} tabIndex={-1}>Would you like a remote library?</h1>
              <fieldset className={styles.choices}>
                <legend className="sr-only">Remote library choice</legend>
                <Choice icon={HardDrive} title="Local only" copy="Use SQLite on this computer. Add a remote later." value="local" selected={choice} onSelect={setChoice} />
                <Choice icon={Database} title="PostgreSQL" copy="Save a TLS database URL in protected config." value="postgres" selected={choice} onSelect={setChoice} />
                <Choice icon={Cloud} title="Convex" copy="Save a deployment URL; deploy schema through the Convex CLI." value="convex" selected={choice} onSelect={setChoice} />
              </fieldset>
            </>
          )}
          {step === 2 && (
            <>
              <h1 id="setup-title" ref={heading} tabIndex={-1}>Connect without exposing credentials.</h1>
              <p className={styles.lead}>{choice === "postgres"
                ? "Paste the connection URL once. Leaflogue writes it to the protected config shown earlier and never returns it to the interface."
                : "Paste the credential-free deployment URL now. Add the sync key in Settings before your first sync; backend deployment stays in the Convex CLI."}</p>
              <label className="ll-label">{choice === "postgres" ? "PostgreSQL connection URL" : "Convex deployment URL"}
                <input autoFocus className="ll-field" type={choice === "postgres" ? "password" : "url"} autoComplete="off" spellCheck={false} value={connection} onChange={(event) => setConnection(event.target.value)} placeholder={choice === "postgres" ? "postgresql://…" : "https://…convex.cloud"} />
              </label>
            </>
          )}
          {step === 3 && (
            <>
              <h1 id="setup-title" ref={heading} tabIndex={-1}>Ready for your library.</h1>
              <dl className={styles.review}>
                <div><dt>Local library</dt><dd>{capabilities.storagePaths.libraryFile}</dd></div>
                <div><dt>Remote sync</dt><dd>{choice === "local" ? "Not configured" : `${choice === "postgres" ? "PostgreSQL" : "Convex"} · ${summary?.host ?? "saved in protected config"}`}</dd></div>
                {status && <div><dt>Connection</dt><dd>{status.problem ?? (status.initialized ? `Schema ${status.schemaVersion} ready` : status.reachable ? "Connected; schema not initialized" : "Saved; currently offline")}</dd></div>}
              </dl>
              {choice === "postgres" && status?.reachable && !status.initialized && !status.problem && (
                <button type="button" className="ll-button-secondary" disabled={pending} onClick={() => void initializePostgresSchema()}>Initialize schema</button>
              )}
            </>
          )}
        </div>
        <InlineError>{error}</InlineError>
        <footer className={styles.actions}>
          {step > 0 && <button type="button" className="ll-button-secondary" disabled={pending} onClick={() => { setError(""); setStep((current) => current - 1); }}><ArrowLeft size={16} aria-hidden="true" />Back</button>}
          {step === 0 && <button type="button" className={styles.later} disabled={pending} onClick={() => void finish()}>Set up later</button>}
          <span />
          {step === 0 && <button type="button" className="ll-button" onClick={() => setStep(1)}>Continue<ArrowRight size={16} aria-hidden="true" /></button>}
          {step === 1 && <button type="button" className="ll-button" onClick={() => setStep(choice === "local" ? 3 : 2)}>Continue<ArrowRight size={16} aria-hidden="true" /></button>}
          {step === 2 && <button type="button" className="ll-button" disabled={pending || !connection.trim()} onClick={() => void saveRemote()}>{pending ? "Checking…" : "Save and check"}<ArrowRight size={16} aria-hidden="true" /></button>}
          {step === 3 && <button type="button" className="ll-button" disabled={pending} onClick={() => void finish()}>{pending ? "Finishing…" : "Open Leaflogue"}<Check size={16} aria-hidden="true" /></button>}
        </footer>
      {confirmDialog}
    </dialog>
  );
}

function Choice({ icon: Icon, title, copy, value, selected, onSelect }: {
  readonly icon: typeof HardDrive;
  readonly title: string;
  readonly copy: string;
  readonly value: StorageChoice;
  readonly selected: StorageChoice;
  readonly onSelect: (value: StorageChoice) => void;
}) {
  return <label className={styles.choice}><input type="radio" name="setup-storage" checked={selected === value} onChange={() => onSelect(value)} /><Icon size={20} aria-hidden="true" /><span><strong>{title}</strong><small>{copy}</small></span></label>;
}
