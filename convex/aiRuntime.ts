import {
  AI_OPENAI_COMPATIBLE_ENDPOINT_VARIABLE,
  AI_PROVIDER_IDS,
  AI_PROVIDER_KEY_VARIABLES,
  AiRateLimitError,
  companionInScope,
  companionNeedsScopeCheck,
  companionOutOfScope,
  companionRequest,
  companionScopeRequest,
  DEFAULT_AI_PROVIDERS,
  generateAiText,
  isAiModelId,
  isAiProviderId,
  parseCompanionAnswer,
  validateCompanionInput,
  type AiProviderId,
  type AiRuntimeProvider,
  type CompanionPassage,
} from "@leaflogue/ai";
import type { ActionBuilder, DataModelFromSchemaDefinition, MutationBuilder, QueryBuilder } from "convex/server";
import { actionGeneric, internalMutationGeneric, internalQueryGeneric, makeFunctionReference, mutationGeneric, queryGeneric } from "convex/server";
import { ConvexError, v } from "convex/values";
import { accessFailure, requireLibraryAccess } from "./accessControl";
import { identityKey } from "./hostIdentity";
import schema from "./schema";

/**
 * The passage companion for web clients. The reader chooses a provider and
 * model in settings; the API key is read only from this deployment's
 * environment (AI_PROVIDER_KEY_VARIABLES), which the self-hoster sets, and is
 * never stored in the database or returned to a client.
 */

declare const process: { readonly env: Readonly<Record<string, string | undefined>> };

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
const query = queryGeneric as QueryBuilder<DataModel, "public">;
const mutation = mutationGeneric as MutationBuilder<DataModel, "public">;
const action = actionGeneric as ActionBuilder<DataModel, "public">;
const internalQuery = internalQueryGeneric as QueryBuilder<DataModel, "internal">;
const internalMutation = internalMutationGeneric as MutationBuilder<DataModel, "internal">;

const HOUR = 60 * 60 * 1000;
const DEFAULT_HOURLY_LIMIT = 30;
const providerValidator = v.union(...AI_PROVIDER_IDS.map((id) => v.literal(id)));

function hourlyLimit(): number {
  const configured = Number(process.env.LEAFLOGUE_AI_HOURLY_LIMIT);
  return Number.isSafeInteger(configured) && configured > 0 && configured <= 1_000 ? configured : DEFAULT_HOURLY_LIMIT;
}

/** Whether this deployment's environment holds what the provider needs. */
function configured(id: AiProviderId): boolean {
  if (!process.env[AI_PROVIDER_KEY_VARIABLES[id]]?.trim()) return false;
  return id !== "openai-compatible" || Boolean(process.env[AI_OPENAI_COMPATIBLE_ENDPOINT_VARIABLE]?.trim());
}

function failure(code: "LEAFLOGUE_AI_UNCONFIGURED" | "LEAFLOGUE_AI_LIMIT" | "LEAFLOGUE_AI_FAILED" | "LEAFLOGUE_AI_INVALID", message: string): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code, message });
}

/** Providers this deployment can use, and the library's current choice. */
export const settings = query({
  args: { libraryId: v.string() },
  returns: v.object({
    providers: v.array(v.object({
      id: providerValidator,
      configured: v.boolean(),
      keyVariable: v.string(),
      models: v.array(v.string()),
      defaultModel: v.optional(v.string()),
    })),
    selected: v.union(v.null(), v.object({ provider: providerValidator, model: v.string() })),
    hourlyLimit: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "read");
    const saved = await ctx.db.query("aiSettings").withIndex("by_library", (q) => q.eq("libraryId", args.libraryId)).unique();
    return {
      providers: AI_PROVIDER_IDS.map((id) => {
        const defaults = DEFAULT_AI_PROVIDERS[id];
        return {
          id,
          configured: configured(id),
          keyVariable: AI_PROVIDER_KEY_VARIABLES[id],
          models: defaults ? [...defaults.models] : [],
          ...(defaults ? { defaultModel: defaults.defaultModel } : {}),
        };
      }),
      selected: saved && isAiProviderId(saved.provider) ? { provider: saved.provider, model: saved.model } : null,
      hourlyLimit: hourlyLimit(),
    };
  },
});

