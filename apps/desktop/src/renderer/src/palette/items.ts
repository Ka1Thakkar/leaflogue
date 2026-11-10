import type { AppearanceConfiguration, Book, Collection, ConnectedReader, HighlightListEntry, SystemHost, Tag, Thread } from "@leaflogue/contracts";
import type { IconName } from "@leaflogue/ui";
import { href, navigate } from "../router";
import type { PageCommand } from "./commands";
import { normalize } from "./fuzzy";
import type { RecentEntry } from "./recent";
import { onHost, openSetting, sectionLabel, settingsFor } from "./settings-index";
import { addBook, saveAppearance, shownMode, startImport } from "./actions";

/** The palette's groups, in the order they appear when nothing outranks them. */
export const GROUPS = ["Recent", "This page", "Books", "Passages", "Notes", "Tags", "Threads", "Collections", "Pages", "Settings", "Actions", "Search"] as const;
export type GroupName = (typeof GROUPS)[number];

/** One row the palette can show and run. */
export interface PaletteItem {
  readonly key: string;
  readonly group: GroupName;
  readonly title: string;
  readonly subtitle?: string;
  /** Other words that should find it. */
  readonly keywords?: string;
  readonly icon: IconName;
  readonly shortcut?: string;
  /** Set in the reading serif, as a passage is. */
  readonly quote?: boolean;
  readonly run: () => void;
  readonly secondary?: { readonly label: string; readonly run: () => void };
  /** What to remember when it is chosen; `false` remembers nothing. */
  readonly remember?: Omit<RecentEntry, "at"> | false;
  /** Instead of running, put these words in the palette's input. */
  readonly fill?: string;
  /** Left out of the suggestions shown before anything is typed. */
  readonly onlyWhenSearched?: boolean;
}

/** What the palette reads from the library each time it opens. */
export interface PaletteSources {
  readonly books: readonly Book[];
  readonly tags: readonly Tag[];
  readonly collections: readonly Collection[];
  readonly threads: readonly Thread[];
  readonly readers: readonly ConnectedReader[];
  readonly ai: boolean;
  readonly appearance?: AppearanceConfiguration;
}

export const EMPTY_SOURCES: PaletteSources = { books: [], tags: [], collections: [], threads: [], readers: [], ai: false };

export interface ShellState {
  readonly mod: string;
  /** The desktop app or the web app: each offers only what it can do. */
  readonly host: SystemHost;
  readonly sidebarExpanded: boolean;
  readonly toggleSidebar: () => void;
  readonly syncOn: boolean;
}

