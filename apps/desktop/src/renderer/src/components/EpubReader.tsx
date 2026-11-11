import { CalibrePicker } from "./CalibrePicker";
import { MarkdownText } from "./MarkdownText";
import { useConfirm } from "./Confirm";
import { applyReaderColors } from "./reader-colors";
import { matchReaderHighlight, normalizedQuote, readerSelection } from "./reader-annotations";
import { Icon, Select, SelectItem } from "@leaflogue/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BookId, HighlightId, EpubDocument, BookContents, AppearanceConfiguration, Highlight as SavedHighlight } from "@leaflogue/contracts";
import { InlineError } from "./shared";
import styles from "./epub-reader.module.css";

type Position = EpubDocument["position"];
const escape = (value: string) => value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
const GAP = 48;

/** Publisher markup stays inside a scriptless, network-denied reading document. */
export function EpubReader({ bookId, embedded = false, target, active = true, onOpenInBook }: { readonly bookId: BookId; readonly embedded?: boolean; readonly target?: { highlightId: HighlightId; requestId: number }; readonly active?: boolean; readonly onOpenInBook?: (id: HighlightId) => void }) {
  const [book, setBook] = useState<EpubDocument>();
  const [confirm, confirmDialog] = useConfirm();
  const [activeHighlight, setActiveHighlight] = useState<{ id: HighlightId; left: number; top: number; note?: boolean }>();
  const [noteMarkers, setNoteMarkers] = useState<{ id: HighlightId; left: number; top: number; label: string }[]>([]);
  const refreshNoteMarkers = useRef<() => void>(() => undefined);
  const paintedRanges = useRef<{ highlight: SavedHighlight; range: Range }[]>([]);
  const [opened, setOpened] = useState(embedded);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const frame = useRef<HTMLIFrameElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const anchor = useRef<Position>({ chapter: 0, paragraph: 0 });
  const pageRef = useRef(0);
  const countRef = useRef(1);
  const navigateRange = useRef<(range: Range) => void>(() => undefined);
  const handledTarget = useRef<number | undefined>(undefined);
  const turn = useRef<(page: number) => void>(() => undefined);
  const menu = useRef<(x: number, y: number) => void>(() => undefined);
  const [chapter, setChapter] = useState(0);
  const [fontSize, setFontSize] = useState(18);
  const [page, setPage] = useState(0);
  const [count, setCount] = useState(1);
  const [loaded, setLoaded] = useState(0);
  const [readerDisplay, setReaderDisplay] = useState<{ dark: boolean; theme: boolean }>(() => {
    try { const value = JSON.parse(localStorage.getItem("leaflogue.reader-display") ?? "null") as { dark?: unknown; theme?: unknown } | null; return { dark: typeof value?.dark === "boolean" ? value.dark : true, theme: value?.theme === true }; }
    catch { return { dark: true, theme: false }; }
  });
  const [appearance, setAppearance] = useState<AppearanceConfiguration>();
  useEffect(() => {
    let active = true;
    void window.leaflogue.appearance.describe().then((value) => { if (active) setAppearance(value); }).catch(() => undefined);
    const stop = window.leaflogue.appearance.onChanged((value) => { if (active) setAppearance(value); });
    return () => { active = false; stop(); };
  }, []);
  useEffect(() => { try { localStorage.setItem("leaflogue.reader-display", JSON.stringify(readerDisplay)); } catch { /* session preference */ } }, [readerDisplay]);
  useEffect(() => {
    const doc = frame.current?.contentDocument;
    if (!loaded || !doc?.getElementById("reader-pages")) return;
    const definition = appearance?.themes.find((theme) => theme.id === appearance.themeId);
    applyReaderColors(doc, readerDisplay.dark, readerDisplay.theme ? definition?.[readerDisplay.dark ? "dark" : "light"] : undefined);
  }, [loaded, appearance, readerDisplay]);
  const [saved, setSaved] = useState("");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [calibreOpen, setCalibreOpen] = useState(false);
  const [contents, setContents] = useState<BookContents>();
  const [selected, setSelected] = useState<{ text: string; sourceLocation: string; left: number; top: number }>();
  const [addingNote, setAddingNote] = useState(false);
  const [note, setNote] = useState("");
  const [savingHighlight, setSavingHighlight] = useState(false);
  const [matchStatus, setMatchStatus] = useState({ matched: 0, unmatched: 0 });
  const selectionLocked = useRef(false);
  const selectedRange = useRef<Range | undefined>(undefined);
  const [annotationVersion, setAnnotationVersion] = useState(0);
  useEffect(() => {
    let active = true;
    const refresh = () => { void window.leaflogue.library.getBookContents(bookId).then((next) => { if (active) setContents(next); }).catch(() => undefined); };
    refresh();
    window.addEventListener("leaflogue:annotations-changed", refresh);
    window.addEventListener("focus", refresh);
    const stop = window.leaflogue.sync.onStatus((status) => { if (status.state !== "syncing") refresh(); });
    return () => { active = false; window.removeEventListener("leaflogue:annotations-changed", refresh); window.removeEventListener("focus", refresh); stop(); };
  }, [bookId]);
  useEffect(() => {
    const doc = frame.current?.contentDocument;
    if (!book || !doc || !loaded) return;
    const inner = doc.defaultView as Window & typeof globalThis;
    if (!inner?.CSS?.highlights || !inner.Highlight) return;
    const matches = (contents?.highlights ?? []).map((highlight) => ({ highlight, range: matchReaderHighlight(doc, book, highlight) })).filter((match): match is { highlight: SavedHighlight; range: Range } => Boolean(match.range));
    paintedRanges.current = matches;
    const ranges = matches.map((match) => match.range);
    inner.CSS.highlights.set("leaflogue-saved", new inner.Highlight(...ranges));
    refreshNoteMarkers.current();
    setMatchStatus({ matched: ranges.length, unmatched: (contents?.highlights.length ?? 0) - ranges.length });
    return () => { paintedRanges.current = []; inner.CSS.highlights.delete("leaflogue-saved"); };
  }, [book, contents, loaded, annotationVersion]);
  const options = useRef<HTMLDivElement>(null);
  const jump = useRef<(chapter: number) => void>(() => undefined);
  useEffect(() => { if (optionsOpen) options.current?.focus(); }, [optionsOpen]);
  const pendingSave = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saveQueue = useRef(Promise.resolve());
  const save = useRef<(position: Position) => void>(() => undefined);
  useEffect(() => {
    let active = true;
    if (!book) return;
    const persist = (next: Position) => {
      saveQueue.current = saveQueue.current.catch(() => undefined).then(async () => {
        await window.leaflogue.epub!.savePosition(bookId, book.sha256, next.chapter, next.paragraph, next.offset);
        if (active) setSaved("Position saved");
      }).catch(() => { if (active) setError("Your reading position could not be saved."); });
    };
    save.current = (next) => {
      anchor.current = next; clearTimeout(pendingSave.current);
      pendingSave.current = setTimeout(() => { pendingSave.current = undefined; persist(next); }, 250);
    };
    return () => {
      active = false;
      if (pendingSave.current !== undefined) { clearTimeout(pendingSave.current); persist(anchor.current); }
      pendingSave.current = undefined;
    };
  }, [book, bookId]);
  useEffect(() => {
    let active = true;
    void window.leaflogue.epub?.open(bookId).then((next) => {
      if (!active) return;
      anchor.current = next?.position ?? { chapter: 0, paragraph: 0 };
      setBook(next); setChapter(anchor.current.chapter);
    }).catch((failure: unknown) => { if (active) setError(String(failure)); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [bookId]);
  const source = useMemo(() => {
    if (!book) return "";
    const publisherStyles = [...new Set(book.chapters.map((item) => item.styles ?? ""))].join("\n").replace(/<\/style/giu, "<\\/style");
    const chapters = book.chapters.map((item, index) => `<article data-chapter="${index}" data-path="${escape(item.id)}" aria-label="${escape(item.title)}">${item.html ?? item.text.split("\n\n").map((text, paragraph) => `<p data-paragraph="${paragraph}">${escape(text)}</p>`).join("")}</article>`).join("");
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"><style>${publisherStyles}</style><style>
      html,body{box-sizing:border-box!important;width:100%!important;height:100%!important;margin:0!important;overflow:hidden!important}
      body{padding:clamp(20px,4vw,48px)!important;background:#fff;color:#222;font:18px/1.65 Georgia,serif}
      #reader-scroll{box-sizing:border-box!important;max-width:68ch;width:100%;height:100%;margin:auto;padding:4px 0!important;border:0!important;overflow:hidden;outline:none}
      #reader-pages{box-sizing:border-box!important;height:100%;padding:0!important;margin:0!important;border:0!important;position:relative!important;column-count:auto!important;column-fill:auto!important;column-gap:${GAP}px!important}
      #reader-pages>article{break-before:column;box-sizing:border-box!important;width:auto!important;max-width:100%!important;padding:0 4px!important;margin:0!important}#reader-pages>article:first-child{break-before:auto}
      #reader-pages :is(p,div,section,blockquote,ul,ol,li,pre,figure,h1,h2,h3,h4,h5,h6){box-sizing:border-box!important;width:auto!important;min-width:0!important;max-width:100%!important;overflow-wrap:anywhere}
      ::highlight(leaflogue-target){background:#ffd166;color:#111;text-decoration:underline}
      ::highlight(leaflogue-saved){background:#ffe098;color:#292017}
      img{max-width:100%!important;max-height:100%!important;object-fit:contain}table{max-width:100%}pre{white-space:pre-wrap}
      [data-reader-link]{cursor:pointer}p{orphans:2;widows:2}
      </style></head><body><main id="reader-scroll"><div id="reader-pages">${chapters}</div></main></body></html>`;
  }, [book]);

  useEffect(() => {
    const doc = frame.current?.contentDocument;
    const view = doc?.getElementById("reader-scroll");
    const content = doc?.getElementById("reader-pages");
    if (!opened || !book || !doc || !view || !content) return;
    doc.body.style.setProperty("font-size", `${fontSize}px`);
    const nodes = () => Array.from(content.querySelectorAll<HTMLElement>("[data-paragraph]"));
    for (const node of nodes()) node.dataset.chapter = node.closest<HTMLElement>("article[data-chapter]")!.dataset.chapter;
    const textNodes = (element: Element) => {
      const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT); const result: Text[] = [];
      let node: Node | null; while ((node = walker.nextNode())) result.push(node as Text);
      return result;
    };
    const character = (element: Element, offset: number) => {
      for (const text of textNodes(element)) {
        if (offset < text.length) { const range = doc.createRange(); range.setStart(text, offset); range.setEnd(text, offset + 1); return range.getBoundingClientRect(); }
        offset -= text.length;
      }
      return element.getBoundingClientRect();
    };
    const updateNoteMarkers = () => {
      if (!viewport.current?.clientWidth) { setNoteMarkers([]); return; }
      const bounds = view.getBoundingClientRect(); const frameBounds = frame.current!.getBoundingClientRect();
      const markers: { id: HighlightId; left: number; top: number; label: string }[] = [];
      for (const { highlight, range } of paintedRanges.current) {
        if (!highlight.notes.length) continue;
        const rect = Array.from(range.getClientRects()).find((rect) => rect.right > bounds.left + 1 && rect.left < bounds.right - 1 && rect.bottom > bounds.top && rect.top < bounds.bottom);
        if (!rect) continue;
        let top = frameBounds.top + rect.top;
        while (markers.some((marker) => Math.abs(marker.top - top) < 20)) top += 20;
        markers.push({ id: highlight.id, left: Math.min(frameBounds.right - 22, frameBounds.left + bounds.right + 2), top: Math.min(frameBounds.bottom - 24, top), label: `${highlight.notes.length} note${highlight.notes.length === 1 ? "" : "s"}: ${highlight.text.slice(0, 80)}` });
      }
      setNoteMarkers(markers);
    };
    refreshNoteMarkers.current = updateNoteMarkers;
    const layout = () => {
      if (!viewport.current?.clientWidth || !view.clientWidth) return;
      // Lock the CSS column width to the same whole-pixel pitch used for turns.
      // Auto-expanded fractional columns otherwise accumulate drift hundreds of pages in.
      view.style.removeProperty("width");
      const width = Math.floor(view.getBoundingClientRect().width);
      view.style.setProperty("width", `${width}px`, "important");
      content.style.setProperty("width", `${width}px`, "important");
      content.style.setProperty("column-width", `${width}px`, "important");
      const pitch = width + GAP;
      const total = Math.max(1, Math.ceil((content.scrollWidth + GAP) / pitch));
      countRef.current = total; setCount(total);
      const target = content.querySelector<HTMLElement>(`[data-chapter="${anchor.current.chapter}"][data-paragraph="${anchor.current.paragraph}"]`);
      const left = target ? character(target, anchor.current.offset ?? 0).left : content.getBoundingClientRect().left;
      const index = Math.max(0, Math.min(total - 1, Math.floor((left - content.getBoundingClientRect().left + 1) / pitch)));
      pageRef.current = index; setPage(index); view.scrollLeft = index * pitch; updateNoteMarkers();
    };
    const showPage = (value: number) => {
      selectionLocked.current = false; setActiveHighlight(undefined); selectedRange.current = undefined; setSelected(undefined); setAddingNote(false); setNote("");
      doc.getSelection()?.removeAllRanges();
      window.dispatchEvent(new CustomEvent("leaflogue:reader-selection", { detail: null }));
      (doc.defaultView as Window & typeof globalThis).CSS.highlights.delete("leaflogue-target");
      const index = Math.max(0, Math.min(countRef.current - 1, value));
      pageRef.current = index; setPage(index); view.scrollLeft = index * (view.clientWidth + GAP); updateNoteMarkers();
      const bounds = view.getBoundingClientRect();
      const first = nodes().find((node) => Array.from(node.getClientRects()).some((rect) => rect.right > bounds.left + 1 && rect.left < bounds.right - 1));
      if (!first) return;
      let low = 0; let high = first.textContent?.length ?? 0;
      while (low < high) { const mid = Math.floor((low + high) / 2); if (character(first, mid).right <= bounds.left + 1) low = mid + 1; else high = mid; }
      const next = { chapter: Number(first.dataset.chapter), paragraph: Number(first.dataset.paragraph), ...(low ? { offset: low } : {}) };
      setChapter(next.chapter); save.current(next);
    };
    turn.current = showPage;
    navigateRange.current = (range) => {
      const start = range.cloneRange(); start.collapse(true);
      const rect = start.getBoundingClientRect();
      const index = Math.floor((rect.left - content.getBoundingClientRect().left + 1) / (view.clientWidth + GAP));
      showPage(index);
      const inner = doc.defaultView as Window & typeof globalThis;
      inner.CSS.highlights.set("leaflogue-target", new inner.Highlight(range));
    };
    layout();
    setAnnotationVersion((value) => value + 1);
    const observer = new ResizeObserver(layout); observer.observe(viewport.current!);
    let active = true;
    void doc.fonts.ready.then(() => { if (active) layout(); });
    const visible = () => Boolean(viewport.current?.clientWidth) && !viewport.current?.closest("[hidden]");
    menu.current = () => { selectionLocked.current = false; setActiveHighlight(undefined); selectedRange.current = undefined; setSelected(undefined); setAddingNote(false); setNote(""); doc.getSelection()?.removeAllRanges(); window.dispatchEvent(new CustomEvent("leaflogue:reader-selection", { detail: null })); setOptionsOpen(true); };
    jump.current = (index) => {
      const target = content.querySelector<HTMLElement>(`article[data-chapter="${index}"]`);
      if (target) showPage(Math.floor((target.getBoundingClientRect().left - content.getBoundingClientRect().left + 1) / (view.clientWidth + GAP)));
    };
    const key = (event: KeyboardEvent) => {
      if (!visible() || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
      if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
        event.preventDefault(); const bounds = frame.current!.getBoundingClientRect(); menu.current(bounds.left + bounds.width / 2, bounds.top + 24); return;
      }
      if (event.shiftKey && event.key !== " ") return;
      const target = event.target as Element | null;
      if (target?.closest?.('[data-reader-selection],input,textarea,select,[contenteditable="true"],[role="combobox"],[role="listbox"],dialog,[role="dialog"],[role="separator"]') || Array.from(document.querySelectorAll('dialog[open],[role="dialog"],[role="listbox"]')).some((element) => element.getClientRects().length > 0 && !element.closest("[hidden]"))) return;
      if (target?.closest?.('[role="tab"]') && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      if (event.key === " " && target?.closest?.("button,a")) return;
      const forward = ["ArrowRight", "ArrowDown", "PageDown"].includes(event.key) || (event.key === " " && !event.shiftKey);
      const back = ["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key) || (event.key === " " && event.shiftKey);
      if (forward || back || event.key === "Home" || event.key === "End") { event.preventDefault(); showPage(event.key === "Home" ? 0 : event.key === "End" ? countRef.current - 1 : pageRef.current + (forward ? 1 : -1)); }
    };
    window.addEventListener("keydown", key, true); doc.addEventListener("keydown", key, true);
    let accumulated = 0; let lastTurn = 0; let lastEvent = 0;
    const wheel = (event: WheelEvent) => {
      if (!visible() || event.ctrlKey || event.metaKey) return;
      event.preventDefault(); const now = performance.now();
      if (now - lastEvent > 180) accumulated = 0; lastEvent = now;
      accumulated += (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? view.clientHeight : 1);
      if (Math.abs(accumulated) >= 40 && now - lastTurn > 350) { showPage(pageRef.current + (accumulated > 0 ? 1 : -1)); accumulated = 0; lastTurn = now; }
    };
    const click = (event: MouseEvent) => {
      if (doc.getSelection()?.toString()) return;
      const hit = paintedRanges.current.filter(({ range }) => Array.from(range.getClientRects()).some((rect) => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom)).sort((a, b) => a.highlight.text.length - b.highlight.text.length)[0];
      if (hit) {
        const bounds = frame.current!.getBoundingClientRect();
        setSelected(undefined); setNote("");
        setActiveHighlight({ id: hit.highlight.id, left: Math.max(8, Math.min(bounds.left + event.clientX, window.innerWidth - 344)), top: Math.max(8, Math.min(bounds.top + event.clientY + 12, window.innerHeight - 160)) });
        return;
      }
      setActiveHighlight(undefined);
      const target = event.target as Element;
      const link = target.closest<HTMLElement>("[data-reader-link]");
      if (link) {
        event.preventDefault(); const [path, id] = link.dataset.readerLink!.split("#");
        const article = Array.from(content.querySelectorAll<HTMLElement>("article[data-path]")).find((item) => item.dataset.path === path);
        const destination = id ? Array.from(article?.querySelectorAll<HTMLElement>("[id]") ?? []).find((item) => item.id === id) : article;
        if (destination) showPage(Math.floor((destination.getBoundingClientRect().left - content.getBoundingClientRect().left + 1) / (view.clientWidth + GAP)));
        return;
      }
      if (doc.getSelection()?.toString()) return;
      const bounds = view.getBoundingClientRect(); const x = event.clientX - bounds.left;
      if (x >= 0 && x < bounds.width * 0.12) showPage(pageRef.current - 1);
      else if (x > bounds.width * 0.88 && x <= bounds.width) showPage(pageRef.current + 1);
    };
    const contextMenu = (event: MouseEvent) => {
      event.preventDefault(); const bounds = frame.current!.getBoundingClientRect(); menu.current(event.clientX + bounds.left, event.clientY + bounds.top);
    };
    doc.addEventListener("contextmenu", contextMenu);
    const clearSelection = () => {
      if (selectionLocked.current) return;
      selectedRange.current = undefined; setSelected(undefined);
      window.dispatchEvent(new CustomEvent("leaflogue:reader-selection", { detail: null }));
    };
    const selection = () => {
      const selection = readerSelection(doc, book);
      if (!selection) { clearSelection(); return; }
      const rect = selection.range.getBoundingClientRect(); const bounds = frame.current!.getBoundingClientRect();
      setActiveHighlight(undefined); selectedRange.current = selection.range;
      selectionLocked.current = false; setAddingNote(false); setNote("");
      setSelected({ text: selection.text, sourceLocation: selection.sourceLocation, left: Math.max(8, Math.min(rect.left + bounds.left, window.innerWidth - 344)), top: Math.min(rect.bottom + bounds.top + 8, bounds.bottom - 80) });
      window.dispatchEvent(new CustomEvent("leaflogue:reader-selection", { detail: null }));
    };
    const selectionChanged = () => {
      const current = doc.getSelection(); const previous = selectedRange.current;
      if (!current?.rangeCount || current.isCollapsed || !previous || previous.compareBoundaryPoints(0, current.getRangeAt(0)) !== 0 || previous.compareBoundaryPoints(2, current.getRangeAt(0)) !== 0) clearSelection();
    };
    doc.addEventListener("selectionchange", selectionChanged);
    doc.addEventListener("wheel", wheel, { passive: false }); doc.addEventListener("click", click); doc.addEventListener("mouseup", selection); doc.addEventListener("keyup", selection);
    return () => { active = false; doc.removeEventListener("selectionchange", selectionChanged); doc.removeEventListener("contextmenu", contextMenu); observer.disconnect(); window.removeEventListener("keydown", key, true); doc.removeEventListener("keydown", key, true); doc.removeEventListener("wheel", wheel); doc.removeEventListener("click", click); doc.removeEventListener("mouseup", selection); doc.removeEventListener("keyup", selection); };
  }, [book, opened, loaded, fontSize, chapter]);

  useEffect(() => {
    const doc = frame.current?.contentDocument;
    if (!target || !active || !book || !contents || !loaded || !annotationVersion || !doc?.getElementById("reader-pages") || !viewport.current?.clientWidth || handledTarget.current === target.requestId) return;
    handledTarget.current = target.requestId;
    const highlight = contents.highlights.find((highlight) => highlight.id === target.highlightId);
    const range = highlight ? matchReaderHighlight(doc, book, highlight) : undefined;
    if (!range) { setError(highlight ? "This highlight could not be uniquely matched to the attached EPUB. It may belong to a different edition." : "This highlight is no longer in your library."); return; }
    setError(""); setOptionsOpen(false); navigateRange.current(range);
    frame.current?.contentWindow?.focus();
  }, [target, active, book, contents, loaded, annotationVersion]);

  function clearSelection() {
    selectionLocked.current = false; setActiveHighlight(undefined); selectedRange.current = undefined; setSelected(undefined); setAddingNote(false); setNote(""); setNote("");
    frame.current?.contentDocument?.getSelection()?.removeAllRanges();
    window.dispatchEvent(new CustomEvent("leaflogue:reader-selection", { detail: null }));
  }
  async function createHighlight() {
    if (!selected || savingHighlight || contents?.book.archived) return;
    setSavingHighlight(true); setError("");
    try {
      const doc = frame.current?.contentDocument;
      const existing = contents?.highlights.find((highlight) => normalizedQuote(highlight.text) === normalizedQuote(selected.text) && (
        highlight.sourceLocation === selected.sourceLocation || (!highlight.sourceLocation?.startsWith("epub:") && doc && book && matchReaderHighlight(doc, book, highlight))
      ));
      if (existing) {
        if (note.trim()) await window.leaflogue.library.createNote({ bookId, highlightId: existing.id, markdown: note.trim() });
      } else {
        await window.leaflogue.library.createHighlight({ bookId, text: selected.text, sourceLocation: selected.sourceLocation, ...(note.trim() ? { noteMarkdown: note.trim() } : {}) });
      }
      window.dispatchEvent(new Event("leaflogue:annotations-changed"));
      clearSelection();
    } catch { setError("The highlight could not be saved. Your selection has been kept so you can retry."); }
    finally { setSavingHighlight(false); }
  }
  async function removeActiveHighlight() {
    const highlight = contents?.highlights.find((item) => item.id === activeHighlight?.id);
    if (!highlight || contents?.book.archived) return;
    if (!await confirm({ title: "Remove highlight?", message: highlight.notes.length ? `This removes the saved highlight and its ${highlight.notes.length} attached note${highlight.notes.length === 1 ? "" : "s"} from your library and connected devices.` : "This removes the saved highlight from your library and connected devices. The book text stays unchanged.", confirmLabel: "Remove highlight", destructive: true })) return;
    try {
      await window.leaflogue.library.deleteHighlight({ bookId, id: highlight.id, expectedRevision: highlight.revision });
      setActiveHighlight(undefined); window.dispatchEvent(new Event("leaflogue:annotations-changed"));
    } catch { setError("This highlight could not be removed. It may have changed elsewhere; try again."); }
  }
  async function noteActiveHighlight() {
    if (!activeHighlight || !note.trim() || savingHighlight) return;
    setSavingHighlight(true);
    try {
      await window.leaflogue.library.createNote({ bookId, highlightId: activeHighlight.id, markdown: note.trim() });
      setActiveHighlight(undefined); setNote(""); window.dispatchEvent(new Event("leaflogue:annotations-changed"));
    } catch { setError("The note could not be saved. Your draft has been kept."); }
    finally { setSavingHighlight(false); }
  }
  const activePassage = contents?.highlights.find((highlight) => highlight.id === activeHighlight?.id);
  async function unlink() {
    if (!window.leaflogue.epub?.unlink || !await confirm({ title: "Unlink this EPUB?", message: "This removes only the local file link and reading position. Your original EPUB, book, highlights and notes stay in place.", confirmLabel: "Unlink EPUB" })) return;
    try { await window.leaflogue.epub.unlink(bookId); setBook(undefined); setError(""); setOptionsOpen(false); setActiveHighlight(undefined); setNoteMarkers([]); }
    catch { setError("The EPUB link could not be removed."); }
  }
  async function attach() {
    setBusy(true); setError("");
    try { const next = await window.leaflogue.epub!.attach(bookId); if (next) { anchor.current = next.position; setBook(next); setChapter(0); setOpened(true); } }
    catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  if (!window.leaflogue.epub) return null;
  return <section className={styles.reader} aria-label="Local EPUB reader">
    {confirmDialog}
    {!book && <><p className="ll-muted">{target ? "Link an EPUB to find this highlight in its original context." : "Link an EPUB to read it here."} The file stays in its original location.</p><button className="ll-button-secondary" disabled={busy} onClick={attach}>{busy ? "Checking for EPUB…" : "Attach EPUB"}</button>{window.leaflogue.calibre && <button className="ll-button-secondary" onClick={() => setCalibreOpen(true)}>Link from Calibre</button>}<p className="ll-muted">Book files are not included in library backups.</p></>}
    {error && <InlineError>{error}</InlineError>}
    {book && !embedded && <button className="ll-button-secondary" onClick={() => setOpened(!opened)}>{opened ? "Close reader" : "Read EPUB"}</button>}
    {calibreOpen && <div className={styles.overlay}><div role="dialog" aria-label="Calibre library" className={styles.options} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setCalibreOpen(false); } }}><CalibrePicker bookId={bookId} title={contents?.book.title ?? ""} onClose={() => setCalibreOpen(false)} onLinked={(next) => { anchor.current = next.position; setBook(next); setChapter(next.position.chapter); setCalibreOpen(false); setOptionsOpen(false); setOpened(true); setError(""); }} /></div></div>}
    {opened && book && <>
      <div className={styles.viewport} ref={viewport} role="region" aria-label="Book pages" onContextMenu={(event) => { event.preventDefault(); menu.current(event.clientX, event.clientY); }}>
        <iframe ref={frame} className={styles.frame} title="EPUB pages" sandbox="allow-same-origin" srcDoc={source} onLoad={() => setLoaded((value) => value + 1)} />
      </div>
      {!optionsOpen && !calibreOpen && active && noteMarkers.map((marker) => <button key={marker.id} className={styles.noteMarker} aria-label={marker.label} title={marker.label} style={{ left: marker.left, top: marker.top }} onClick={() => { setSelected(undefined); setActiveHighlight({ id: marker.id, left: Math.min(marker.left, window.innerWidth - 344), top: marker.top }); }}><Icon name="note-paper" size={15} aria-hidden="true" /></button>)}
      {activeHighlight && activePassage && !optionsOpen && <div data-reader-selection role="dialog" aria-label="Saved highlight actions" className={styles.selection} style={{ left: activeHighlight.left, top: Math.min(activeHighlight.top, window.innerHeight - (activeHighlight.note ? 280 : 160)) }} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setActiveHighlight(undefined); } }}>
        {activeHighlight.note ? <><label className="ll-label">Note<textarea autoFocus className="ll-field" rows={3} maxLength={10000} value={note} onChange={(event) => setNote(event.target.value)} /></label><button className="ll-button" disabled={savingHighlight || !note.trim()} onClick={() => void noteActiveHighlight()}>Save note</button></> : <>
          <p className={styles.activeExcerpt}>{activePassage.text.length > 100 ? `${activePassage.text.slice(0, 100)}…` : activePassage.text}</p>
          {activePassage.notes.length > 0 && <div className={styles.activeNotes}>{activePassage.notes.map((note) => <MarkdownText key={note.id} text={note.markdown} />)}</div>}
          <button className="ll-button-secondary" onClick={() => { onOpenInBook?.(activePassage.id); setActiveHighlight(undefined); }}>Open in book</button>
          {!contents?.book.archived && <><button className="ll-button-secondary" onClick={() => { setNote(""); setActiveHighlight((value) => value ? { ...value, note: true } : value); }}>Add note</button><button className="ll-button-secondary" onClick={() => void removeActiveHighlight()}>Remove highlight</button></>}
        </>}
        <button className="ll-button-secondary" onClick={() => setActiveHighlight(undefined)}>Cancel</button>
      </div>}
      {selected && !optionsOpen && <div data-reader-selection className={styles.selection} role={addingNote ? "dialog" : "toolbar"} aria-label={addingNote ? "Note for selected text" : "Selected text actions"} style={{ left: selected.left, top: Math.max(8, Math.min(selected.top, window.innerHeight - (addingNote ? 280 : 80))) }} onMouseDown={(event) => { if (!addingNote) event.preventDefault(); }} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); clearSelection(); } }}>
        {addingNote ? <><label className="ll-label">Note<textarea autoFocus className="ll-field" rows={3} maxLength={10000} value={note} onChange={(event) => setNote(event.target.value)} /></label><button className="ll-button" disabled={savingHighlight} onClick={() => void createHighlight()}>Save highlight and note</button></> : <>
          {!contents?.book.archived && <><button className="ll-button-secondary" disabled={savingHighlight} onClick={() => void createHighlight()}>{savingHighlight ? "Saving…" : "Highlight"}</button><button className="ll-button-secondary" onClick={() => { selectionLocked.current = true; setAddingNote(true); }}>Add note</button></>}
          {/^[\p{L}][\p{L}\p{M}'’-]{0,59}$/u.test(selected.text) && <button className="ll-button-secondary" onClick={() => { window.dispatchEvent(new CustomEvent("leaflogue:reader-define", { detail: selected.text })); clearSelection(); }}>Define</button>}
        </>}
        <button className="ll-button-secondary" disabled={savingHighlight} onClick={clearSelection}>Cancel</button>
      </div>}
      {optionsOpen && !calibreOpen && <div className={styles.overlay} onClick={(event) => { if (event.target === event.currentTarget) setOptionsOpen(false); }}>
        <div ref={options} role="dialog" aria-label="Reader options" tabIndex={-1} className={styles.options} onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOptionsOpen(false); frame.current?.focus(); }
        }}>
          <div className={styles.optionHeading}><div><p className="ui-label">Reader</p><h2>{contents?.book.title ?? "Reading"}</h2></div><button className="ll-icon-button" aria-label="Close reader options" onClick={() => { setOptionsOpen(false); frame.current?.focus(); }}><Icon name="close" size={17} aria-hidden="true" /></button></div>
          <div className={styles.progress}><span>Page {page + 1} of {count}</span><span>{Math.round((page + 1) / count * 100)}%</span></div><progress className={styles.progressBar} value={page + 1} max={count} aria-label="Reading progress" />
          <label className="ll-label">Contents<Select aria-label="Chapter" value={String(chapter)} onValueChange={(value) => { jump.current(Number(value)); setOptionsOpen(false); }}>{book.chapters.map((item, index) => <SelectItem value={String(index)} key={item.id}>{index + 1}. {item.title}</SelectItem>)}</Select></label>
          <label className="ll-label">Typography<Select aria-label="Text size" value={String(fontSize)} onValueChange={(value) => setFontSize(Number(value))}>{[16, 18, 20, 24, 28].map((size) => <SelectItem key={size} value={String(size)}>{size} px</SelectItem>)}</Select></label>
          <div className={styles.displayPreferences}>
            <label><span><strong>Dark mode</strong><small>Black background, white text</small></span><input type="checkbox" role="switch" aria-label="Dark mode" checked={readerDisplay.dark} onChange={(event) => setReaderDisplay((value) => ({ ...value, dark: event.target.checked }))} /></label>
            <label><span><strong>Use theme colours</strong><small>Adapt book colours to {appearance?.themes.find((theme) => theme.id === appearance.themeId)?.name ?? "your theme"}</small></span><input type="checkbox" role="switch" aria-label="Use theme colours" checked={readerDisplay.theme} onChange={(event) => setReaderDisplay((value) => ({ ...value, theme: event.target.checked }))} /></label>
          </div>
          <p className="ll-muted">{matchStatus.matched} highlights shown{matchStatus.unmatched ? ` · ${matchStatus.unmatched} could not be matched to this edition` : ""}</p>
          {window.leaflogue.calibre && <button className="ll-button-secondary" onClick={() => setCalibreOpen(true)}>Manage Calibre link</button>}
          {window.leaflogue.epub?.unlink && <button className="ll-button-secondary" onClick={() => void unlink()}>Unlink book file</button>}
          <details className={styles.shortcuts}><summary>Keyboard shortcuts</summary><dl><dt>Next page</dt><dd>→ / Space / Page Down</dd><dt>Previous page</dt><dd>← / Shift+Space / Page Up</dd><dt>Reader options</dt><dd>Shift+F10</dd></dl></details>
        </div>
      </div>}
      <span className="sr-only" role="status">Page {page + 1} of {count}. {saved}</span>
    </>}
  </section>;
}
