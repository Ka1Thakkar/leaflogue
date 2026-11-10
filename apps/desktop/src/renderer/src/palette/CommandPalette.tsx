import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { MAX_HIGHLIGHT_SEARCH_LENGTH, type HighlightListEntry } from "@leaflogue/contracts";
import { Icon } from "@leaflogue/ui";
import { aiAvailable } from "./actions";
import { usePageCommands } from "./commands";
import { fuzzyScore } from "./fuzzy";
import { actionItems, bookItems, EMPTY_SOURCES, GROUPS, organizationItems, pageItems, passageItems, recentItem, searchAllItem, settingItems, type GroupName, type PaletteItem, type PaletteSources, type ShellState } from "./items";
import { readMemory, remember, usageBoost } from "./recent";
import styles from "./palette.module.css";

/** Typed first, these narrow the palette to one kind of thing. */
export const PREFIXES = [
  { prefix: ">", label: "actions" },
  { prefix: "#", label: "tags" },
  { prefix: "@", label: "authors" },
  { prefix: "/", label: "pages and settings" },
] as const;
type Prefix = (typeof PREFIXES)[number]["prefix"];

function parse(input: string): { readonly prefix?: Prefix; readonly text: string } {
  const first = input.trimStart()[0];
  const match = PREFIXES.find(({ prefix }) => prefix === first);
  return match ? { prefix: match.prefix, text: input.trimStart().slice(1).trim() } : { text: input.trim() };
}

const PREFIX_GROUPS: Readonly<Record<Prefix, readonly GroupName[]>> = {
  ">": ["This page", "Actions"],
  "#": ["Tags"],
  "@": ["Books"],
  "/": ["Pages", "Settings"],
};

/** How many of each group show while searching everything; a prefix shows them all. */
const CAPS: Partial<Record<GroupName, number>> = { Books: 6, Tags: 4, Threads: 4, Collections: 4, Pages: 5, Settings: 6, Actions: 8, "This page": 8 };
/** Where the library's own search results sit among the fuzzy matches. */
const PASSAGE_SCORE = 52;
const DEBOUNCE_MS = 140;
const PASSAGE_LIMIT = 8;
const TABBABLE = "a[href], button:not(:disabled), input:not(:disabled):not([type='hidden']), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex='-1'])";

interface Group {
  readonly name: GroupName;
  readonly items: readonly PaletteItem[];
}

async function loadSources(): Promise<PaletteSources> {
  const [books, tags, collections, threads, readers, ai, appearance] = await Promise.allSettled([
    window.leaflogue.library.listBooks({ includeArchived: true }),
    window.leaflogue.organization.listTags(),
    window.leaflogue.organization.listCollections(),
    window.leaflogue.threads.list(),
    window.leaflogue.imports.listReaders(),
    window.leaflogue.ai.describe(),
    window.leaflogue.appearance.describe(),
  ]);
  const value = <T,>(result: PromiseSettledResult<T>, fallback: T): T => result.status === "fulfilled" ? result.value ?? fallback : fallback;
  return {
    books: value(books, []),
    tags: value(tags, []),
    collections: value(collections, []),
    threads: value(threads, []),
    readers: value(readers, []),
    ai: aiAvailable(value(ai, undefined)),
    ...(appearance.status === "fulfilled" && appearance.value ? { appearance: appearance.value } : {}),
  };
}

function rank(items: readonly PaletteItem[], text: string, field: "author" | undefined, uses: ReturnType<typeof readMemory>["uses"]): { item: PaletteItem; score: number }[] {
  const ranked: { item: PaletteItem; score: number }[] = [];
  for (const item of items) {
    const score = field === "author"
      ? fuzzyScore(text, [{ text: item.subtitle }])
      : fuzzyScore(text, [{ text: item.title }, { text: item.keywords, weight: 0.6 }, { text: item.subtitle, weight: 0.55 }]);
    if (score === undefined) continue;
    ranked.push({ item, score: score + usageBoost(uses[item.key]) });
  }
  return ranked.sort((left, right) => right.score - left.score);
}