export const setSettings = mutation({
  args: { libraryId: v.string(), provider: providerValidator, model: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "write");
    const model = args.model.trim();
    if (!isAiModelId(model)) throw failure("LEAFLOGUE_AI_INVALID", "That model name is not valid");
    if (!configured(args.provider)) {
      throw failure("LEAFLOGUE_AI_UNCONFIGURED", `Set ${AI_PROVIDER_KEY_VARIABLES[args.provider]} on the server to use this provider`);
    }
    const now = Date.now();
    const saved = await ctx.db.query("aiSettings").withIndex("by_library", (q) => q.eq("libraryId", args.libraryId)).unique();
    if (saved) await ctx.db.patch(saved._id, { provider: args.provider, model, updatedAt: now });
    else await ctx.db.insert("aiSettings", { libraryId: args.libraryId, provider: args.provider, model, updatedAt: now });
    return null;
  },
});

const passageValidator = v.object({
  bookTitle: v.string(), authors: v.array(v.string()), passage: v.string(),
  series: v.optional(v.string()), seriesNumber: v.optional(v.string()), publisher: v.optional(v.string()), description: v.optional(v.string()),
});

/** The passages to discuss and the saved choice, checked against the caller's access. */
export const companionContext = internalQuery({
  args: { libraryId: v.string(), highlightId: v.string(), secondaryHighlightId: v.optional(v.string()) },
  returns: v.object({
    primary: passageValidator,
    secondary: v.optional(passageValidator),
    provider: v.union(v.null(), v.object({ provider: providerValidator, model: v.string() })),
  }),
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "read");
    if (args.secondaryHighlightId === args.highlightId) throw failure("LEAFLOGUE_AI_INVALID", "Choose two different passages");
    const resolve = async (id: string): Promise<Omit<CompanionPassage, "authors"> & { authors: string[] }> => {
      const highlight = await ctx.db.query("highlights").withIndex("by_library_and_id", (q) => q.eq("libraryId", args.libraryId).eq("id", id)).unique();
      if (!highlight || highlight.deletedAt !== undefined || highlight.archived) throw failure("LEAFLOGUE_AI_INVALID", "That passage no longer exists");
      const book = await ctx.db.query("books").withIndex("by_library_and_id", (q) => q.eq("libraryId", args.libraryId).eq("id", highlight.bookId)).unique();
      if (!book || book.deletedAt !== undefined) throw failure("LEAFLOGUE_AI_INVALID", "That passage's book no longer exists");
      return {
        bookTitle: book.title, authors: [...book.authors], passage: highlight.text,
        ...(book.series ? { series: book.series } : {}),
        ...(book.seriesNumber ? { seriesNumber: book.seriesNumber } : {}),
        ...(book.publisher ? { publisher: book.publisher } : {}),
        ...(book.description ? { description: book.description } : {}),
      };
    };
    const saved = await ctx.db.query("aiSettings").withIndex("by_library", (q) => q.eq("libraryId", args.libraryId)).unique();
    return {
      primary: await resolve(args.highlightId),
      ...(args.secondaryHighlightId ? { secondary: await resolve(args.secondaryHighlightId) } : {}),
      provider: saved && isAiProviderId(saved.provider) ? { provider: saved.provider, model: saved.model } : null,
    };
  },
});

