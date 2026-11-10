import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { IconName } from "@leaflogue/ui";

/**
 * Commands a page offers in the palette while it is showing: a book's
 * "Mark as finished", the library's "Customise this page". A page lists them
 * with `useCommands`; they disappear when it unmounts.
 */
export interface PageCommand {
  /** Stable across renders and visits, e.g. `book.mark-finished`; used to remember it. */
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  /** Other words that should find it. */
  readonly keywords?: string;
  readonly icon?: IconName;
  /** Shown beside it, e.g. "⌘B". */
  readonly shortcut?: string;
  /** Only offered while AI is switched on in Settings. */
  readonly ai?: boolean;
  readonly run: () => void;
  /** What ⌘Enter (Ctrl Enter) does instead, where there is a second choice. */
  readonly secondary?: { readonly label: string; readonly run: () => void };
}

interface Registry {
  readonly commands: readonly PageCommand[];
  readonly set: (owner: symbol, commands: readonly PageCommand[] | undefined) => void;
}

const RegistryContext = createContext<Registry | null>(null);

export function CommandRegistryProvider({ children }: { readonly children: ReactNode }) {
  const [owners, setOwners] = useState<ReadonlyMap<symbol, readonly PageCommand[]>>(new Map());
  const set = useCallback((owner: symbol, commands: readonly PageCommand[] | undefined) => {
    setOwners((current) => {
      const empty = !commands || commands.length === 0;
      // Most components offer nothing most of the time; that changes nothing.
      if (empty && !current.has(owner)) return current;
      const next = new Map(current);
      if (commands && !empty) next.set(owner, commands);
      else next.delete(owner);
      return next;
    });
  }, []);
  const value = useMemo(() => ({ commands: [...owners.values()].flat(), set }), [owners, set]);
  return <RegistryContext.Provider value={value}>{children}</RegistryContext.Provider>;
}

/** Every command the showing pages offer. */
export function usePageCommands(): readonly PageCommand[] {
  return useContext(RegistryContext)?.commands ?? [];
}

/**
 * Offer these commands while the calling component is mounted. Callers can
 * pass a fresh array each render: the palette always runs the latest
 * handlers, and the list is only re-registered when what it shows changes.
 */
export function useCommands(commands: readonly PageCommand[]): void {
  const registry = useContext(RegistryContext);
  const set = registry?.set;
  const latest = useRef(commands);
  useEffect(() => { latest.current = commands; });
  const [owner] = useState(() => Symbol("page commands"));
  const shown = commands.map(({ id, title, subtitle, keywords, icon, shortcut, ai, secondary }) =>
    [id, title, subtitle, keywords, icon, shortcut, ai, secondary?.label].join("\u0000")).join("\u0001");
  useEffect(() => {
    if (!set) return;
    const find = (id: string) => latest.current.find((command) => command.id === id);
    set(owner, latest.current.map((command) => ({
      ...command,
      run: () => find(command.id)?.run(),
      ...(command.secondary ? { secondary: { label: command.secondary.label, run: () => find(command.id)?.secondary?.run() } } : {}),
    })));
  }, [set, owner, shown]);
  useEffect(() => () => set?.(owner, undefined), [set, owner]);
}
