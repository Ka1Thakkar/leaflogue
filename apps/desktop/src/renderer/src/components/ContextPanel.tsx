import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Icon } from "@leaflogue/ui";
import { aiAvailable } from "../palette/actions";
import { href, navigate, parseRoute, useHash } from "../router";
import type { AiConfigurationSummary, BookId, HighlightId, HighlightListEntry } from "@leaflogue/contracts";
import { BookOpen, Sparkles, X } from "./icons";
import { EpubReader } from "./EpubReader";
import { ExplainPassage, PassageContext } from "./PassageActions";
import styles from "./context-panel.module.css";

type Tab = "reader" | "assistant";
interface PassageSelection {
  highlight: HighlightListEntry;
  reload: () => Promise<void>;
  readOnly: boolean;
}
interface Workspace {
  open: boolean;
  tab: Tab;
  book?: { id: BookId; title: string };
  passage?: PassageSelection;
  readerTarget?: { highlightId: HighlightId; requestId: number };
  showPassage: (highlight: HighlightListEntry) => void;
  expanded: boolean;
  setExpanded: (value: boolean) => void;
  showReader: (id: BookId, title: string) => void;
  showAssistant: (selection: PassageSelection) => void;
  selectTab: (tab: Tab) => void;
  toggle: () => void;
  close: () => void;
}
const ContextWorkspace = createContext<Workspace | undefined>(undefined);
export function useContextWorkspace() { return useContext(ContextWorkspace); }

