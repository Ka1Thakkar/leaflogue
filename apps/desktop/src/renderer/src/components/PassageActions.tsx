import { createContext, useContext, useEffect, useRef, useState, type FormEvent } from "react";
import type { AiTaskDisclosure, HighlightId, HighlightListEntry, HighlightSource, Tag, Thread, ThreadId } from "@leaflogue/contracts";
import { ArrowRight, Check, Sparkles, StickyNote } from "./icons";
import { href } from "../router";
import { MarkdownText } from "./MarkdownText";
import { useConfirm } from "./Confirm";
import { InlineError, Loading, PassageText, SearchableMultiSelect } from "./shared";
import styles from "./knowledge.module.css";

export interface PassageContext {
  readonly tags: readonly Tag[];
  readonly reload: () => Promise<void>;
  readonly readOnly: boolean;
  /** Passages offer no AI action at all while AI is switched off. */
  readonly aiEnabled: boolean;
  /** The passage the reader last focused or a link opened: the palette's "this passage". */
  readonly activeId?: HighlightId;
  readonly setActiveId?: (id: HighlightId) => void;
}

export const PassageContext = createContext<PassageContext>({ tags: [], reload: async () => undefined, readOnly: false, aiEnabled: false });

export function HighlightTags({ highlight, onClose }: { readonly highlight: HighlightListEntry; readonly onClose: () => void }) {
  const { tags, reload } = useContext(PassageContext);
  return (
    <div className={styles.tagPicker}>
      <SearchableMultiSelect
        label="Tags"
        options={tags.map((tag) => ({ id: tag.id, label: tag.name }))}
        selected={highlight.tagIds}
        emptyText="Create tags from the library page, then assign them here."
        onChange={async (next) => {
          const current = new Set(highlight.tagIds);
          const wanted = new Set(next);
          try {
            for (const tag of tags) {
              if (current.has(tag.id) === wanted.has(tag.id)) continue;
              await window.leaflogue.organization.setHighlightTag({ bookId: highlight.bookId, highlightId: highlight.id, tagId: tag.id, included: wanted.has(tag.id) });
            }
          } finally {
            await reload();
          }
        }}
      />
      <button className="ll-button-secondary" onClick={onClose}>Done</button>
    </div>
  );
}

export function HighlightThreads({ highlight, onClose }: { readonly highlight: HighlightListEntry; readonly onClose: () => void }) {
  const { reload } = useContext(PassageContext);
  const [threads, setThreads] = useState<readonly Thread[]>();
  const [memberships, setMemberships] = useState<readonly ThreadId[]>();
  const revision = useRef(highlight.revision);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void Promise.all([
      window.leaflogue.threads.list(),
      window.leaflogue.threads.getHighlightMembership(highlight.bookId, highlight.id),
    ]).then(([nextThreads, nextMemberships]) => {
      if (!active) return;
      setThreads(nextThreads);
      setMemberships(nextMemberships);
    }, () => active && setError("Threads could not be loaded for this passage."));
    return () => { active = false; };
  }, [highlight.bookId, highlight.id]);

  async function assign(threadIds: readonly ThreadId[]) {
    const receipt = await window.leaflogue.threads.setHighlightMembership({
      bookId: highlight.bookId,
      highlightId: highlight.id,
      threadIds,
      expectedHighlightRevision: revision.current,
    });
    revision.current = receipt.highlightRevision;
    setMemberships(receipt.threadIds);
    await reload();
  }

  return (
    <div className={styles.tagPicker}>
      {threads === undefined || memberships === undefined ? (
        !error && <Loading>Loading threads…</Loading>
      ) : (
        <SearchableMultiSelect
          label="Threads"
          options={threads.map((thread) => ({ id: thread.id, label: thread.name }))}
          selected={memberships}
          emptyText="No thematic threads yet. Create one below."
          onChange={assign}
        />
      )}
      <form className={styles.inlineCreate} onSubmit={async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!memberships) return;
        setCreating(true);
        setError("");
        try {
          const thread = await window.leaflogue.threads.create({ name });
          setThreads((current) => [...(current ?? []), thread]);
          await assign([...memberships, thread.id]);
          setName("");
        } catch {
          setError("That thread could not be created. Thread names must be unique.");
        } finally {
          setCreating(false);
        }
      }}>
        <label className="ll-label">Create a thread here<input className="ll-field" required maxLength={120} value={name} placeholder="Power, exile, belonging…" onChange={(event) => setName(event.target.value)} /></label>
        <button className="ll-button" disabled={creating || memberships === undefined}>{creating ? "Creating…" : "Create and add"}</button>
      </form>
      <InlineError>{error}</InlineError>
      <div className={styles.actions}>
        <a className="ll-button-secondary" href={href.threads()}>View all threads</a>
        <button className="ll-button-secondary" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

interface CompanionMessage {
  readonly id: string;
  readonly role: "reader" | "companion";
  readonly text: string;
  readonly saveable?: boolean;
  readonly saved?: boolean;
}

const OPENING_QUESTION = "Explain this passage.";

