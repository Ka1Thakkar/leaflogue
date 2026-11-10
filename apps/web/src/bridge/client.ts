import { BackendError, type Transport } from "../transport/transport";

/** One library on the backend: every call carries its `libraryId`. */
export class LibraryClient {
  constructor(readonly transport: Transport, readonly libraryId: string) {}

  query<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.transport.query<T>(name, { libraryId: this.libraryId, ...args });
  }

  mutation<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.transport.mutation<T>(name, { libraryId: this.libraryId, ...args });
  }

  action<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.transport.action<T>(name, { libraryId: this.libraryId, ...args });
  }
}

export interface Page<Item> {
  readonly page: readonly Item[];
  readonly isDone: boolean;
  readonly continueCursor: string;
}

/** Read every page of a paginated function, in order. */
export async function allPages<Item>(read: (cursor: string | null) => Promise<Page<Item>>): Promise<Item[]> {
  const items: Item[] = [];
  let cursor: string | null = null;
  for (;;) {
    const result = await read(cursor);
    items.push(...result.page);
    if (result.isDone) return items;
    cursor = result.continueCursor;
  }
}

export function desktopOnly(what: string): Promise<never> {
  return Promise.reject(new BackendError(`${what} needs the desktop app.`, "LEAFLOGUE_WEB_UNSUPPORTED"));
}

export function newId<Id extends string>(): Id {
  return crypto.randomUUID() as Id;
}

/** Browser storage can be missing or refuse writes; nothing here depends on it succeeding. */
export const storage = {
  get(key: string): string | null {
    try { return window.localStorage.getItem(key); } catch { return null; }
  },
  set(key: string, value: string): void {
    try { window.localStorage.setItem(key, value); } catch { /* Kept for this page only. */ }
  },
  remove(key: string): void {
    try { window.localStorage.removeItem(key); } catch { /* Nothing to forget. */ }
  },
};