export function ContextWorkspaceProvider({ children }: { readonly children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("reader");
  const [book, setBook] = useState<Workspace["book"]>();
  const [passage, setPassage] = useState<PassageSelection>();
  const [readerTarget, setReaderTarget] = useState<Workspace["readerTarget"]>();
  const readerRequest = useRef(0);
  const [expanded, setExpanded] = useState(false);
  const route = parseRoute(useHash());
  const routeBookId = route.name === "book" ? route.bookId : undefined;
  useEffect(() => {
    if (!routeBookId) return;
    let active = true;
    void window.leaflogue.library.getBookContents(routeBookId).then((contents) => {
      if (active && contents) setBook({ id: contents.book.id, title: contents.book.title });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [routeBookId]);
  return <ContextWorkspace.Provider value={{
    open, tab, book, passage, readerTarget, expanded, setExpanded,
    showPassage: (highlight) => { setBook({ id: highlight.bookId, title: highlight.bookTitle }); setReaderTarget({ highlightId: highlight.id, requestId: ++readerRequest.current }); setTab("reader"); setOpen(true); },
    showReader: (id, title) => { setReaderTarget(undefined); setBook({ id, title }); setTab("reader"); setOpen(true); },
    showAssistant: (next) => { setPassage(next); setTab("assistant"); setOpen(true); },
    selectTab: setTab,
    toggle: () => { setOpen((value) => !value); setExpanded(false); },
    close: () => { setOpen(false); setExpanded(false); },
  }}>{children}</ContextWorkspace.Provider>;
}

export function ContextPanelToggle() {
  const context = useContextWorkspace();
  return <button className="ll-icon-button" aria-label={context?.open ? "Close context panel" : "Open context panel"} aria-expanded={context?.open ?? false} title={context?.open ? "Close context panel" : "Open context panel"} aria-controls="reading-context" onClick={() => context?.toggle()}>
    <Icon name="sidebar-right" size={17} aria-hidden="true" />
  </button>;
}

function initialWidth() {
  try {
    const saved = Number(localStorage.getItem("leaflogue.context-width.v2"));
    return Number.isFinite(saved) && saved >= 300 && saved <= 640 ? saved : 360;
  } catch { return 440; }
}

export function ContextPanel() {
  const context = useContextWorkspace();
  const [width, setWidth] = useState(initialWidth);
  const [ai, setAi] = useState<AiConfigurationSummary>();
  useEffect(() => {
    if (!context?.open) return;
    let active = true;
    const refresh = () => { void window.leaflogue.ai.describe().then((value) => { if (active) setAi(value); }).catch(() => { if (active) setAi(undefined); }); };
    refresh();
    window.addEventListener("leaflogue:ai-saved", refresh);
    return () => { active = false; window.removeEventListener("leaflogue:ai-saved", refresh); };
  }, [context?.open, context?.tab]);
  const tabs = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    try { localStorage.setItem("leaflogue.context-width.v2", String(width)); } catch { /* session-only preference */ }
  }, [width]);
  useEffect(() => {
    if (context?.open) panel.current?.querySelector<HTMLElement>(`[role="tab"][aria-selected="true"]`)?.focus();
  }, [context?.open, context?.tab]);
  if (!context) return null;
  // Remain mounted when collapsed so tab changes and reopening preserve work.
  const { open, tab, book, passage, readerTarget, expanded } = context;
  const resize = (value: number) => setWidth(Math.min(640, Math.max(300, value)));
  return <aside ref={panel} id="reading-context" aria-label="Reading context" data-reading-context data-expanded={expanded} hidden={!open} className={styles.panel} style={{ "--context-width": `${width}px` } as CSSProperties}>
    <div role="separator" aria-label="Resize context panel" aria-orientation="vertical" aria-valuemin={300} aria-valuemax={640} aria-valuenow={width} tabIndex={expanded ? -1 : 0} className={styles.resize}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") {
          event.preventDefault(); resize(event.key === "Home" ? 300 : event.key === "End" ? 640 : width + (event.key === "ArrowLeft" ? 24 : -24));
        }
      }}
      onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) resize(event.currentTarget.parentElement!.getBoundingClientRect().right - event.clientX); }}
      onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
    />
    <header className={styles.header}>
      <div role="tablist" aria-label="Context views" ref={tabs} className={styles.tabs} onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        context.selectTab(event.key === "Home" ? "reader" : event.key === "End" ? "assistant" : tab === "reader" ? "assistant" : "reader");
      }}>
        <button role="tab" id="context-reader-tab" aria-controls="context-reader" aria-selected={tab === "reader"} tabIndex={tab === "reader" ? 0 : -1} onClick={(event) => { context.selectTab("reader"); if (event.detail > 0) requestAnimationFrame(() => panel.current?.querySelector<HTMLIFrameElement>("iframe")?.contentWindow?.focus()); }}><BookOpen size={15} aria-hidden="true" />Reader</button>
        <button role="tab" id="context-assistant-tab" aria-controls="context-assistant" aria-selected={tab === "assistant"} tabIndex={tab === "assistant" ? 0 : -1} onClick={() => context.selectTab("assistant")}><Sparkles size={15} aria-hidden="true" />Assistant</button>
      </div>
      <button className="ll-icon-button" aria-label={expanded ? "Restore split view" : "Expand context panel"} title={expanded ? "Restore split view" : "Expand context panel"} onClick={() => context.setExpanded(!expanded)}><Icon name={expanded ? "collapse" : "expand"} size={17} aria-hidden="true" /></button>
      <button className="ll-icon-button" aria-label="Collapse context panel" title="Collapse context panel" onClick={() => { context.close(); document.querySelector<HTMLButtonElement>('button[aria-controls="reading-context"]')?.focus(); }}><X size={16} aria-hidden="true" /></button>
    </header>
    <section role="tabpanel" id="context-reader" aria-labelledby="context-reader-tab" hidden={tab !== "reader"} className={styles.body}>
      {book ? <EpubReader key={book.id} bookId={book.id} embedded target={readerTarget} active={open && tab === "reader"} onOpenInBook={(id) => { context.setExpanded(false); if (window.innerWidth <= 900) context.close(); navigate(href.book(book.id, id)); }} /> : <div className={styles.empty}><BookOpen size={28} aria-hidden="true" /><h2>Keep your book beside you</h2><p>Open a book in your library and choose Read to bring its EPUB here.</p></div>}
    </section>
    <section role="tabpanel" id="context-assistant" aria-labelledby="context-assistant-tab" hidden={tab !== "assistant"} className={styles.body}>
      {passage ? <PassageContext.Provider value={{ tags: [], reload: passage.reload, readOnly: passage.readOnly, aiEnabled: true }}>
        <p className="ui-label">Selected passage</p><blockquote className={styles.quote}>{passage.highlight.text}</blockquote>
        <ExplainPassage key={passage.highlight.id} highlight={passage.highlight} onClose={context.close} />
      </PassageContext.Provider> : <div className={styles.empty}><Sparkles size={28} aria-hidden="true" /><h2>Think through a passage</h2><p>Choose Explain this passage on a highlight to open your reading companion here.</p><p className="ll-muted">{ai === undefined ? "Checking AI settings…" : aiAvailable(ai) ? "Your AI provider is ready. Nothing is sent until you choose a passage." : ai.enabled ? "Add a provider key in Settings to use the assistant." : "AI is disabled. Enable it in Settings to use the assistant."}</p><a className="ll-button-secondary" href={href.settings()}>AI settings</a></div>}
    </section>
  </aside>;
}