/**
 * The one AI entry point on a passage, matching the web companion: it explains
 * straight away, then takes follow-up questions. The only stop before anything
 * is sent is a provider's first use, where the reader sees exactly what leaves
 * this computer and accepts the provider's terms.
 */
export function ExplainPassage({ highlight }: { readonly highlight: HighlightListEntry; readonly onClose: () => void }) {
  const { reload, readOnly } = useContext(PassageContext);
  const [disclosure, setDisclosure] = useState<AiTaskDisclosure | null>();
  const [messages, setMessages] = useState<readonly CompanionMessage[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState<{ readonly question: string; readonly history: readonly CompanionMessage[] }>();
  const request = useRef<string | undefined>(undefined);
  const started = useRef(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    window.leaflogue.ai.describeExplainTask(highlight.bookId, highlight.id, false).then(
      (next) => { if (active) setDisclosure(next); },
      () => {
        if (!active) return;
        setDisclosure(null);
        setError("AI is not ready. Choose a provider and add a key in Settings, then try again.");
      },
    );
    return () => { active = false; };
  }, [highlight.bookId, highlight.id]);

  useEffect(() => () => {
    if (request.current) void window.leaflogue.ai.cancel(request.current).catch(() => undefined);
  }, []);

  useEffect(() => { end.current?.scrollIntoView?.({ block: "end" }); }, [messages, pending]);

  async function ask(question: string, history: readonly CompanionMessage[]): Promise<void> {
    if (!disclosure) return;
    const requestId = crypto.randomUUID();
    request.current = requestId;
    setPending(true);
    setError("");
    setRetry(undefined);
    setMessages([...history, { id: crypto.randomUUID(), role: "reader", text: question }]);
    try {
      if (!disclosure.consented) {
        await window.leaflogue.ai.acceptTerms(disclosure.providerId);
        setDisclosure({ ...disclosure, consented: true });
      }
      // Disclosures are short-lived; a follow-up asks for a fresh one so a long
      // conversation keeps going, and still sends only this passage.
      const current = history.length
        ? await window.leaflogue.ai.describeExplainTask(highlight.bookId, highlight.id, false)
        : disclosure;
      const answer = await window.leaflogue.ai.explainPassage({
        requestId,
        disclosureId: current.disclosureId,
        ...(history.length ? { followUp: { question, history: history.map(({ role, text }) => ({ role, text })) } } : {}),
      });
      if (request.current !== requestId) return;
      setMessages((existing) => [...existing, { id: crypto.randomUUID(), role: "companion", text: answer.explanation, saveable: answer.saveable !== false }]);
    } catch (cause) {
      if (request.current === requestId) {
        setError(cause instanceof Error && cause.message ? cause.message : "That answer could not be finished.");
        setRetry({ question, history });
      }
    } finally {
      if (request.current === requestId) {
        request.current = undefined;
        setPending(false);
      }
    }
  }

  useEffect(() => {
    if (disclosure?.consented && !started.current) {
      started.current = true;
      void ask(OPENING_QUESTION, []);
    }
    // ask reads the disclosure it is given; this only runs the opening once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disclosure]);

  async function save(message: CompanionMessage): Promise<void> {
    if (message.saved) return;
    setError("");
    try {
      await window.leaflogue.library.createNote({ bookId: highlight.bookId, highlightId: highlight.id, markdown: message.text, origin: "ai" });
    } catch {
      setError("That answer could not be saved as a note. The passage may have changed; close this and try again.");
      return;
    }
    setMessages((existing) => existing.map((candidate) => candidate.id === message.id ? { ...candidate, saved: true } : candidate));
    try {
      await reload();
    } catch {
      setError("The answer was saved as a note, but this view could not refresh yet.");
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const question = String(new FormData(form).get("question") ?? "").trim();
    if (!question) return;
    form.reset();
    await ask(question, messages);
  }

  if (disclosure === undefined) return <Loading>Checking your AI settings…</Loading>;
  if (disclosure === null) return <InlineError>{error}</InlineError>;

  if (!disclosure.consented && messages.length === 0) {
    return (
      <div className={styles.explain}>
        <p className="ll-muted">Leaflogue has not sent anything to {disclosure.providerName} yet. Asking about this passage transmits:</p>
        <blockquote className={styles.quote}><PassageText text={disclosure.passage} /></blockquote>
        <p className="ll-muted">
          {disclosure.bookTitle}{disclosure.authors.length > 0 ? ` — ${disclosure.authors.join(", ")}` : ""}
          {disclosure.series && <><br />{disclosure.series}{disclosure.seriesNumber ? `, book ${disclosure.seriesNumber}` : ""}</>}
          {disclosure.publisher && <><br />{disclosure.publisher}</>}
        </p>
        {disclosure.description && (
          <details className={styles.sentDescription}>
            <summary>The book&apos;s description is sent too</summary>
            <PassageText text={disclosure.description} />
          </details>
        )}
        {disclosure.trainsOnFreeTier && (
          <p className="ll-muted">
            On {disclosure.providerName}&apos;s free tier, what you send may be used to improve their products. Use a paid
            key or another provider for passages you would rather keep out of that.
          </p>
        )}
        <p className="ll-muted">You&apos;ll only be asked this once for {disclosure.providerName}.</p>
        <div className={styles.actions}>
          <button className="ll-button" onClick={() => { started.current = true; void ask(OPENING_QUESTION, []); }}>Send to {disclosure.providerName}</button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.companion} aria-busy={pending}>
      <div className={styles.conversation} aria-live="polite">
        {messages.map((message) => (
          <article key={message.id} className={message.role === "companion" ? "ui-companion-answer" : styles.companionQuestion}>
            <p className="ui-companion-label">{message.role === "companion" ? <><Sparkles size={15} aria-hidden="true" />Companion</> : "You"}</p>
            <MarkdownText className="ui-companion-markdown" text={message.text} />
            {message.role === "companion" && message.saveable && !readOnly && (
              <button className={styles.companionSave} disabled={message.saved} onClick={() => void save(message)}>
                {message.saved ? <Check size={16} aria-hidden="true" /> : <StickyNote size={16} aria-hidden="true" />}
                {message.saved ? "Saved to this highlight" : "Save as note"}
              </button>
            )}
          </article>
        ))}
        {pending && <p className={styles.companionThinking} role="status"><Sparkles size={16} aria-hidden="true" />Thinking about the passage…</p>}
        <div ref={end} aria-hidden="true" />
      </div>
      {error && (
        <div className={styles.companionError} role="alert">
          <InlineError>{error}</InlineError>
          {retry && <button className="ll-button-secondary" onClick={() => void ask(retry.question, retry.history)}>Try again</button>}
        </div>
      )}
      <form className={styles.companionComposer} onSubmit={(event) => void submit(event)}>
        <label className="sr-only" htmlFor={`ai-question-${highlight.id}`}>Ask about this passage</label>
        <textarea id={`ai-question-${highlight.id}`} name="question" rows={2} maxLength={2000} disabled={pending} placeholder="Ask a follow-up…"
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
        <button className="ll-button" disabled={pending} aria-label="Send question"><ArrowRight size={16} aria-hidden="true" /></button>
      </form>
      <p className={styles.companionFooter}>Conversation is not saved · Written by {disclosure.providerName} ({disclosure.model}); check it against the book.</p>
    </div>
  );
}

export function ImportedOriginal({ highlight, onClose }: {
  readonly highlight: HighlightListEntry;
  readonly onClose: () => void;
}) {
  const [confirm, confirmDialog] = useConfirm();
  const { reload } = useContext(PassageContext);
  const [source, setSource] = useState<HighlightSource | null>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [committed, setCommitted] = useState(false);
  useEffect(() => {
    let active = true;
    void window.leaflogue.library.getHighlightSource(highlight.bookId, highlight.id).then(
      (result) => active && setSource(result ?? null),
      () => active && setError("Leaflogue could not read the imported original."),
    );
    return () => { active = false; };
  }, [highlight.bookId, highlight.id]);

  if (source === undefined && error) return <InlineError>{error}</InlineError>;
  if (source === undefined) return <Loading>Reading the imported original…</Loading>;
  if (source === null) return <p className="ll-muted">This passage is no longer linked to an imported original.</p>;
  return (
    <div className={styles.importedOriginal}>
      <p className="ll-muted">Latest version from {source.sourceName}</p>
      <blockquote><PassageText text={source.text} /></blockquote>
      {source.location && <p className={styles.location}>{source.location}</p>}
      {source.note && <aside><strong>Imported note</strong><PassageText text={source.note} note /></aside>}
      <p className="ll-muted">{source.differs ? "Your current passage differs from this imported version." : "Your current passage matches this imported version."}</p>
      <InlineError>{error}</InlineError>
      <div className={styles.actions}>
        {source.differs && (
          <button className="ll-button" onClick={async () => {
            if (!await confirm({ title: "Reset to imported original?", message: "This replaces the passage and its imported note with the latest imported original. Your edits will be overwritten.", confirmLabel: "Reset passage", destructive: true })) return;
            setPending(true);
            setError("");
            try {
              await window.leaflogue.library.resetHighlightToSource({
                id: highlight.id,
                bookId: highlight.bookId,
                expectedRevision: highlight.revision,
                resetToken: source.resetToken,
              });
            } catch {
              setError("This passage changed before it could be reset. Close this window and try again.");
              setPending(false);
              return;
            }
            setCommitted(true);
            try {
              await reload();
              onClose();
            } catch {
              setError("The passage was reset, but this view could not refresh. Close and reopen it to see the committed change.");
            } finally {
              setPending(false);
            }
          }} disabled={pending || committed}>{pending ? "Resetting…" : committed ? "Reset saved" : "Reset to imported original"}</button>
        )}
        <button className="ll-button-secondary" disabled={pending} onClick={onClose}>Close</button>
      </div>
      {confirmDialog}
    </div>
  );
}
