import { ReaderPreferenceControls, READER_TABS, type ReaderTab } from "./ReaderPreferences";
import { applyReaderTypography, useReaderPreferences, type ReaderTypography } from "./reader-preferences";
import { readerKeyAction } from "./reader-keys";
import { HighlightColourPicker } from "./HighlightColourPicker";
import { HIGHLIGHT_COLOURS, highlightColour, highlightPalette, useHighlightColours } from "./highlight-colours";
import { usePdfPages } from "./pdf-pages";
import { searchReader, readerTextRange } from "./reader-search";
import { CalibrePicker } from "./CalibrePicker";
import { MarkdownText } from "./MarkdownText";
import { useConfirm } from "./Confirm";
import { applyReaderColors } from "./reader-colors";
import { matchReaderHighlight, matchReaderLocation, parseReaderLocation, readerHighlightCandidates, readerLocationRange, type ReaderHighlightCandidate, type ReaderLocation, type ReaderRoot, normalizedQuote, readerSelection } from "./reader-annotations";
import { createPageEstimate, measureChapter, pagesBefore, resetPageEstimate, totalPages } from "./reader-pages";
import { Icon, Select, SelectItem } from "@leaflogue/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BookId, HighlightId, EpubDocument, EpubFailureKind, BookContents, AppearanceConfiguration, Highlight as SavedHighlight } from "@leaflogue/contracts";
import { InlineError } from "./shared";
import styles from "./epub-reader.module.css";

type Position = EpubDocument["position"];
const escape = (value: string) => value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
const GAP = 48;
/** One chapter as reading markup. Paragraph numbers are chapter-scoped, as saved positions and anchors expect. */
const chapterMarkup = (book: EpubDocument, index: number) => {
  const item = book.chapters[index]!;
  return `<article data-chapter="${index}" data-path="${escape(item.id)}" aria-label="${escape(item.title)}">${item.html ?? item.text.split("\n\n").map((text, paragraph) => `<p data-paragraph="${paragraph}">${escape(text)}</p>`).join("")}</article>`;
};
const tagParagraphs = (root: ParentNode) => {
  for (const node of root.querySelectorAll<HTMLElement>("[data-paragraph]")) node.dataset.chapter = node.closest<HTMLElement>("article[data-chapter]")!.dataset.chapter;
};
const wholeBooks = new WeakMap<EpubDocument, DocumentFragment>();
/**
 * Where highlights, anchors and reviewed locations are matched. EPUB pages hold
 * one chapter, so matching uses an inert copy of the whole book: parsed the same
 * way, but never laid out, styled, scripted or loaded from. PDF pages are all
 * in the reading document already.
 */
function annotationDocument(book: EpubDocument | undefined, frame: HTMLIFrameElement | null): ReaderRoot | undefined {
  if (!book) return undefined;
  if (book.format === "pdf") {
    // Matching can run before the layout pass labels paragraphs; labelling is idempotent.
    const doc = frame?.contentDocument ?? undefined;
    const pages = doc?.getElementById("reader-pages");
    if (pages) tagParagraphs(pages);
    return doc;
  }
  let copy = wholeBooks.get(book);
  if (!copy) {
    // Template contents are inert: nothing in them renders, runs or loads.
    const template = document.createElement("template");
    template.innerHTML = book.chapters.map((_, index) => chapterMarkup(book, index)).join("");
    copy = template.content; tagParagraphs(copy); wholeBooks.set(book, copy);
  }
  return copy;
}

/** Friendly wording for a book file that could not be opened; the technical message stays secondary. */
const FAILURES: Record<EpubFailureKind, string> = {
  missing: "Leaflogue can't find this book's file. It may have been moved, renamed or deleted.",
  changed: "The book file has changed since it was linked, so it may be a different edition.",
  unreadable: "This book file can't be opened. It may be damaged, protected or in a format Leaflogue doesn't support.",
  "invalid-link": "This book's file link is damaged.",
};
export interface OpenFailure { readonly kind: EpubFailureKind | "unknown"; readonly calibre: boolean; readonly detail: string }
export function describeOpenFailure(failure: unknown): OpenFailure {
  const text = failure instanceof Error ? failure.message : String(failure);
  const marker = /\s*\[book-file:(missing|changed|unreadable|invalid-link)(\+calibre)?\]/u.exec(text);
  const detail = text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, "").replace(/\s*\[book-file:[^\]]*\]/u, "").trim();
  return { kind: (marker?.[1] as EpubFailureKind | undefined) ?? "unknown", calibre: Boolean(marker?.[2]), detail };
}

