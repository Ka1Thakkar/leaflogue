import type { DataModelFromSchemaDefinition, MutationBuilder, QueryBuilder } from "convex/server";
import { internalMutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { accessFailure, requireLibraryId, requireTokenIdentifier } from "./accessControl";
import { identityKey } from "./hostIdentity";
import schema from "./schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
const internalMutation = internalMutationGeneric as MutationBuilder<DataModel, "internal">;
const query = queryGeneric as QueryBuilder<DataModel, "public">;
const roleValidator = v.union(v.literal("owner"), v.literal("editor"), v.literal("viewer"));

export const provisionLibrary = internalMutation({
  args: {
    libraryId: v.string(),
    identityTokenIdentifier: v.string(),
    role: v.optional(roleValidator),
  },
  returns: v.object({ libraryId: v.string(), role: roleValidator, libraryCreated: v.boolean() }),
  handler: async (ctx, args) => {
    const libraryId = requireLibraryId(args.libraryId);
    const identityTokenIdentifier = requireTokenIdentifier(args.identityTokenIdentifier);
    const role = args.role ?? "owner";
    const now = Date.now();
    let library = await ctx.db.query("libraries").withIndex("by_external_id", (query) => query.eq("externalId", libraryId)).unique();
    const libraryCreated = !library;
    if (!library) {
      const id = await ctx.db.insert("libraries", { externalId: libraryId, nextChangeSequence: 0, syncGeneration: 1, createdAt: now, updatedAt: now });
      library = await ctx.db.get(id);
    }
    if (!library) throw new Error("Library provisioning failed");
    const membership = await ctx.db.query("libraryMembers").withIndex("by_identity_and_library", (query) => query
      .eq("identityTokenIdentifier", identityTokenIdentifier)
      .eq("libraryId", libraryId)).unique();
    if (membership) await ctx.db.patch(membership._id, { role, updatedAt: now });
    else await ctx.db.insert("libraryMembers", { libraryId, identityTokenIdentifier, role, createdAt: now, updatedAt: now });
    return { libraryId, role, libraryCreated };
  },
});

/**
 * For an app hosting Leaflogue's backend: make a signed-in identity the owner
 * of this deployment's library, creating the library if there is none yet.
 * Like the desktop's sync key path, a deployment holds one library, so this
 * refuses when there are several. Internal on purpose: the host decides who
 * may sign in (for example an email allowlist) before calling it.
 */
export const provisionHostOwner = internalMutation({
  args: { identityTokenIdentifier: v.string() },
  returns: v.object({ libraryId: v.string(), libraryCreated: v.boolean() }),
  handler: async (ctx, args) => {
    const identityTokenIdentifier = requireTokenIdentifier(args.identityTokenIdentifier);
    const libraries = await ctx.db.query("libraries").take(2);
    if (libraries.length > 1) {
      throw accessFailure("LEAFLOGUE_LIBRARY_SELECTION_REQUIRED", "This deployment holds more than one library");
    }
    const now = Date.now();
    let libraryId = libraries[0]?.externalId;
    const libraryCreated = libraryId === undefined;
    if (libraryId === undefined) {
      libraryId = crypto.randomUUID();
      await ctx.db.insert("libraries", { externalId: libraryId, nextChangeSequence: 0, syncGeneration: 1, createdAt: now, updatedAt: now });
    }
    const membership = await ctx.db.query("libraryMembers").withIndex("by_identity_and_library", (query) => query
      .eq("identityTokenIdentifier", identityTokenIdentifier)
      .eq("libraryId", libraryId)).unique();
    if (membership) {
      if (membership.role !== "owner") await ctx.db.patch(membership._id, { role: "owner", updatedAt: now });
    } else {
      await ctx.db.insert("libraryMembers", { libraryId, identityTokenIdentifier, role: "owner", createdAt: now, updatedAt: now });
    }
    return { libraryId, libraryCreated };
  },
});

/** The libraries the signed-in identity belongs to, so a web client knows which to open. */
export const myLibraries = query({
  args: {},
  returns: v.array(v.object({ libraryId: v.string(), role: roleValidator })),
  handler: async (ctx) => {
    const identity = await identityKey(ctx);
    if (!identity) throw accessFailure("LEAFLOGUE_AUTH_REQUIRED", "Authentication is required");
    const memberships = await ctx.db.query("libraryMembers")
      .withIndex("by_identity_and_library", (query) => query.eq("identityTokenIdentifier", identity))
      .take(20);
    return memberships.map(({ libraryId, role }) => ({ libraryId, role }));
  },
});

export const rotateLibrarySyncGeneration = internalMutation({
  args: { libraryId: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const libraryId = requireLibraryId(args.libraryId);
    const library = await ctx.db.query("libraries")
      .withIndex("by_external_id", (query) => query.eq("externalId", libraryId))
      .unique();
    if (!library) throw new Error("Library no longer exists");
    const current = library.syncGeneration ?? 1;
    if (!Number.isSafeInteger(current) || current < 1 || current >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Library sync generation cannot be rotated");
    }
    const generation = current + 1;
    await ctx.db.patch(library._id, { syncGeneration: generation, updatedAt: Date.now() });
    return generation;
  },
});

export const revokeLibraryAccess = internalMutation({
  args: { libraryId: v.string(), identityTokenIdentifier: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const libraryId = requireLibraryId(args.libraryId);
    const identityTokenIdentifier = requireTokenIdentifier(args.identityTokenIdentifier);
    const membership = await ctx.db.query("libraryMembers").withIndex("by_identity_and_library", (query) => query
      .eq("identityTokenIdentifier", identityTokenIdentifier)
      .eq("libraryId", libraryId)).unique();
    if (!membership) return false;
    const sessions = await ctx.db.query("deviceSessions").withIndex("by_identity_and_library", (query) => query
      .eq("identityTokenIdentifier", identityTokenIdentifier)
      .eq("libraryId", libraryId)).take(101);
    if (sessions.length > 100) throw new Error("This identity has too many device sessions to revoke safely");
    const now = Date.now();
    for (const session of sessions) {
      if (session.revokedAt === undefined) await ctx.db.patch(session._id, { revokedAt: now });
    }
    await ctx.db.delete(membership._id);
    return true;
  },
});

export const currentIdentity = query({
  args: {},
  returns: v.object({ tokenIdentifier: v.string() }),
  handler: async (ctx) => {
    const identity = await identityKey(ctx);
    if (!identity) throw accessFailure("LEAFLOGUE_AUTH_REQUIRED", "Authentication is required");
    return { tokenIdentifier: identity };
  },
});