/** Count one request against the caller's hourly allowance. */
export const claimRequest = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const identity = await identityKey(ctx);
    if (!identity) throw accessFailure("LEAFLOGUE_AUTH_REQUIRED", "Authentication is required");
    const limit = hourlyLimit();
    const now = Date.now();
    const usage = await ctx.db.query("aiRequestWindows").withIndex("by_identity", (q) => q.eq("identityTokenIdentifier", identity)).unique();
    if (!usage || now - usage.windowStartedAt >= HOUR) {
      if (usage) await ctx.db.patch(usage._id, { windowStartedAt: now, requests: 1 });
      else await ctx.db.insert("aiRequestWindows", { identityTokenIdentifier: identity, windowStartedAt: now, requests: 1 });
      return limit - 1;
    }
    if (usage.requests >= limit) throw failure("LEAFLOGUE_AI_LIMIT", "You have used this hour's AI requests. Try again later.");
    await ctx.db.patch(usage._id, { requests: usage.requests + 1 });
    return limit - usage.requests - 1;
  },
});

const contextReference = makeFunctionReference<"query", { libraryId: string; highlightId: string; secondaryHighlightId?: string }, {
  primary: CompanionPassage; secondary?: CompanionPassage; provider: { provider: AiProviderId; model: string } | null;
}>("aiRuntime:companionContext");
const claimReference = makeFunctionReference<"mutation", Record<string, never>, number>("aiRuntime:claimRequest");

/**
 * One turn of the companion. Only the chosen passages and the conversation
 * leave the deployment, never notes or the rest of the library. Saving an
 * answer is the client's choice, through runtime:createNote with origin "ai".
 */
export const companion = action({
  args: {
    libraryId: v.string(),
    highlightId: v.string(),
    secondaryHighlightId: v.optional(v.string()),
    prompt: v.string(),
    history: v.array(v.object({ role: v.union(v.literal("reader"), v.literal("companion")), text: v.string() })),
  },
  returns: v.object({ answer: v.string(), remaining: v.number(), saveable: v.boolean() }),
  handler: async (ctx, args) => {
    try {
      validateCompanionInput(args);
    } catch (error) {
      throw failure("LEAFLOGUE_AI_INVALID", error instanceof Error ? error.message : "That question is not valid");
    }
    const context = await ctx.runQuery(contextReference, {
      libraryId: args.libraryId,
      highlightId: args.highlightId,
      ...(args.secondaryHighlightId ? { secondaryHighlightId: args.secondaryHighlightId } : {}),
    });
    if (!context.provider) throw failure("LEAFLOGUE_AI_UNCONFIGURED", "Choose an AI provider in Settings first");
    const { provider: id, model } = context.provider;
    const apiKey = process.env[AI_PROVIDER_KEY_VARIABLES[id]]?.trim();
    const endpoint = process.env[AI_OPENAI_COMPATIBLE_ENDPOINT_VARIABLE]?.trim();
    if (!apiKey || (id === "openai-compatible" && !endpoint)) {
      throw failure("LEAFLOGUE_AI_UNCONFIGURED", `Set ${AI_PROVIDER_KEY_VARIABLES[id]} on the server to use this provider`);
    }
    const provider: AiRuntimeProvider = { id, model, apiKey, ...(id === "openai-compatible" && endpoint ? { endpoint } : {}) };
    const remaining = await ctx.runMutation(claimReference, {});
    const input = {
      primary: context.primary,
      ...(context.secondary ? { secondary: context.secondary } : {}),
      prompt: args.prompt,
      history: args.history,
    };
    try {
      if (companionNeedsScopeCheck(input)) {
        const verdict = await generateAiText(provider, companionScopeRequest(input));
        if (!companionInScope(verdict.text)) return { answer: companionOutOfScope(input), remaining, saveable: false };
      }
      const response = await generateAiText(provider, companionRequest(input));
      return { answer: parseCompanionAnswer(response.text), remaining, saveable: !context.secondary };
    } catch (error) {
      if (error instanceof AiRateLimitError) throw failure("LEAFLOGUE_AI_LIMIT", error.message);
      if (error instanceof Error && /timed out/u.test(error.message)) {
        throw failure("LEAFLOGUE_AI_FAILED", "The AI provider took too long to answer. Try again, or choose a faster model in settings.");
      }
      throw failure("LEAFLOGUE_AI_FAILED", "The AI provider could not answer right now. Try again shortly.");
    }
  },
});