/** Publisher markup stays inside a scriptless, network-denied reading document. */
export function EpubReader({ bookId, embedded = false, target, active = true, onOpenInBook, onExplain }: { readonly bookId: BookId; readonly embedded?: boolean; readonly target?: { highlightId: HighlightId; requestId: number }; readonly active?: boolean; readonly onExplain?: (highlight: SavedHighlight, readOnly: boolean) => void; readonly onOpenInBook?: (id: HighlightId) => void }) {
  const [book, setBook] = useState<EpubDocument>();
  const highlightColours = useHighlightColours();
  const [confirm, confirmDialog] = useConfirm();
  // `keyboard` marks actions opened from the highlights list: they take focus and return it to the page.
  const [activeHighlight, setActiveHighlight] = useState<{ id: HighlightId; left: number; top: number; note?: boolean; keyboard?: boolean }>();
  const highlightActions = useRef<HTMLDivElement>(null);
  const keyboardHighlight = useRef(false);
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
  /** Bring a chapter onto the page, then go to the range `find` locates in it. */
  const goTo = useRef<(chapter: number, find: (doc: Document) => Range | undefined) => Range | undefined>(() => undefined);
  const colourRef = useRef<() => void>(() => undefined);
  // Bumped whenever another chapter is swapped into the page, so its highlights are painted.
  const [windowVersion, setWindowVersion] = useState(0);
  const menu = useRef<(x: number, y: number) => void>(() => undefined);
  const [chapter, setChapter] = useState(0);
  const { preferences, update: updatePreferences, override, setOverride, savedBookSettings, forgetBookSettings, presets, savePreset, removePreset } = useReaderPreferences(bookId);
  const [openFailure, setOpenFailure] = useState<OpenFailure>();
  // Only text-setting choices re-run typography; clock, progress and colours never do.
  const typography: ReaderTypography = useMemo(() => ({
    size: preferences.size, weight: preferences.weight, alignment: preferences.alignment, line: preferences.line, paragraph: preferences.paragraph,
    indent: preferences.indent, letter: preferences.letter, word: preferences.word, hyphenation: preferences.hyphenation, horizontal: preferences.horizontal, vertical: preferences.vertical,
  }), [preferences.size, preferences.weight, preferences.alignment, preferences.line, preferences.paragraph, preferences.indent, preferences.letter, preferences.word, preferences.hyphenation, preferences.horizontal, preferences.vertical]);
  const typographyRef = useRef(typography);
  useEffect(() => { typographyRef.current = typography; }, [typography]);
  const [optionsTab, setOptionsTab] = useState<ReaderTab>("Book");
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    if (!preferences.clock || !active) return;
    setClock(new Date());
    const timer = setInterval(() => setClock(new Date()), 30_000);
    return () => clearInterval(timer);
  }, [preferences.clock, active]);
  const [pdfZoom, setPdfZoom] = useState("page");
  // Layout and listeners read the latest geometry here instead of reinstalling on every change.
  const geometry = useRef({ horizontal: preferences.horizontal, width: preferences.width, columns: preferences.columns, pdfZoom });
  useEffect(() => { geometry.current = { horizontal: preferences.horizontal, width: preferences.width, columns: preferences.columns, pdfZoom }; }, [preferences.horizontal, preferences.width, preferences.columns, pdfZoom]);
  const layoutRef = useRef<() => void>(() => undefined);
  const [page, setPage] = useState(0);
  const [count, setCount] = useState(1);
  const [loaded, setLoaded] = useState(0);
  const readerDisplay = useMemo(() => ({ dark: preferences.dark, theme: preferences.theme }), [preferences.dark, preferences.theme]);
  const [appearance, setAppearance] = useState<AppearanceConfiguration>();
  const themeTokens = appearance?.themes.find((theme) => theme.id === appearance.themeId)?.[readerDisplay.dark ? "dark" : "light"];
  const pdfTokens = useMemo(() => readerDisplay.theme ? themeTokens : preferences.palette === "sepia" && themeTokens ? { ...themeTokens, paper: readerDisplay.dark ? "#211b14" : "#f4ecd8", ink: readerDisplay.dark ? "#e8dcc5" : "#352b20" } : undefined, [readerDisplay, themeTokens, preferences.palette]);
  const readerPaper = pdfTokens ? pdfTokens.paper : readerDisplay.dark ? "#000000" : "#ffffff";
  usePdfPages(book, bookId, frame, loaded, chapter, setError, { dark: readerDisplay.dark, theme: Boolean(pdfTokens) }, pdfTokens);
  useEffect(() => {
    let active = true;
    void window.leaflogue.appearance.describe().then((value) => { if (active) setAppearance(value); }).catch(() => undefined);
    const stop = window.leaflogue.appearance.onChanged((value) => { if (active) setAppearance(value); });
    return () => { active = false; stop(); };
  }, []);
  useEffect(() => {
    const doc = frame.current?.contentDocument;
    if (!loaded || !doc?.getElementById("reader-pages")) return;
    if (book?.format === "pdf") {
      // Paint the iframe canvas itself: transparent body pixels can otherwise
      // expose Chromium's white document backdrop around the fitted PDF.
      const surround = preferences.surround === "app" ? getComputedStyle(document.documentElement).getPropertyValue("--ui-bg") : readerPaper;
      doc.documentElement.style.setProperty("background", surround, "important");
      doc.body.style.setProperty("background", surround, "important");
      return;
    }
    const definition = appearance?.themes.find((theme) => theme.id === appearance.themeId);
    // Chapters swapped in later are coloured the same way.
    colourRef.current = () => applyReaderColors(doc, readerDisplay.dark, readerDisplay.theme ? definition?.[readerDisplay.dark ? "dark" : "light"] : preferences.palette === "sepia" ? pdfTokens : undefined);
    colourRef.current();
    if (preferences.surround === "app") doc.body.style.setProperty("background-color", getComputedStyle(document.documentElement).getPropertyValue("--ui-bg"), "important");
    doc.getElementById("reader-scroll")?.style.setProperty("background-color", readerPaper, "important");
  }, [loaded, appearance, readerDisplay, book?.format, readerPaper, preferences.palette, preferences.surround, pdfTokens]);
  useEffect(() => {
    const doc = frame.current?.contentDocument;
    const definition = appearance?.themes.find((theme) => theme.id === appearance.themeId);
    if (!loaded || !doc || !definition) return;
    const dark = readerDisplay.dark;
    const tokens = definition[dark ? "dark" : "light"];
    const paper = readerPaper;
    const palette = highlightPalette({ ...tokens, paper }, dark);
    let style = doc.getElementById("leaflogue-colour-rules");
    if (!style) { style = doc.createElement("style"); style.id = "leaflogue-colour-rules"; doc.head.append(style); }
    style.textContent = HIGHLIGHT_COLOURS.map((colour) => `::highlight(leaflogue-colour-${colour}){background:${palette[colour].fill};color:${palette[colour].text}}`).join("\n");
  }, [loaded, appearance, readerDisplay, book?.format, readerPaper]);
  const [saved, setSaved] = useState("");
  const [query, setQuery] = useState("");
  const [bookmarks, setBookmarks] = useState<readonly Position[]>([]);
  const [savingBookmark, setSavingBookmark] = useState(false);
  const results = useMemo(() => book ? searchReader(book, query) : [], [book, query]);
  useEffect(() => { setBookmarks(book?.bookmarks ?? []); setQuery(""); }, [book]);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [calibreOpen, setCalibreOpen] = useState(false);
  const [contents, setContents] = useState<BookContents>();
  const [selected, setSelected] = useState<{ text: string; sourceLocation: string; left: number; top: number }>();
  const [addingNote, setAddingNote] = useState(false);
  const [note, setNote] = useState("");
  const [savingHighlight, setSavingHighlight] = useState(false);
  const [localAnchors, setLocalAnchors] = useState<Readonly<Record<string, string>>>({});
  const [review, setReview] = useState<{ id: HighlightId; candidates: ReaderHighlightCandidate[] }>();
  const [savingAnchor, setSavingAnchor] = useState(false);
  useEffect(() => { setLocalAnchors(book?.localAnchors ?? {}); setReview(undefined); }, [book]);
  const [matchStatus, setMatchStatus] = useState({ matched: 0, unmatched: 0 });
  const [shownHighlights, setShownHighlights] = useState<readonly SavedHighlight[]>([]);
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
  // Highlights are placed against the whole book, so counts and the highlights
  // list do not depend on which chapter is on the page.
  const [placed, setPlaced] = useState<readonly { highlight: SavedHighlight; location: ReaderLocation }[]>([]);
  useEffect(() => {
    const highlights = contents?.highlights ?? [];
    const doc = loaded && highlights.length ? annotationDocument(book, frame.current) : undefined;
    const next = book && doc ? highlights.flatMap((highlight) => {
      const location = matchReaderLocation(doc, book, { ...highlight, sourceLocation: localAnchors[highlight.id] ?? highlight.sourceLocation });
      return location ? [{ highlight, location }] : [];
    }) : [];
    setPlaced(next);
    setMatchStatus({ matched: next.length, unmatched: highlights.length - next.length });
    setShownHighlights(next.map((match) => match.highlight));
  }, [book, contents, loaded, localAnchors]);
  useEffect(() => {
    const doc = frame.current?.contentDocument;
    if (!book || !doc || !loaded) return;
    const inner = doc.defaultView as Window & typeof globalThis;
    if (!inner?.CSS?.highlights || !inner.Highlight) return;
    // Only chapters on the page have live ranges to paint.
    const matches = placed.flatMap(({ highlight, location }) => { const range = readerLocationRange(doc, location); return range ? [{ highlight, range }] : []; });
    paintedRanges.current = matches;
    const ranges = matches.map((match) => match.range);
    inner.CSS.highlights.set("leaflogue-saved", new inner.Highlight(...ranges));
    for (const colour of HIGHLIGHT_COLOURS) {
      const coloured = new inner.Highlight(...matches.filter(({ highlight }) => highlightColour(highlight, highlightColours) === colour).map(({ range }) => range));
      coloured.priority = 1; inner.CSS.highlights.set(`leaflogue-colour-${colour}`, coloured);
    }
    refreshNoteMarkers.current();
    return () => { paintedRanges.current = []; inner.CSS.highlights.delete("leaflogue-saved"); for (const colour of HIGHLIGHT_COLOURS) inner.CSS.highlights.delete(`leaflogue-colour-${colour}`); };
  }, [book, placed, loaded, annotationVersion, windowVersion, highlightColours]);
  const options = useRef<HTMLDivElement>(null);
  const jump = useRef<(chapter: number) => void>(() => undefined);
  useEffect(() => { if (optionsOpen) options.current?.focus(); }, [optionsOpen]);
  useEffect(() => {
    if (!optionsOpen || calibreOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !options.current?.getClientRects().length || document.querySelector("dialog[open]")) return;
      const popupOpen = Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).some((node) => node.dataset.state !== "closed" && node.getClientRects().length > 0);
      if (popupOpen) return;
      event.preventDefault(); event.stopPropagation(); setOptionsOpen(false); frame.current?.focus();
    };
    window.addEventListener("keydown", close, true);
    return () => window.removeEventListener("keydown", close, true);
  }, [optionsOpen, calibreOpen]);
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
      setBook(next); setChapter(anchor.current.chapter); setOpenFailure(undefined);
    }).catch((failure: unknown) => { if (active) setOpenFailure(describeOpenFailure(failure)); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [bookId]);
  const visit = (position: Position, length = 0) => {
    const range = goTo.current(position.chapter, (doc) => readerTextRange(doc, position, length));
    if (!range) { setError("This location could not be opened in this edition."); return; }
    setOptionsOpen(false); save.current(position); frame.current?.focus();
  };
  const updateBookmarks = async (next: readonly Position[]) => {
    if (!book || savingBookmark) return;
    setSavingBookmark(true);
    try { setBookmarks(await window.leaflogue.epub!.saveBookmarks(bookId, book.sha256, next)); setSaved("Bookmarks saved"); }
    catch { setError("Your bookmarks could not be saved. Try again."); }
    finally { setSavingBookmark(false); }
  };
  const saveReviewedLocation = async (id: HighlightId, location: string | null) => {
    if (!book || savingAnchor) return;
    setSavingAnchor(true);
    try {
      setLocalAnchors(await window.leaflogue.epub!.saveAnchor(bookId, book.sha256, id, location));
      setReview(undefined); options.current?.focus(); setSaved(location ? "Highlight location confirmed" : "Reviewed location removed");
    } catch { setError("This location could not be saved. Your highlight has not changed."); }
    finally { setSavingAnchor(false); }
  };
  const source = useMemo(() => {
    if (!book) return "";
    const publisherStyles = [...new Set(book.chapters.map((item) => item.styles ?? ""))].join("\n").replace(/<\/style/giu, "<\\/style");
    // EPUB chapters are swapped in one at a time by the layout below; laying out
    // a whole book at once costs hundreds of megabytes for a long novel.
    // PDF pages are small, absolutely placed and shown one at a time already.
    const chapters = book.format === "pdf" ? book.chapters.map((_, index) => chapterMarkup(book, index)).join("") : "";
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
      ${book.format === "pdf" ? `body{padding:12px!important;background:transparent!important}#reader-scroll{max-width:none!important;padding:0!important}#reader-pages{column-width:auto!important;column-count:auto!important;column-gap:0!important;overflow:hidden}#reader-pages>article{display:none;position:absolute;inset:0;padding:0!important;overflow:hidden}#reader-pages .pdf-sheet{position:absolute!important;max-width:none!important;transform-origin:0 0;background:#fff}.pdf-sheet .pdf-page-image{position:absolute;inset:0;width:100%!important;height:100%!important;max-height:none!important;pointer-events:none;object-fit:fill;z-index:0}.pdf-sheet [data-paragraph]{z-index:1;color:transparent!important;cursor:text;user-select:text}.pdf-sheet [data-paragraph]::selection{background:#6699ff88}` : ""}
      </style></head><body data-edition="${escape(book.sha256)}"><main id="reader-scroll"><div id="reader-pages">${chapters}</div></main></body></html>`;
  }, [book]);

  useEffect(() => {
    const doc = frame.current?.contentDocument;
    const view = doc?.getElementById("reader-scroll");
    const content = doc?.getElementById("reader-pages");
    if (!opened || !book || !doc || !view || !content) return;
    const pdf = book.format === "pdf";
    let active = true;
    let spreadPitch = 1; let columnWidth = 0; let columnCount = 1;
    // EPUB: only chapter `rendered` is in the document; `local` is its page.
    // PDF: every page stays in the document and only one is displayed.
    let rendered = -1; let local = 0;
    const estimate = createPageEstimate(book.chapters.map((item) => item.text.length));
    let layoutKey = "";
    const nodes = () => Array.from(content.querySelectorAll<HTMLElement>("[data-paragraph]"));
    if (pdf) tagParagraphs(content);
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
    const pdfLayout = (index: number) => {
      for (const article of content.querySelectorAll<HTMLElement>("article[data-chapter]")) {
        article.style.display = Number(article.dataset.chapter) === index ? "block" : "none";
        const sheet = article.querySelector<HTMLElement>(".pdf-sheet"); if (!sheet) continue;
        const width = Number(sheet.dataset.pdfWidth); const height = Number(sheet.dataset.pdfHeight);
        sheet.style.setProperty("width", `${width}px`, "important"); sheet.style.setProperty("height", `${height}px`, "important");
        const { pdfZoom } = geometry.current;
        const scale = pdfZoom === "page" ? Math.min(view.clientWidth / width, view.clientHeight / height) : pdfZoom === "width" ? view.clientWidth / width : Number(pdfZoom) / 100;
        if (Number(article.dataset.chapter) === index) {
          view.style.overflow = pdfZoom === "page" ? "hidden" : "auto";
          content.style.setProperty("width", `${Math.max(view.clientWidth, width * scale)}px`, "important");
          content.style.setProperty("height", `${Math.max(view.clientHeight, height * scale)}px`, "important");
        }
        sheet.style.transform = `scale(${scale})`; sheet.style.left = `${Math.max(0, (view.clientWidth - width * scale) / 2)}px`; sheet.style.top = `${Math.max(0, (view.clientHeight - height * scale) / 2)}px`;
      }
      view.scrollLeft = 0; view.scrollTop = 0; updateNoteMarkers();
    };
    /** Swap chapter `index` into the page, typeset and coloured like the rest. */
    const render = (index: number) => {
      if (pdf || index === rendered || !book.chapters[index]) return;
      content.innerHTML = chapterMarkup(book, index); tagParagraphs(content);
      rendered = index; local = 0; view.scrollLeft = 0;
      applyReaderTypography(doc, typographyRef.current); colourRef.current();
      setChapter(index); setWindowVersion((value) => value + 1);
      // Publisher fonts first used by this chapter can change its pages once loaded.
      if (doc.fonts?.status === "loading") void doc.fonts.ready.then(() => { if (active && rendered === index) layout(); });
    };
    const pageCount = () => Math.max(1, Math.ceil((content.scrollWidth + GAP) / spreadPitch));
    /** Pages per character from the page shape alone, until a chapter has been measured. */
    const geometricRate = () => {
      const { size, line } = typographyRef.current;
      const lines = Math.max(1, Math.floor((view.clientHeight || 600) / (size * (line || 1.65))));
      const perLine = Math.max(1, Math.floor((columnWidth || 600) / (size * 0.5)));
      return 1 / Math.max(1, lines * perLine * columnCount * 0.85);
    };
    const measure = () => { const pages = pageCount(); measureChapter(estimate, rendered, pages, geometricRate()); return pages; };
    const publish = () => {
      const index = pagesBefore(estimate, rendered) + local; const total = Math.max(index + 1, totalPages(estimate));
      pageRef.current = index; countRef.current = total; setPage(index); setCount(total);
    };
    /** Show page `value` of chapter `index`; Infinity is its last page. */
    const place = (index: number, value: number) => {
      render(index);
      const pages = measure();
      local = Math.max(0, Math.min(pages - 1, value));
      view.scrollLeft = local * spreadPitch;
      publish(); updateNoteMarkers();
    };
    const pageAt = (left: number) => Math.floor((left - content.getBoundingClientRect().left + 1) / spreadPitch);
    const layout = () => {
      if (pdf) { const index = anchor.current.chapter; countRef.current = book.chapters.length; setCount(book.chapters.length); pageRef.current = index; setPage(index); setChapter(index); pdfLayout(index); return; }
      render(Math.max(0, Math.min(book.chapters.length - 1, anchor.current.chapter)));
      if (rendered < 0 || !viewport.current?.clientWidth || !view.clientWidth) return;
      // Lock the CSS column width to the same whole-pixel pitch used for turns.
      // Auto-expanded fractional columns otherwise accumulate drift hundreds of pages in.
      view.style.removeProperty("width");
      const shape = geometry.current;
      const available = Math.max(0, doc.body.clientWidth - shape.horizontal * 2);
      const columns = shape.columns !== "one" && available >= (shape.columns === "two" ? 640 : 1000) ? 2 : 1;
      view.style.setProperty("max-width", `${shape.width * columns}ch`, "important");
      const measured = Math.floor(view.getBoundingClientRect().width);
      columnWidth = Math.floor((measured - GAP * (columns - 1)) / columns); columnCount = columns;
      const width = columns * columnWidth + GAP * (columns - 1);
      view.style.setProperty("width", `${width}px`, "important");
      content.style.setProperty("width", `${width}px`, "important");
      content.style.setProperty("column-width", `${columnWidth}px`, "important");
      content.style.setProperty("column-count", String(columns), "important");
      spreadPitch = columns * (columnWidth + GAP);
      // Page counts only hold for the text settings and page shape they were measured with.
      const shapeKey = JSON.stringify([typographyRef.current, columns, columnWidth, view.clientHeight]);
      if (shapeKey !== layoutKey) { layoutKey = shapeKey; resetPageEstimate(estimate); }
      const target = content.querySelector<HTMLElement>(`[data-chapter="${anchor.current.chapter}"][data-paragraph="${anchor.current.paragraph}"]`);
      place(rendered, target ? pageAt(character(target, anchor.current.offset ?? 0).left) : 0);
    };
    const reset = () => {
      selectionLocked.current = false; setActiveHighlight(undefined); selectedRange.current = undefined; setSelected(undefined); setAddingNote(false); setNote("");
      doc.getSelection()?.removeAllRanges();
      window.dispatchEvent(new CustomEvent("leaflogue:reader-selection", { detail: null }));
      (doc.defaultView as Window & typeof globalThis).CSS?.highlights?.delete("leaflogue-target");
    };
    /** Remember the first character on the page as the reading position. */
    const remember = () => {
      const bounds = view.getBoundingClientRect();
      const first = nodes().find((node) => Array.from(node.getClientRects()).some((rect) => rect.right > bounds.left + 1 && rect.left < bounds.right - 1));
      if (!first) {
        // A page of pictures: keep the position in this chapter so a relayout stays here.
        // Only a chapter with text has a paragraph 0 the saved position can name.
        if (anchor.current.chapter === rendered) return;
        const item = book.chapters[rendered]!;
        if ((item.paragraphs ?? item.text.split("\n\n")).length) save.current({ chapter: rendered, paragraph: 0 });
        else anchor.current = { chapter: rendered, paragraph: 0 };
        return;
      }
      let low = 0; let high = first.textContent?.length ?? 0;
      while (low < high) { const mid = Math.floor((low + high) / 2); if (character(first, mid).right <= bounds.left + 1) low = mid + 1; else high = mid; }
      save.current({ chapter: Number(first.dataset.chapter), paragraph: Number(first.dataset.paragraph), ...(low ? { offset: low } : {}) });
    };
    const showPdf = (value: number) => {
      reset();
      const index = Math.max(0, Math.min(countRef.current - 1, value));
      pageRef.current = index; setPage(index); setChapter(index); pdfLayout(index); save.current({ chapter: index, paragraph: 0 });
    };
    const showPage = (index: number, value: number) => { reset(); place(index, value); remember(); };
    /** Turn within the chapter, or into the next or previous one at its edges. */
    const turnBy = (delta: number) => {
      if (pdf) { showPdf(pageRef.current + delta); return; }
      const next = local + delta; const pages = pageCount();
      if (next >= pages && rendered < book.chapters.length - 1) showPage(rendered + 1, 0);
      else if (next < 0 && rendered > 0) showPage(rendered - 1, Infinity);
      else showPage(rendered, next);
    };
    navigateRange.current = (range) => {
      const inner = doc.defaultView as Window & typeof globalThis;
      if (pdf) {
        const node = range.startContainer.nodeType === 1 ? range.startContainer as Element : range.startContainer.parentElement;
        showPdf(Number(node?.closest("article[data-chapter]")?.getAttribute("data-chapter"))); inner.CSS.highlights.set("leaflogue-target", new inner.Highlight(range)); return;
      }
      const start = range.cloneRange(); start.collapse(true);
      showPage(rendered, pageAt(start.getBoundingClientRect().left));
      inner.CSS.highlights.set("leaflogue-target", new inner.Highlight(range));
    };
    goTo.current = (index, find) => {
      const before = { chapter: rendered, page: local };
      render(index);
      const range = find(doc);
      if (range) navigateRange.current(range);
      else if (before.chapter >= 0) place(before.chapter, before.page);
      return range;
    };
    layoutRef.current = layout;
    setAnnotationVersion((value) => value + 1);
    const observer = new ResizeObserver(layout); observer.observe(viewport.current!);
    void doc.fonts?.ready.then(() => { if (active) layout(); });
    // Pictures decode after the chapter is placed and can add pages to it.
    let settling: ReturnType<typeof setTimeout> | undefined;
    const imageLoaded = () => { clearTimeout(settling); settling = setTimeout(() => { if (active) layout(); }, 50); };
    if (!pdf) content.addEventListener("load", imageLoaded, true);
    const visible = () => Boolean(viewport.current?.clientWidth) && !viewport.current?.closest("[hidden]");
    menu.current = () => { selectionLocked.current = false; setActiveHighlight(undefined); selectedRange.current = undefined; setSelected(undefined); setAddingNote(false); setNote(""); doc.getSelection()?.removeAllRanges(); window.dispatchEvent(new CustomEvent("leaflogue:reader-selection", { detail: null })); setOptionsOpen(true); };
    jump.current = (index) => { if (pdf) showPdf(index); else showPage(index, 0); };
    const key = (event: KeyboardEvent) => {
      if (!visible()) return;
      const action = readerKeyAction(event);
      if (!action) return;
      event.preventDefault();
      if (action === "menu") { const bounds = frame.current!.getBoundingClientRect(); menu.current(bounds.left + bounds.width / 2, bounds.top + 24); return; }
      if (action === "first") { if (pdf) showPdf(0); else showPage(0, 0); }
      else if (action === "last") { if (pdf) showPdf(countRef.current - 1); else showPage(book.chapters.length - 1, Infinity); }
      else turnBy(action === "next" ? 1 : -1);
    };
    window.addEventListener("keydown", key, true); doc.addEventListener("keydown", key, true);
    let accumulated = 0; let lastTurn = 0; let lastEvent = 0;
    const wheel = (event: WheelEvent) => {
      if (!visible() || event.ctrlKey || event.metaKey || (pdf && geometry.current.pdfZoom !== "page")) return;
      event.preventDefault(); const now = performance.now();
      if (now - lastEvent > 180) accumulated = 0; lastEvent = now;
      accumulated += (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? view.clientHeight : 1);
      if (Math.abs(accumulated) >= 40 && now - lastTurn > 350) { turnBy(accumulated > 0 ? 1 : -1); accumulated = 0; lastTurn = now; }
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
        const index = book.chapters.findIndex((item) => item.id === path);
        if (index < 0) return;
        if (pdf) { showPdf(index); return; }
        render(index);
        const article = content.querySelector<HTMLElement>(`article[data-chapter="${index}"]`);
        const destination = id ? Array.from(article?.querySelectorAll<HTMLElement>("[id]") ?? []).find((item) => item.id === id) : article;
        showPage(index, destination ? pageAt(destination.getBoundingClientRect().left) : 0);
        return;
      }
      if (doc.getSelection()?.toString()) return;
      const bounds = view.getBoundingClientRect(); const x = event.clientX - bounds.left;
      if (x >= 0 && x < bounds.width * 0.12) turnBy(-1);
      else if (x > bounds.width * 0.88 && x <= bounds.width) turnBy(1);
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
      if (selectionLocked.current) return;
      const current = doc.getSelection(); const previous = selectedRange.current;
      if (!current?.rangeCount || current.isCollapsed || !previous || previous.compareBoundaryPoints(0, current.getRangeAt(0)) !== 0 || previous.compareBoundaryPoints(2, current.getRangeAt(0)) !== 0) clearSelection();
    };
    doc.addEventListener("selectionchange", selectionChanged);
    doc.addEventListener("wheel", wheel, { passive: false }); doc.addEventListener("click", click); doc.addEventListener("mouseup", selection); doc.addEventListener("keyup", selection);
    return () => { active = false; clearTimeout(settling); content.removeEventListener("load", imageLoaded, true); layoutRef.current = () => undefined; doc.removeEventListener("selectionchange", selectionChanged); doc.removeEventListener("contextmenu", contextMenu); observer.disconnect(); window.removeEventListener("keydown", key, true); doc.removeEventListener("keydown", key, true); doc.removeEventListener("wheel", wheel); doc.removeEventListener("click", click); doc.removeEventListener("mouseup", selection); doc.removeEventListener("keyup", selection); };
  }, [book, opened, loaded]);

  // Typography first, then layout: each runs only for the preferences it uses.
  useEffect(() => {
    const doc = frame.current?.contentDocument;
    if (!opened || !book || book.format === "pdf" || !doc?.getElementById("reader-pages")) return;
    applyReaderTypography(doc, typography);
  }, [book, opened, loaded, typography]);
  useEffect(() => { layoutRef.current(); }, [book, opened, loaded, typography, preferences.width, preferences.columns, pdfZoom]);

  useEffect(() => {
    const doc = frame.current?.contentDocument;
    if (!target || !active || !book || !contents || !loaded || !annotationVersion || !doc?.getElementById("reader-pages") || !viewport.current?.clientWidth || handledTarget.current === target.requestId) return;
    handledTarget.current = target.requestId;
    const highlight = contents.highlights.find((highlight) => highlight.id === target.highlightId);
    const whole = annotationDocument(book, frame.current);
    const location = highlight && whole ? matchReaderLocation(whole, book, { ...highlight, sourceLocation: localAnchors[highlight.id] ?? highlight.sourceLocation }) : undefined;
    const range = location && goTo.current(location.chapter, (live) => readerLocationRange(live, location));
    if (!range) { setError(highlight ? "This highlight could not be uniquely matched to the attached EPUB. It may belong to a different edition." : "This highlight is no longer in your library."); return; }
    setError(""); setOptionsOpen(false);
    frame.current?.contentWindow?.focus();
  }, [target, active, book, contents, loaded, annotationVersion, localAnchors]);

  function clearSelection() {
    selectionLocked.current = false; setActiveHighlight(undefined); selectedRange.current = undefined; setSelected(undefined); setAddingNote(false); setNote(""); setNote("");
    frame.current?.contentDocument?.getSelection()?.removeAllRanges();
    window.dispatchEvent(new CustomEvent("leaflogue:reader-selection", { detail: null }));
  }
  async function createHighlight(explain = false) {
    if (!selected || savingHighlight || contents?.book.archived) return;
    if (explain) selectionLocked.current = true;
    if (explain && !await confirm({ title: "Save and explain this selection?", message: "This saves the selected text as a library highlight, which can sync to your connected devices, then opens the Assistant. The Assistant uses your configured AI provider and its existing consent settings.", confirmLabel: "Save & explain" })) { selectionLocked.current = false; return; }
    setSavingHighlight(true); setError("");
    try {
      const doc = annotationDocument(book, frame.current);
      const existing = contents?.highlights.find((highlight) => normalizedQuote(highlight.text) === normalizedQuote(selected.text) && (
        highlight.sourceLocation === selected.sourceLocation || (doc && book && matchReaderHighlight(doc, book, { ...highlight, sourceLocation: localAnchors[highlight.id] ?? highlight.sourceLocation }))
      ));
      let explained = existing;
      if (existing) {
        if (note.trim()) await window.leaflogue.library.createNote({ bookId, highlightId: existing.id, markdown: note.trim() });
      } else {
        explained = await window.leaflogue.library.createHighlight({ bookId, text: selected.text, sourceLocation: selected.sourceLocation, ...(note.trim() ? { noteMarkdown: note.trim() } : {}) });
      }
      window.dispatchEvent(new Event("leaflogue:annotations-changed"));
      clearSelection();
      if (explain && explained) onExplain?.(explained, false);
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
  useEffect(() => {
    if (activeHighlight?.keyboard) { keyboardHighlight.current = true; if (!activeHighlight.note) highlightActions.current?.focus(); return; }
    if (!activeHighlight && keyboardHighlight.current) { keyboardHighlight.current = false; if (!optionsOpen) frame.current?.focus(); }
  }, [activeHighlight, optionsOpen]);
  /** Keyboard route to a saved highlight: show its page, then open its actions. */
  function openHighlight(id: HighlightId) {
    const match = placed.find((item) => item.highlight.id === id);
    if (!match) return;
    setOptionsOpen(false);
    const range = goTo.current(match.location.chapter, (doc) => readerLocationRange(doc, match.location));
    if (!range) return;
    const rect = range.getBoundingClientRect(); const bounds = frame.current?.getBoundingClientRect();
    setSelected(undefined); setNote("");
    setActiveHighlight({ id, keyboard: true, left: Math.max(8, Math.min((bounds?.left ?? 0) + rect.left, window.innerWidth - 344)), top: Math.max(8, Math.min((bounds?.top ?? 0) + rect.bottom + 8, window.innerHeight - 160)) });
  }
  async function unlink() {
    const calibreLinked = book?.calibre ?? openFailure?.calibre ?? false;
    const message = `This removes the link to this book file on this device, along with your reading position, bookmarks and reviewed highlight locations for it${calibreLinked ? ", and its Calibre link" : ""}. Your original file, the book, its highlights and notes stay in place.`;
    if (!window.leaflogue.epub?.unlink || !await confirm({ title: "Unlink this book file?", message, confirmLabel: "Unlink file" })) return;
    try { await window.leaflogue.epub.unlink(bookId); setBook(undefined); setOpenFailure(undefined); setError(""); setOptionsOpen(false); setActiveHighlight(undefined); setNoteMarkers([]); }
    catch { setError("The book file link could not be removed."); }
  }
  /** Find a moved file. The same edition relinks silently; another edition needs the reader's agreement. */
  async function locate() {
    const epub = window.leaflogue.epub;
    if (!epub?.relocate) return;
    setBusy(true); setError("");
    try {
      let result = await epub.relocate(bookId);
      if (result.status === "different-edition") {
        if (!await confirm({ title: "Link a different edition?", message: "This looks like a different edition; your place and highlight locations may shift. Bookmarks that are not in this file are removed.", confirmLabel: "Link this file" })) return;
        result = await epub.relocate(bookId, true);
      }
      if (result.status === "relinked") {
        anchor.current = result.document.position; setBook(result.document); setChapter(result.document.position.chapter);
        setOpenFailure(undefined); setOpened(true); setSaved("Book file found");
      }
    } catch (failure) { setError(`The book file could not be linked. ${describeOpenFailure(failure).detail}`); }
    finally { setBusy(false); }
  }
  async function attach() {
    setBusy(true); setError("");
    try { const next = await window.leaflogue.epub!.attach(bookId); if (next) { anchor.current = next.position; setBook(next); setChapter(0); setOpened(true); } }
    catch (failure) { setError(describeOpenFailure(failure).detail || "The book file could not be linked."); } finally { setBusy(false); }
  }
  if (!window.leaflogue.epub) return null;
  return <section className={styles.reader} aria-label={book?.format === "pdf" ? "Local PDF reader" : "Local EPUB reader"}>
    {confirmDialog}
    {!book && openFailure && <div role="group" aria-label="Book file problem" className={styles.failure}>
      <InlineError>{openFailure.kind === "unknown" ? "This book file could not be opened." : FAILURES[openFailure.kind]}</InlineError>
      <p className="ll-muted">{openFailure.calibre ? "Reconnect it from Calibre to keep reading, or unlink it and link the book again." : "Locate the file to keep reading. If it is the same edition, your place, bookmarks and highlight locations are kept."}</p>
      <div className={styles.pageActions}>
        {openFailure.calibre ? window.leaflogue.calibre && <button className="ll-button" onClick={() => setCalibreOpen(true)}>Reconnect from Calibre</button> : window.leaflogue.epub.relocate && <button className="ll-button" disabled={busy} onClick={() => void locate()}>Locate file…</button>}
        {window.leaflogue.epub.unlink && <button className="ll-button-secondary" disabled={busy} onClick={() => void unlink()}>Unlink book file</button>}
      </div>
      {openFailure.detail && <details className={styles.readerTools}><summary>Technical details</summary><p className="ll-muted">{openFailure.detail}</p></details>}
    </div>}
    {!book && !openFailure && <><p className="ll-muted">{target ? "Link a book file to find this highlight in its original context." : "Link an EPUB or PDF to read it here."} The file stays in its original location.</p><button className="ll-button-secondary" disabled={busy} onClick={attach}>{busy ? "Checking for book file…" : "Attach book file"}</button>{window.leaflogue.calibre && <button className="ll-button-secondary" onClick={() => setCalibreOpen(true)}>Link from Calibre</button>}<p className="ll-muted">Book files are not included in library backups.</p></>}
    {error && <InlineError>{error}</InlineError>}
    {book && !embedded && <button className="ll-button-secondary" onClick={() => setOpened(!opened)}>{opened ? "Close reader" : "Read EPUB"}</button>}
    {calibreOpen && <div className={styles.overlay}><div role="dialog" aria-label="Calibre library" className={styles.options} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setCalibreOpen(false); } }}><CalibrePicker bookId={bookId} title={contents?.book.title ?? ""} onClose={() => setCalibreOpen(false)} onLinked={(next) => { anchor.current = next.position; setBook(next); setChapter(next.position.chapter); setCalibreOpen(false); setOptionsOpen(false); setOpened(true); setError(""); setOpenFailure(undefined); }} /></div></div>}
    {opened && book && <>
      <div className={styles.viewport} ref={viewport} style={{ background: preferences.surround === "app" ? "var(--ui-bg)" : readerPaper }} role="region" aria-label="Book pages" onContextMenu={(event) => { event.preventDefault(); menu.current(event.clientX, event.clientY); }}>
        <iframe ref={frame} className={styles.frame} title={book.format === "pdf" ? "PDF pages" : "EPUB pages"} sandbox="allow-same-origin" srcDoc={source} onLoad={() => setLoaded((value) => value + 1)} />
      </div>
      {!optionsOpen && !calibreOpen && active && noteMarkers.map((marker) => <button key={marker.id} className={styles.noteMarker} aria-label={marker.label} title={marker.label} style={{ left: marker.left, top: marker.top }} onClick={() => { setSelected(undefined); setActiveHighlight({ id: marker.id, left: Math.min(marker.left, window.innerWidth - 344), top: marker.top }); }}><Icon name="note-paper" size={15} aria-hidden="true" /></button>)}
      {activeHighlight && activePassage && !optionsOpen && <div ref={highlightActions} tabIndex={-1} data-reader-selection role="dialog" aria-label="Saved highlight actions" className={styles.selection} style={{ left: activeHighlight.left, top: Math.min(activeHighlight.top, window.innerHeight - (activeHighlight.note ? 280 : 160)) }} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setActiveHighlight(undefined); } }}>
        {activeHighlight.note ? <><label className="ll-label">Note<textarea autoFocus className="ll-field" rows={3} maxLength={10000} value={note} onChange={(event) => setNote(event.target.value)} /></label><button className="ll-button" disabled={savingHighlight || !note.trim()} onClick={() => void noteActiveHighlight()}>Save note</button></> : <>
          <HighlightColourPicker highlight={activePassage} /><p className={styles.activeExcerpt}>{activePassage.text.length > 100 ? `${activePassage.text.slice(0, 100)}…` : activePassage.text}</p>
          {activePassage.notes.length > 0 && <div className={styles.activeNotes}>{activePassage.notes.map((note) => <MarkdownText key={note.id} text={note.markdown} />)}</div>}
          {onExplain && <button className="ll-button-secondary" onClick={() => { clearSelection(); onExplain(activePassage, contents?.book.archived ?? false); }}>Explain this passage</button>}
          <button className="ll-button-secondary" onClick={() => { onOpenInBook?.(activePassage.id); setActiveHighlight(undefined); }}>Open in book</button>
          {!contents?.book.archived && <><button className="ll-button-secondary" onClick={() => { setNote(""); setActiveHighlight((value) => value ? { ...value, note: true } : value); }}>Add note</button><button className="ll-button-secondary" onClick={() => void removeActiveHighlight()}>Remove highlight</button></>}
        </>}
        <button className="ll-button-secondary" onClick={() => setActiveHighlight(undefined)}>Cancel</button>
      </div>}
      {selected && !optionsOpen && <div data-reader-selection className={styles.selection} role={addingNote ? "dialog" : "toolbar"} aria-label={addingNote ? "Note for selected text" : "Selected text actions"} style={{ left: selected.left, top: Math.max(8, Math.min(selected.top, window.innerHeight - (addingNote ? 280 : 80))) }} onMouseDown={(event) => { if (!addingNote) event.preventDefault(); }} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); clearSelection(); } }}>
        {addingNote ? <><label className="ll-label">Note<textarea autoFocus className="ll-field" rows={3} maxLength={10000} value={note} onChange={(event) => setNote(event.target.value)} /></label><button className="ll-button" disabled={savingHighlight} onClick={() => void createHighlight()}>Save highlight and note</button></> : <>
          {!contents?.book.archived && <><button className="ll-button-secondary" disabled={savingHighlight} onClick={() => void createHighlight()}>{savingHighlight ? "Saving…" : "Highlight"}</button><button className="ll-button-secondary" onClick={() => { selectionLocked.current = true; setAddingNote(true); }}>Add note</button></>}
          {onExplain && !contents?.book.archived && <button className="ll-button-secondary" disabled={savingHighlight} onClick={() => void createHighlight(true)}>Save &amp; explain</button>}
          {/^[\p{L}][\p{L}\p{M}'’-]{0,59}$/u.test(selected.text) && <button className="ll-button-secondary" onClick={() => { window.dispatchEvent(new CustomEvent("leaflogue:reader-define", { detail: selected.text })); clearSelection(); }}>Define</button>}
        </>}
        <button className="ll-button-secondary" disabled={savingHighlight} onClick={clearSelection}>Cancel</button>
      </div>}
      {optionsOpen && !calibreOpen && <div className={styles.overlay} onClick={(event) => { if (event.target === event.currentTarget) setOptionsOpen(false); }}>
        <div ref={options} role="dialog" aria-label="Reader options" tabIndex={-1} className={styles.options} onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOptionsOpen(false); frame.current?.focus(); }
          if (event.key === "Tab") {
            const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea,summary,a[href],[tabindex="0"]')).filter((node) => node.getClientRects().length > 0);
            const first = controls[0]; const last = controls.at(-1);
            if (first && last && (event.target === event.currentTarget || (event.shiftKey ? event.target === first : event.target === last))) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
          }
        }}>
          <div className={styles.optionHeading}><div><p className="ui-label">Reader</p><h2>{contents?.book.title ?? "Reading"}</h2></div><button className="ll-icon-button" aria-label="Close reader options" onClick={() => { setOptionsOpen(false); frame.current?.focus(); }}><Icon name="close" size={17} aria-hidden="true" /></button></div>
          <div role="tablist" aria-label="Reader settings" className={styles.preferenceTabs}>{READER_TABS.map((tab) => <button key={tab} id={`reader-tab-${tab}`} role="tab" aria-selected={optionsTab === tab} aria-controls="reader-preferences-panel" tabIndex={optionsTab === tab ? 0 : -1} onClick={() => setOptionsTab(tab)} onKeyDown={(event) => {
            const index = READER_TABS.indexOf(tab);
            const next = event.key === "ArrowRight" ? (index + 1) % READER_TABS.length : event.key === "ArrowLeft" ? (index + READER_TABS.length - 1) % READER_TABS.length : event.key === "Home" ? 0 : event.key === "End" ? READER_TABS.length - 1 : -1;
            if (next < 0) return; event.preventDefault(); setOptionsTab(READER_TABS[next]!); document.getElementById(`reader-tab-${READER_TABS[next]}`)?.focus();
          }}>{tab}</button>)}</div>
          <div role="tabpanel" id="reader-preferences-panel" aria-labelledby={`reader-tab-${optionsTab}`} className={styles.preferencePanel}>
          <ReaderPreferenceControls tab={optionsTab} pdf={book.format === "pdf"} preferences={preferences} onChange={updatePreferences} override={override} onOverride={setOverride} savedBookSettings={savedBookSettings} onForgetBookSettings={forgetBookSettings} presets={presets} onSavePreset={savePreset} onRemovePreset={removePreset} />
          <div hidden={optionsTab !== "Book"}>
          <div className={styles.progress}><span>Page {page + 1} of {count}</span><span>{Math.round((page + 1) / count * 100)}%</span></div><progress className={styles.progressBar} value={page + 1} max={count} aria-label="Reading progress" />
          <label className="ll-label">Contents<Select aria-label="Chapter" value={String(chapter)} onValueChange={(value) => { jump.current(Number(value)); setOptionsOpen(false); }}>{book.chapters.map((item, index) => <SelectItem value={String(index)} key={item.id}>{index + 1}. {item.title}</SelectItem>)}</Select></label>
          <details className={styles.readerTools}>
            <summary>Search this book</summary>
            <label className="ll-label">Find text<input className="ll-input" type="search" aria-label="Search this book" value={query} maxLength={200} onChange={(event) => setQuery(event.target.value)} /></label>
            {query.trim() && <p role="status" className="ll-muted">{results.length === 100 ? "First 100 matches — narrow your search for more" : `${results.length} matches`}</p>}
            <ol className={styles.locationList}>{results.map((result) => <li key={`${result.chapter}:${result.paragraph}:${result.offset}`}><button className="ll-button-secondary" onClick={() => visit(result, result.length)}><strong>{book.chapters[result.chapter]?.title}</strong><span>{result.excerpt}</span></button></li>)}</ol>
          </details>
          <details className={styles.readerTools}>
            <summary>Bookmarks ({bookmarks.length})</summary>
            <p className="ll-muted">Saved on this device for this edition.</p>
            <button className="ll-button-secondary" disabled={savingBookmark || bookmarks.length >= 500} onClick={() => {
              const current = { ...anchor.current };
              if (bookmarks.some((item) => item.chapter === current.chapter && item.paragraph === current.paragraph && (item.offset ?? 0) === (current.offset ?? 0))) { setSaved("This location is already bookmarked"); return; }
              void updateBookmarks([...bookmarks, current]);
            }}>Bookmark this location</button>
            {!bookmarks.length && <p className="ll-muted">No bookmarks yet.</p>}
            <ol className={styles.locationList}>{bookmarks.map((item, index) => <li key={`${item.chapter}:${item.paragraph}:${item.offset ?? 0}`}><button className="ll-button-secondary" onClick={() => visit(item)}><strong>{book.chapters[item.chapter]?.title}</strong><span>{(book.chapters[item.chapter]?.paragraphs ?? book.chapters[item.chapter]?.text.split("\n\n"))?.[item.paragraph]?.slice(item.offset ?? 0, (item.offset ?? 0) + 100)}</span></button><button className="ll-button-secondary" disabled={savingBookmark} aria-label={`Remove bookmark ${index + 1}`} onClick={() => void updateBookmarks(bookmarks.filter((_, i) => i !== index))}>Remove</button></li>)}</ol>
          </details>
          {book.format === "pdf" && <><label className="ll-label">Zoom<Select aria-label="PDF zoom" value={pdfZoom} onValueChange={setPdfZoom}><SelectItem value="page">Fit page</SelectItem><SelectItem value="width">Fit width</SelectItem>{[100, 150, 200].map((value) => <SelectItem key={value} value={String(value)}>{value}%</SelectItem>)}</Select></label><p className="ll-muted">PDF pages keep their original layout.</p></>}
          <details className={styles.readerTools}>
            <summary>Highlights in this book ({matchStatus.matched})</summary>
            <p className="ll-muted">Choose a highlight to go to it and open its actions.</p>
            {!matchStatus.matched && <p className="ll-muted">No saved highlights are shown in this book yet.</p>}
            <ol className={styles.locationList} aria-label="Highlights in this book">{shownHighlights.map((highlight) => <li key={highlight.id}><button className="ll-button-secondary" onClick={() => openHighlight(highlight.id)}><span>{highlight.text.length > 140 ? `${highlight.text.slice(0, 140)}…` : highlight.text}</span>{highlight.notes.length > 0 && <small>{highlight.notes.length} note{highlight.notes.length === 1 ? "" : "s"}</small>}</button></li>)}</ol>
          </details>
          <details className={styles.readerTools}>
            <summary>Review highlight locations</summary>
            <p className="ll-muted">Choose a passage and confirm where it belongs. Your imported text, source location and notes stay unchanged. Reviews stay on this device.</p>
            <ol className={styles.locationList}>{(contents?.highlights ?? []).map((highlight) => <li key={highlight.id}><button className="ll-button-secondary" onClick={() => {
              const doc = annotationDocument(book, frame.current);
              if (doc) setReview({ id: highlight.id, candidates: readerHighlightCandidates(doc, book, highlight.text) });
            }}><span>{highlight.text.slice(0, 140)}</span>{localAnchors[highlight.id] && <small>Location reviewed</small>}</button></li>)}</ol>
            {review && <div role="group" aria-label="Matching locations">
              <p role="status">{review.candidates.length === 100 ? "First 100 locations" : `${review.candidates.length} matching locations`}</p>
              {!review.candidates.length && <p className="ll-muted">No exact text match in this edition, allowing whitespace and quotation-mark differences. Your passage is kept in the library.</p>}
              <ol className={styles.locationList}>{review.candidates.map((candidate) => <li key={candidate.location}><div><strong>{book.chapters[candidate.chapter]?.title}</strong><p>{candidate.excerpt}</p><button className="ll-button-secondary" onClick={() => { const location = parseReaderLocation(candidate.location); if (location) goTo.current(location.chapter, (doc) => readerLocationRange(doc, location)); setOptionsOpen(false); }}>Preview location</button><button className="ll-button-secondary" disabled={savingAnchor} onClick={() => void saveReviewedLocation(review.id, candidate.location)}>Use this location</button></div></li>)}</ol>
              {localAnchors[review.id] && <button className="ll-button-secondary" disabled={savingAnchor} onClick={() => void saveReviewedLocation(review.id, null)}>Reset reviewed location</button>}
            </div>}
          </details>
          <p className="ll-muted">{matchStatus.matched} highlights shown{matchStatus.unmatched ? ` · ${matchStatus.unmatched} could not be matched to this edition` : ""}</p>
          {window.leaflogue.calibre && <button className="ll-button-secondary" onClick={() => setCalibreOpen(true)}>Manage Calibre link</button>}
          {window.leaflogue.epub?.unlink && <button className="ll-button-secondary" onClick={() => void unlink()}>Unlink book file</button>}
          <details className={styles.shortcuts}><summary>Keyboard shortcuts</summary><dl><dt>Next page</dt><dd>→ / Space / Page Down</dd><dt>Previous page</dt><dd>← / Shift+Space / Page Up</dd><dt>Reader options</dt><dd>Shift+F10</dd></dl></details>
          </div></div>
        </div>
      </div>}
      {(preferences.progress || preferences.chapter || preferences.clock) && <div className={styles.readingInfo} aria-label="Reading information">
        {preferences.chapter && <span>{book.chapters[chapter]?.title}</span>}
        {preferences.progress && <span>{page + 1} / {count} · {Math.round((page + 1) / count * 100)}%</span>}
        {preferences.clock && <time>{clock.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>}
      </div>}
      <span className="sr-only" role="status">Page {page + 1} of {count}. {saved}</span>
    </>}
  </section>;
}