/**
 * The header's search bar and the palette it opens: books, passages, notes,
 * tags, threads, collections, pages, every setting, and the app's actions,
 * in one keyboard-first list. Everything is read and ranked on this device.
 */
export function CommandPalette({ shell }: { readonly shell: Omit<ShellState, "mod"> }) {
  const mac = navigator.platform?.toLowerCase().includes("mac") ?? false;
  const mod = mac ? "⌘" : "Ctrl ";
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [sources, setSources] = useState<PaletteSources>(EMPTY_SOURCES);
  const [memory, setMemory] = useState(readMemory);
  const [found, setFound] = useState<{ readonly text: string; readonly entries: readonly HighlightListEntry[] }>();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const bar = useRef<HTMLInputElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const ignoreBarFocus = useRef(false);
  const search = useRef(0);
  const listId = useId();
  const pageCommands = usePageCommands();

  const show = useCallback(() => {
    if (dialog.current?.open) return;
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMemory(readMemory());
    setQuery("");
    setActive(0);
    setOpen(true);
    // Open before React renders the contents, so the input can take focus at once.
    dialog.current?.showModal();
    input.current?.focus();
    void loadSources().then(setSources, () => undefined);
  }, []);

  const hide = useCallback(() => {
    const element = dialog.current;
    const target = returnTo.current;
    returnTo.current = null;
    // Closing a dialog hands focus back by itself; landing on the bar must not reopen it.
    ignoreBarFocus.current = true;
    try {
      if (element?.open) element.close();
      if (target?.isConnected) target.focus({ preventScroll: true });
    } finally {
      ignoreBarFocus.current = false;
    }
    setOpen(false);
  }, []);

  // ⌘K (Ctrl K) opens it from anywhere, and closes it again.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.key !== "k" && event.key !== "K") || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
      if (dialog.current?.open) hide();
      else show();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [show, hide]);

  const { prefix, text } = parse(query);

  // The library's own passage search, debounced; a slower earlier answer never replaces a later one.
  const wantsPassages = open && !prefix && text.length >= 2;
  useEffect(() => {
    if (!wantsPassages) return;
    const ticket = ++search.current;
    const words = text.slice(0, MAX_HIGHLIGHT_SEARCH_LENGTH);
    const timer = setTimeout(() => {
      window.leaflogue.library.listHighlights({ search: words, sort: "relevance", limit: PASSAGE_LIMIT }).then(
        (page) => { if (ticket === search.current) setFound({ text: words, entries: page.entries }); },
        () => { if (ticket === search.current) setFound({ text: words, entries: [] }); },
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [wantsPassages, text]);
  const passagesFor = wantsPassages && found?.text === text.slice(0, MAX_HIGHLIGHT_SEARCH_LENGTH) ? found.entries : undefined;

  const shellState: ShellState = useMemo(() => ({ ...shell, mod }), [shell, mod]);
  const everything = useMemo(() => [
    ...actionItems(sources, shellState, pageCommands),
    ...bookItems(sources.books),
    ...organizationItems(sources),
    ...pageItems(shellState.host),
    ...settingItems(shellState.host),
  ], [sources, shellState, pageCommands]);

  const groups: readonly Group[] = useMemo(() => {
    if (!open) return [];
    const byGroup = (name: GroupName, items: readonly PaletteItem[]) => items.filter((item) => item.group === name);
    if (!prefix && !text) {
      // Before anything is typed: what was used lately, then what this page and the app offer.
      const live = new Map(everything.map((item) => [item.key, item]));
      const recent = memory.recent.map((entry) => recentItem(entry, live)).filter((item): item is PaletteItem => item !== undefined);
      const shownRecent = new Set(recent.map(({ key }) => key));
      const suggestions = everything.filter((item) => !item.onlyWhenSearched && !shownRecent.has(item.key));
      return [
        { name: "Recent" as const, items: recent },
        { name: "This page" as const, items: byGroup("This page", suggestions) },
        { name: "Pages" as const, items: byGroup("Pages", suggestions).slice(0, 6) },
        { name: "Actions" as const, items: byGroup("Actions", suggestions) },
      ].filter(({ items }) => items.length > 0);
    }
    const allowed = prefix ? PREFIX_GROUPS[prefix] : undefined;
    const pool = allowed ? everything.filter((item) => allowed.includes(item.group)) : everything;
    const ranked = text ? rank(pool, text, prefix === "@" ? "author" : undefined, memory.uses) : pool.map((item) => ({ item, score: 0 }));
    const result: { name: GroupName; items: PaletteItem[]; best: number }[] = [];
    for (const name of GROUPS) {
      const matches = ranked.filter(({ item }) => item.group === name);
      if (matches.length === 0) continue;
      const cap = prefix ? Infinity : CAPS[name] ?? 6;
      result.push({ name, items: matches.slice(0, cap).map(({ item }) => item), best: matches[0]!.score });
    }
    if (passagesFor) {
      const { passages, notes } = passageItems(text, passagesFor);
      if (passages.length > 0) result.push({ name: "Passages", items: passages, best: PASSAGE_SCORE });
      if (notes.length > 0) result.push({ name: "Notes", items: notes, best: PASSAGE_SCORE - 1 });
    }
    result.sort((left, right) => right.best - left.best || GROUPS.indexOf(left.name) - GROUPS.indexOf(right.name));
    if (!prefix && text) result.push({ name: "Search", items: [searchAllItem(text)], best: -Infinity });
    return result;
  }, [open, prefix, text, everything, memory, passagesFor]);

  const flat = useMemo(() => groups.flatMap(({ items }) => items), [groups]);
  const current = flat[Math.min(active, flat.length - 1)];
  const optionId = (index: number) => `${listId}-option-${index}`;
  const currentIndex = current ? flat.indexOf(current) : -1;

  useEffect(() => {
    if (currentIndex < 0) return;
    document.getElementById(optionId(currentIndex))?.scrollIntoView?.({ block: "nearest" });
  });

  function choose(item: PaletteItem, secondary: boolean) {
    if (item.fill !== undefined) {
      setQuery(item.fill);
      setActive(0);
      input.current?.focus();
      return;
    }
    const action = secondary ? item.secondary?.run : item.run;
    if (!action) return;
    if (item.remember !== false) remember(item.remember ?? { key: item.key, title: item.title, ...(item.subtitle ? { subtitle: item.subtitle } : {}) });
    // Close and hand focus back first, so a dialog the action opens keeps it.
    hide();
    action();
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (flat.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((currentIndex + step + flat.length) % flat.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (current) choose(current, event.metaKey || event.ctrlKey);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      hide();
    } else if (event.key === "Tab") {
      event.preventDefault();
      // Opened by tabbing onto the bar, Tab carries on past it, so the
      // palette never traps someone moving through the header.
      if (returnTo.current !== bar.current || !bar.current) return;
      const from = bar.current;
      hide();
      const order = Array.from(document.querySelectorAll<HTMLElement>(TABBABLE))
        .filter((element) => element === from || (!element.closest("dialog:not([open]), [hidden], [inert]") && element.getClientRects().length > 0));
      order[order.indexOf(from) + (event.shiftKey ? -1 : 1)]?.focus();
    }
  }

  let index = -1;
  const empty = !prefix && !text;
  const results = flat.length;
  return (
    <>
      <div className="ui-search" onClick={show}>
        <Icon name="search" size={14} strokeWidth={2} />
        <input
          ref={bar}
          type="search"
          readOnly
          aria-label="Search and commands"
          aria-haspopup="dialog"
          aria-keyshortcuts="Meta+K Control+K"
          placeholder="Search or run a command"
          onFocus={(event) => {
            // Tabbing here opens the palette; returning focus from it, or to the window, does not.
            if (!ignoreBarFocus.current && event.relatedTarget !== null) show();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
              event.preventDefault();
              show();
            }
          }}
        />
        <kbd aria-hidden="true">{mac ? "⌘K" : "Ctrl K"}</kbd>
      </div>
      {createPortal(
        <dialog
          ref={dialog}
          className={styles.dialog}
          aria-label="Search and commands"
          onCancel={(event) => { event.preventDefault(); hide(); }}
          // The close event arrives a moment after closing; by then it may have been reopened.
          onClose={() => { if (!dialog.current?.open) setOpen(false); }}
          onClick={(event) => { if (event.target === event.currentTarget) hide(); }}
        >
          <div className={styles.inner}>
            <div className={styles.field}>
              <Icon name="search" size={16} />
              <input
                ref={input}
                className={styles.input}
                role="combobox"
                aria-label="Search books, passages, settings, and commands"
                aria-expanded="true"
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={currentIndex >= 0 ? optionId(currentIndex) : undefined}
                autoComplete="off"
                spellCheck={false}
                maxLength={MAX_HIGHLIGHT_SEARCH_LENGTH + 1}
                placeholder="Search or run a command…"
                value={query}
                onChange={(event) => { setQuery(event.target.value); setActive(0); }}
                onKeyDown={onKeyDown}
              />
              {prefix && <span className="ui-chip" data-tone="accent">{PREFIXES.find((entry) => entry.prefix === prefix)!.label}</span>}
            </div>
            {empty && (
              <p className={styles.hint}>
                <span className="ui-label">Narrow with</span>
                {PREFIXES.map((entry) => (
                  <button
                    key={entry.prefix}
                    type="button"
                    tabIndex={-1}
                    className={styles.prefix}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => { setQuery(entry.prefix); setActive(0); input.current?.focus(); }}
                  >
                    <kbd>{entry.prefix}</kbd>{entry.label}
                  </button>
                ))}
              </p>
            )}
            <div id={listId} role="listbox" aria-label="Results" className={styles.list}>
              {groups.map((group) => (
                <div key={group.name} role="group" aria-labelledby={`${listId}-${group.name.replace(/\s/gu, "-")}`} className={styles.group}>
                  <div id={`${listId}-${group.name.replace(/\s/gu, "-")}`} role="presentation" className={`ui-label ${styles.groupName}`}>{group.name}</div>
                  {group.items.map((item) => {
                    index += 1;
                    const position = index;
                    const selected = position === currentIndex;
                    return (
                      <div
                        key={`${group.name}:${item.key}`}
                        id={optionId(position)}
                        role="option"
                        aria-selected={selected}
                        className={styles.option}
                        onMouseMove={() => { if (!selected) setActive(position); }}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={(event) => choose(item, event.metaKey || event.ctrlKey)}
                      >
                        <Icon name={item.icon} size={15} className={styles.icon} />
                        <span className={styles.text}>
                          <span className={item.quote ? styles.quote : styles.title}>{item.title}</span>
                          {item.subtitle && <span className={styles.subtitle}>{item.subtitle}</span>}
                        </span>
                        {item.shortcut && <kbd className={styles.kbd}>{item.shortcut}</kbd>}
                      </div>
                    );
                  })}
                </div>
              ))}
              {results === 0 && <p className={styles.none}>{prefix && !text ? "Nothing here yet." : "No matches. Try fewer letters."}</p>}
            </div>
            <div className={styles.footer} aria-hidden="true">
              <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
              <span><kbd>↵</kbd> open</span>
              {current?.secondary && <span><kbd>{mac ? "⌘↵" : "Ctrl ↵"}</kbd> {current.secondary.label.toLocaleLowerCase()}</span>}
              <span><kbd>esc</kbd> close</span>
            </div>
            <p className="sr-only" role="status" aria-live="polite">{open && !empty ? `${results} ${results === 1 ? "result" : "results"}` : ""}</p>
          </div>
        </dialog>,
        document.body,
      )}
    </>
  );
}
