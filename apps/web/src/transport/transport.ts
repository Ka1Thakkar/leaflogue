/**
 * How the web app reaches a hosted library. Both backends expose the same
 * functions under the same names (`browse:books`, `runtime:createHighlight`,
 * …), so the bridge is written once over this interface. Convex tells
 * queries, mutations, and actions apart; apps/server runs all three alike.
 */
export interface Transport {
  query<T>(name: string, args: Record<string, unknown>): Promise<T>;
  mutation<T>(name: string, args: Record<string, unknown>): Promise<T>;
  action<T>(name: string, args: Record<string, unknown>): Promise<T>;
}

/** A failure the backend explained, with its `LEAFLOGUE_*` code when it gave one. */
export class BackendError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number) {
    super(message);
    this.name = "BackendError";
  }
}
