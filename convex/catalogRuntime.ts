import { CatalogUnavailableError, searchCatalog } from "@leaflogue/catalog";
import type { ActionBuilder, DataModelFromSchemaDefinition, QueryBuilder } from "convex/server";
import { actionGeneric, internalQueryGeneric, makeFunctionReference } from "convex/server";
import { ConvexError, v } from "convex/values";
import { requireLibraryAccess } from "./accessControl";
import schema from "./schema";

/**
 * Book lookup for web clients (Google Books, then Open Library). Only the
 * reader's search leaves the deployment. `GOOGLE_BOOKS_API_KEY` in the
 * deployment's environment is optional and raises Google's quota. A result is
 * added with runtime:createBook, which takes its details in one step.
 */

declare const process: { readonly env: Readonly<Record<string, string | undefined>> };
type DataModel = DataModelFromSchemaDefinition<typeof schema>;
const action = actionGeneric as ActionBuilder<DataModel, "public">;
const internalQuery = internalQueryGeneric as QueryBuilder<DataModel, "internal">;

export const requireReader = internalQuery({
  args: { libraryId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "read");
    return null;
  },
});
const requireReaderReference = makeFunctionReference<"query", { libraryId: string }, null>("catalogRuntime:requireReader");

const catalogBookValidator = v.object({
  provider: v.union(v.literal("google-books"), v.literal("open-library")),
  providerId: v.string(),
  title: v.string(),
  authors: v.array(v.string()),
  isbn13: v.optional(v.string()),
  description: v.optional(v.string()),
  publisher: v.optional(v.string()),
  language: v.optional(v.string()),
  coverUrl: v.optional(v.string()),
});

export const search = action({
  args: { libraryId: v.string(), query: v.string() },
  returns: v.object({ source: v.union(v.literal("google-books"), v.literal("open-library")), items: v.array(catalogBookValidator) }),
  handler: async (ctx, args) => {
    await ctx.runQuery(requireReaderReference, { libraryId: args.libraryId });
    try {
      const key = process.env.GOOGLE_BOOKS_API_KEY?.trim();
      const result = await searchCatalog(args.query, key ? { googleBooksApiKey: key } : {});
      return { source: result.source, items: result.items.map((item) => ({ ...item, authors: [...item.authors] })) };
    } catch (error) {
      if (error instanceof CatalogUnavailableError) throw new ConvexError({ code: "LEAFLOGUE_CATALOG_UNAVAILABLE", message: error.message });
      throw new ConvexError({ code: "LEAFLOGUE_CATALOG_INVALID", message: error instanceof Error ? error.message : "That search is not valid" });
    }
  },
});
