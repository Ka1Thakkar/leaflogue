import { MultiSelect, type MultiSelectProps } from "@leaflogue/ui";
import { Component, createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { ArrowLeft, ChevronDown, ChevronUp, SlidersHorizontal, StickyNote, X, type AppIcon as LucideIcon } from "../components/icons";
import type { Book, ReadingStatus, ResolvedCoverImage } from "@leaflogue/contracts";
import { MarkdownText, PlainText } from "./MarkdownText";
import styles from "./knowledge.module.css";

export const authorsLabel = (authors: readonly string[]) => authors.join(", ") || "Author unknown";

/** "1 book", "2 books": every noun here pluralises by adding an s. */
export const countOf = (count: number, noun: string) => `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;

/** A failed action's message, announced at once; renders nothing when empty. */
export function InlineError({ children }: { readonly children?: ReactNode }) {
  return children ? <p role="alert" className="ll-inline-error">{children}</p> : null;
}

export function statusLabel(status: ReadingStatus): string {
  return status === "reading" ? "Reading" : status === "finished" ? "Finished" : status === "paused" ? "Paused" : "Unread";
}

/** Opens the shared import tool laid over whichever page is showing. */
const ImportDialogContext = createContext<(() => void) | null>(null);
export const ImportDialogProvider = ImportDialogContext.Provider;

export function useImportDialog(): () => void {
  const open = useContext(ImportDialogContext);
  if (!open) throw new Error("useImportDialog must be used inside the application shell");
  return open;
}

export function ImportTrigger({ children = "Import", className }: { readonly children?: ReactNode; readonly className?: string }) {
  const open = useImportDialog();
  return <button type="button" className={className} onClick={open}>{children}</button>;
}

/** Lets a page name itself as the last step of the header's breadcrumb, such as a book's title. */
const CrumbContext = createContext<((label: string | undefined) => void) | null>(null);
export const CrumbProvider = CrumbContext.Provider;

export function useCrumb(label: string | undefined): void {
  const set = useContext(CrumbContext);
  useEffect(() => {
    if (!set) return;
    set(label);
    return () => set(undefined);
  }, [set, label]);
}

/** The one loading line: announced politely, muted, always an ellipsis. */
export function Loading({ children }: { readonly children: ReactNode }) {
  return <p role="status" className="ll-muted">{children}</p>;
}

/** An empty or missing state: a heading, an optional line, and any actions. */
export function Empty({ title, children, level: Heading = "h2" }: { readonly title: string; readonly children?: ReactNode; readonly level?: "h2" | "h3" }) {
  return <div className="ll-empty"><Heading>{title}</Heading>{children}</div>;
}

class PageBoundary extends Component<{ readonly children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    if (this.state.failed) {
      return (
        <div className="ll-empty" role="alert">
          <h2>Unable to open your library</h2>
          <p className="ll-muted">Leaflogue could not read this page. Your saved reading is unchanged.</p>
          <button className="ll-button-secondary" onClick={() => this.setState({ failed: false })}>Try again</button>
        </div>
      );
    }
    return this.props.children;
  }
}

/** The button that reveals a page's secondary filters, with how many are active. */
export function FilterToggle({ open, count, controls, onToggle }: {
  readonly open: boolean;
  readonly count: number;
  readonly controls: string;
  readonly onToggle: () => void;
}) {
  return (
    <button type="button" className="ll-button-secondary ll-filter-toggle" aria-expanded={open} aria-controls={controls} onClick={onToggle}>
      <SlidersHorizontal size={16} aria-hidden="true" />Filters
      {count > 0 && <span className="ll-filter-count" aria-label={`${count} active`}>{count}</span>}
    </button>
  );
}

/**
 * The top of every page: one title size and position, one way back, one place
 * for the page's actions, so moving between pages never shifts the layout.
 */
export function PageHeader({ title, subtitle, back, actions }: {
  readonly title: string;
  readonly subtitle?: ReactNode;
  readonly back?: { readonly href: string; readonly label: string };
  readonly actions?: ReactNode;
}) {
  return (
    <header className="ll-page-header">
      <div className="ll-page-heading">
        {back && (
          <a href={back.href} className="ll-icon-button" aria-label={back.label} title={back.label}>
            <ArrowLeft size={20} aria-hidden="true" />
          </a>
        )}
        <div>
          <h1 className="ll-title">{title}</h1>
          {subtitle && <div className="ll-page-subtitle">{subtitle}</div>}
        </div>
      </div>
      {actions && <div className="ll-page-actions">{actions}</div>}
    </header>
  );
}

export function Page({ children }: { readonly children: ReactNode }) {
  return <main className="ll-page"><PageBoundary>{children}</PageBoundary></main>;
}

export function Dialog({
  label,
  title,
  children,
  secondary = false,
  icon: Icon,
  iconOnly = false,
  disabled = false,
  triggerClassName,
  presentation = "modal",
  triggerRef,
}: {
  readonly label: string;
  readonly title: string;
  readonly children: (close: () => void) => ReactNode;
  readonly secondary?: boolean;
  readonly icon?: LucideIcon;
  readonly iconOnly?: boolean;
  readonly disabled?: boolean;
  /** Replaces the trigger button's look, e.g. to sit in a menu as a labelled row. */
  readonly triggerClassName?: string;
  /** A reading companion occupies the page edge; forms keep the compact modal. */
  readonly presentation?: "modal" | "sidebar";
  /** Lets a palette command open this dialog as if its button were pressed. */
  readonly triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const ownTrigger = useRef<HTMLButtonElement>(null);
  const trigger = triggerRef ?? ownTrigger;
  const [open, setOpen] = useState(false);
  const id = useId();
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={triggerClassName ?? (iconOnly ? "ll-icon-button" : secondary ? "ll-button-secondary" : "ll-button")}
        aria-label={label}
        title={label}
        disabled={disabled}
        onClick={() => {
          // Open before the contents mount: a browser refuses focus inside a
          // closed dialog, so a form's autoFocus field would otherwise be
          // skipped in favour of the close button.
          if (ref.current && !ref.current.open) ref.current.showModal();
          setOpen(true);
        }}
      >
        {Icon && <Icon size={18} aria-hidden="true" />}
        {!iconOnly && label}
      </button>
      <dialog
        ref={ref}
        className={presentation === "sidebar" ? "ui-companion" : `ll-dialog ${styles.dialog}`}
        aria-labelledby={id}
        onClose={() => {
          setOpen(false);
          trigger.current?.focus();
        }}
      >
        <div className={presentation === "sidebar" ? "ui-companion-heading" : styles.dialogHeading}>
          <h2 id={id}>{title}</h2>
          <button type="button" className="ll-icon-button" onClick={close} aria-label="Close dialog" title="Close dialog">
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        {open && (presentation === "sidebar"
          ? <div className="ui-companion-body">{children(close)}</div>
          : children(close))}
      </dialog>
    </>
  );
}

export function Cover({ book, onAccent }: {
  readonly book: Pick<Book, "title" | "authors" | "coverUrl">;
  readonly onAccent?: (accent: string | undefined) => void;
}) {
  const [resolved, setResolved] = useState<ResolvedCoverImage>();
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  const coverElement = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = coverElement.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "240px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let active = true;
    let pending = false;
    setResolved(undefined);
    onAccent?.(undefined);
    if (!book.coverUrl || !visible) return () => { active = false; };
    const requestId = crypto.randomUUID();
    pending = true;
    void window.leaflogue.covers.resolve(book.coverUrl, requestId).then((cover) => {
      pending = false;
      if (!active || !cover) return;
      setResolved(cover);
      onAccent?.(cover.accent);
    }, () => { pending = false; });
    return () => {
      active = false;
      if (pending) void window.leaflogue.covers.cancel(requestId).catch(() => undefined);
    };
  }, [book.coverUrl, onAccent, visible]);
  return (
    <div ref={coverElement} className={`ll-book-cover ${styles.cover}`}>
      {resolved ? (
        <img src={resolved.url} alt={`Cover of ${book.title}`} onError={() => {
          setResolved(undefined);
          onAccent?.(undefined);
        }} />
      ) : (
        <div className={`ll-book-placeholder ${styles.cloth}`}>
          <span className="font-reader">{book.title}</span>
          <small>{authorsLabel(book.authors)}</small>
        </div>
      )}
    </div>
  );
}

export function PassageText({
  text,
  note = false,
  generated = false,
}: {
  readonly text: string;
  readonly note?: boolean;
  readonly generated?: boolean;
}) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  // A note is the reader's Markdown; a passage is the book's own words.
  const Text = note ? MarkdownText : PlainText;
  useEffect(() => {
    const element = ref.current;
    if (!element || expanded || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setOverflows(element.scrollHeight > element.clientHeight + 1);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, expanded]);
  return (
    <div className={note ? styles.note : styles.quoteBody}>
      {note && (
        <p className={styles.noteLabel}>
          <StickyNote size={13} aria-hidden="true" />
          {generated ? "AI note" : "Note"}
        </p>
      )}
      <Text
        ref={ref}
        id={id}
        className={`${note ? `${styles.noteText} ${generated ? styles.generatedNoteText : ""}` : `font-reader ${styles.quote}`} ${!expanded ? styles.clamped : ""}`}
        text={text}
      />
      {(overflows || expanded) && (
        <button
          type="button"
          className={styles.expand}
          aria-label={`Show ${expanded ? "less" : "more"} of this ${note ? "note" : "passage"}`}
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show less" : "Show more"}
          {expanded ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
        </button>
      )}
    </div>
  );
}

export function SearchableMultiSelect<T extends string>(props: Omit<MultiSelectProps<T>, "formatError">) {
  return <MultiSelect {...props} />;
}
