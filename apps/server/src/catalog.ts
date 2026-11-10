import { CatalogUnavailableError, searchCatalog } from "@leaflogue/catalog";
import type { RequestContext } from "./context";
import { ServerError } from "./errors";

/**
 * Book lookup, as on Convex (`catalogRuntime:search`). Only the reader's
 * search leaves the server. GOOGLE_BOOKS_API_KEY is optional and raises
 * Google's quota. A result is added with runtime:createBook.
 */
export async function search(context: RequestContext, query: string) {
  try {
    const key = context.config.env.GOOGLE_BOOKS_API_KEY?.trim();
    const result = await searchCatalog(query, { fetch: context.fetch, ...(key ? { googleBooksApiKey: key } : {}) });
    return { source: result.source, items: result.items.map((item) => ({ ...item, authors: [...item.authors] })) };
  } catch (error) {
    if (error instanceof CatalogUnavailableError) throw new ServerError("LEAFLOGUE_CATALOG_UNAVAILABLE", error.message, 503);
    throw new ServerError("LEAFLOGUE_CATALOG_INVALID", error instanceof Error ? error.message : "That search is not valid");
  }
}