const plural = (count: number, noun: string) => `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;

export function excerpt(text: string, length: number): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > length ? `${flat.slice(0, length).trimEnd()}…` : flat;
}

function go(target: string): () => void {
  return () => navigate(target);
}

export function bookItems(books: readonly Book[]): PaletteItem[] {
  return books.map((book) => {
    const subtitle = [book.authors.join(", ") || "Author unknown", book.series ? `${book.series}${book.seriesNumber ? ` ${book.seriesNumber}` : ""}` : "", book.archived ? "Archived" : ""].filter(Boolean).join(" · ");
    return {
      key: `book:${book.id}`,
      group: "Books",
      title: book.title,
      subtitle,
      keywords: book.series,
      icon: "book",
      run: go(href.book(book.id)),
      secondary: { label: "Show its passages", run: go(href.highlights(undefined, { bookId: book.id })) },
      remember: { key: `book:${book.id}`, title: book.title, subtitle, href: href.book(book.id) },
    };
  });
}

export function organizationItems({ tags, threads, collections }: PaletteSources): PaletteItem[] {
  return [
    ...tags.map((tag): PaletteItem => ({
      key: `tag:${tag.id}`,
      group: "Tags",
      title: tag.name,
      subtitle: `${plural(tag.highlightCount, "passage")} · ${plural(tag.bookCount, "book")}`,
      icon: "tag",
      run: go(href.highlights(undefined, { tagId: tag.id })),
      secondary: { label: "Show tagged books", run: go(href.library({ tagId: tag.id })) },
      remember: { key: `tag:${tag.id}`, title: tag.name, subtitle: "Tag", href: href.highlights(undefined, { tagId: tag.id }) },
    })),
    ...threads.map((thread): PaletteItem => ({
      key: `thread:${thread.id}`,
      group: "Threads",
      title: thread.name,
      subtitle: [plural(thread.passageCount, "passage"), thread.description].filter(Boolean).join(" · "),
      icon: "threads",
      run: go(href.thread(thread.id)),
      remember: { key: `thread:${thread.id}`, title: thread.name, subtitle: "Thread", href: href.thread(thread.id) },
    })),
    ...collections.map((collection): PaletteItem => ({
      key: `collection:${collection.id}`,
      group: "Collections",
      title: collection.name,
      subtitle: [plural(collection.bookCount, "book"), collection.description].filter(Boolean).join(" · "),
      icon: "folder",
      run: go(href.library({ collectionId: collection.id })),
      remember: { key: `collection:${collection.id}`, title: collection.name, subtitle: "Collection", href: href.library({ collectionId: collection.id }) },
    })),
  ];
}

const PAGES: readonly { readonly id: string; readonly title: string; readonly href: string; readonly icon: IconName; readonly keywords: string; readonly host?: SystemHost["kind"] }[] = [
  { id: "library", title: "Library", href: href.library(), icon: "library", keywords: "books shelf home" },
  { id: "highlights", title: "Highlights", href: href.highlights(), icon: "passages", keywords: "passages quotes notes" },
  { id: "threads", title: "Threads", href: href.threads(), icon: "threads", keywords: "themes thematic" },
  { id: "statistics", title: "Statistics", href: href.statistics(), icon: "statistics", keywords: "reading numbers charts stats" },
  { id: "import", title: "Import", href: href.import(), icon: "import", keywords: "kobo kindle koreader reader file" },
  { id: "settings", title: "Settings", href: href.settings(), icon: "settings", keywords: "preferences options" },
  { id: "conflicts", title: "Review import changes", href: href.conflicts(), icon: "history", keywords: "conflicts import" },
  { id: "sync-conflicts", title: "Review synced changes", href: href.syncConflicts(), icon: "sync", keywords: "conflicts sync", host: "desktop" },
];

export function pageItems(host: SystemHost): PaletteItem[] {
  return PAGES.filter((page) => onHost(page, host)).map((page) => ({
    key: `page:${page.id}`,
    group: "Pages",
    title: page.title,
    keywords: page.keywords,
    icon: page.icon,
    run: go(page.href),
    remember: { key: `page:${page.id}`, title: page.title, subtitle: "Page", href: page.href },
  }));
}

export function settingItems(host: SystemHost): PaletteItem[] {
  return settingsFor(host).map((setting) => ({
    key: `setting:${setting.id}`,
    group: "Settings",
    title: setting.label,
    subtitle: `Settings · ${sectionLabel(setting.section)}`,
    keywords: "keywords" in setting ? setting.keywords : undefined,
    icon: "sliders",
    onlyWhenSearched: true,
    run: () => openSetting({ id: setting.id }),
  }));
}

/** The app's own actions, plus whatever the showing page offers. */
export function actionItems(sources: PaletteSources, shell: ShellState, pageCommands: readonly PageCommand[]): PaletteItem[] {
  const items: PaletteItem[] = [];
  const action = (id: string, item: Omit<PaletteItem, "key" | "group">) => items.push({ key: `cmd:${id}`, group: "Actions", ...item });
  for (const reader of sources.readers) {
    const name = { kobo: "Kobo", kindle: "Kindle", koreader: "KOReader", pocketbook: "PocketBook", tolino: "Tolino", boox: "Boox" }[reader.kind];
    action(`import-reader.${reader.id}`, {
      title: `Import from your ${name}`,
      subtitle: `${reader.label} is plugged in`,
      keywords: "import reader device usb highlights",
      icon: "reader",
      run: () => startImport({ kind: "reader", reader }),
      remember: false,
    });
  }
  action("import-file", { title: "Import highlights from a file", keywords: "import kobo kindle koreader clippings", icon: "import", run: () => startImport({ kind: "file" }), secondary: { label: "Open the import page", run: go(href.import()) } });
  action("add-book", { title: "Add a book", keywords: "new create", icon: "plus", run: addBook });
  if (shell.host.kind === "desktop") {
    // Files saved on this computer, backups, and updates are the desktop app's own.
    action("export", { title: "Export your library", keywords: "markdown json obsidian download", icon: "upload", run: () => openSetting({ id: "export", activate: true }), secondary: { label: "Show in Settings", run: () => openSetting({ id: "export" }) } });
    action("backup", { title: "Create a backup", keywords: "save copy library", icon: "save", run: () => openSetting({ id: "backup-create", activate: true }), secondary: { label: "Show in Settings", run: () => openSetting({ id: "backup-create" }) } });
    action("updates", { title: "Check for updates", keywords: "version upgrade release", icon: "sync", run: () => openSetting({ id: "updates-check", activate: true }), secondary: { label: "Show in Settings", run: () => openSetting({ id: "updates-check" }) } });
  } else {
    action("sign-out", { title: "Sign out", keywords: "account log out leave", icon: "sign-out", run: () => openSetting({ id: "sign-out", activate: true }), secondary: { label: "Show in Settings", run: () => openSetting({ id: "sign-out" }) } });
  }
  if (shell.syncOn) action("sync", { title: "Sync now", keywords: "synchronise synchronize remote", icon: "cloud", run: () => { void window.leaflogue.sync.run().catch(() => undefined); } });
  const appearance = sources.appearance;
  if (appearance) {
    const other = shownMode(appearance) === "dark" ? "light" : "dark";
    action("toggle-mode", { title: `Switch to ${other} mode`, keywords: "appearance theme light dark night", icon: "sun", run: () => { void saveAppearance(appearance.themeId, other).catch(() => undefined); } });
    if (appearance.mode !== "system") {
      action("follow-device", { title: "Follow this device's light or dark", keywords: "appearance theme system automatic", icon: "sun", run: () => { void saveAppearance(appearance.themeId, "system").catch(() => undefined); } });
    }
    for (const theme of appearance.themes) {
      if (theme.id === appearance.themeId) continue;
      action(`theme.${theme.id}`, { title: `Use the ${theme.name} theme`, keywords: "switch theme appearance colours colors", icon: "palette", onlyWhenSearched: true, run: () => { void saveAppearance(theme.id, appearance.mode).catch(() => undefined); } });
    }
  }
  action("sidebar", {
    title: shell.sidebarExpanded ? "Collapse the sidebar" : "Expand the sidebar",
    keywords: "navigation rail labels",
    icon: "sidebar",
    shortcut: `${shell.mod}B`,
    run: shell.toggleSidebar,
  });
  const pageItems = pageCommands
    .filter((command) => !command.ai || sources.ai)
    .map((command): PaletteItem => ({
      key: `cmd:${command.id}`,
      group: "This page",
      title: command.title,
      ...(command.subtitle ? { subtitle: command.subtitle } : {}),
      ...(command.keywords ? { keywords: command.keywords } : {}),
      ...(command.shortcut ? { shortcut: command.shortcut } : {}),
      ...(command.secondary ? { secondary: command.secondary } : {}),
      icon: command.icon ?? (command.ai ? "explain" : "chevron-right"),
      run: command.run,
    }));
  return [...pageItems, ...items];
}

/** Passages and notes from the highlights search, split by where the words were found. */
export function passageItems(query: string, entries: readonly HighlightListEntry[]): { readonly passages: PaletteItem[]; readonly notes: PaletteItem[] } {
  const needle = normalize(query.trim());
  const passages: PaletteItem[] = [];
  const notes: PaletteItem[] = [];
  for (const entry of entries) {
    const target = href.book(entry.bookId, entry.id);
    const copy = { label: "Copy the passage", run: () => { void navigator.clipboard?.writeText(entry.text).catch(() => undefined); } };
    const note = normalize(entry.text).includes(needle) ? undefined : entry.notes.find(({ markdown }) => normalize(markdown).includes(needle));
    if (note) {
      notes.push({
        key: `note:${note.id}`,
        group: "Notes",
        title: excerpt(note.markdown, 140),
        subtitle: `On “${excerpt(entry.text, 50)}” · ${entry.bookTitle}`,
        icon: "note-paper",
        run: go(target),
        secondary: copy,
        remember: { key: `passage:${entry.id}`, title: excerpt(note.markdown, 70), subtitle: `Note · ${entry.bookTitle}`, href: target },
      });
    } else {
      passages.push({
        key: `passage:${entry.id}`,
        group: "Passages",
        title: excerpt(entry.text, 160),
        subtitle: [entry.bookTitle, entry.authors.join(", ")].filter(Boolean).join(" · "),
        icon: "passages",
        quote: true,
        run: go(target),
        secondary: copy,
        remember: { key: `passage:${entry.id}`, title: excerpt(entry.text, 70), subtitle: entry.bookTitle, href: target },
      });
    }
  }
  return { passages: passages.slice(0, 5), notes: notes.slice(0, 3) };
}

/** The last row while searching: today's Enter-to-search, kept. */
export function searchAllItem(text: string): PaletteItem {
  return {
    key: `search:${text}`,
    group: "Search",
    title: `Search all highlights for “${text}”`,
    icon: "search",
    run: go(href.highlights(text)),
    remember: { key: `search:${text}`, title: `“${text}”`, subtitle: "Search" },
  };
}

/** A remembered item, made runnable again: the live version if there is one. */
export function recentItem(entry: RecentEntry, live: ReadonlyMap<string, PaletteItem>): PaletteItem | undefined {
  const current = live.get(entry.key);
  if (current) return { ...current, group: "Recent" };
  if (entry.key.startsWith("search:")) {
    const words = entry.key.slice("search:".length);
    return { key: entry.key, group: "Recent", title: entry.title, subtitle: "Search", icon: "search", fill: words, run: () => undefined, remember: false };
  }
  if (entry.href) {
    return {
      key: entry.key,
      group: "Recent",
      title: entry.title,
      ...(entry.subtitle ? { subtitle: entry.subtitle } : {}),
      icon: entry.key.startsWith("book:") ? "book" : entry.key.startsWith("passage:") ? "passages" : "open",
      run: go(entry.href),
      remember: { key: entry.key, title: entry.title, ...(entry.subtitle ? { subtitle: entry.subtitle } : {}), href: entry.href },
    };
  }
  // A page's command that this page does not offer.
  return undefined;
}
