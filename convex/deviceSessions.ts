import type { DataModelFromSchemaDefinition, GenericMutationCtx, GenericQueryCtx, MutationBuilder, QueryBuilder } from "convex/server";
import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { accessFailure, requireLibraryAccess, requireLibraryId } from "./accessControl";
import { identityKey } from "./hostIdentity";
import schema from "./schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
const mutation = mutationGeneric as MutationBuilder<DataModel, "public">;
const query = queryGeneric as QueryBuilder<DataModel, "public">;
type SessionContext = Pick<GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>, "auth" | "db">;
const sessionSummary = v.object({
  sessionId: v.string(),
  deviceId: v.string(),
  name: v.string(),
  createdAt: v.number(),
  lastSeenAt: v.number(),
  revokedAt: v.optional(v.number()),
  currentIdentity: v.boolean(),
});

export const enroll = mutation({
  args: { libraryId: v.string(), deviceId: v.string(), name: v.string() },
  returns: sessionSummary,
  handler: async (ctx, args) => {
    const libraryId = requireLibraryId(args.libraryId);
    const deviceId = requireDeviceId(args.deviceId);
    const name = requireDeviceName(args.name);
    await requireLibraryAccess(ctx, libraryId, "read");
    const identity = await identityKey(ctx);
    if (!identity) throw accessFailure("LEAFLOGUE_AUTH_REQUIRED", "Authentication is required");
    const existing = await ctx.db.query("deviceSessions")
      .withIndex("by_library_and_device", (q) => q.eq("libraryId", libraryId).eq("deviceId", deviceId))
      .unique();
    const now = Date.now();
    if (existing) {
      if (existing.identityTokenIdentifier !== identity) {
        throw new Error("This device is enrolled to another identity");
      }
      if (existing.revokedAt !== undefined) throw accessFailure("LEAFLOGUE_SESSION_INACTIVE", "This device session has been revoked");
      await ctx.db.patch(existing._id, { name, lastSeenAt: now });
      return summarize(existing._id, { ...existing, name, lastSeenAt: now }, identity);
    }
    const sessions = await ctx.db.query("deviceSessions")
      .withIndex("by_library", (q) => q.eq("libraryId", libraryId))
      .take(100);
    if (sessions.length >= 100) throw new Error("A library can retain at most 100 device sessions");
    const sessionId = await ctx.db.insert("deviceSessions", {
      libraryId,
      deviceId,
      identityTokenIdentifier: identity,
      name,
      createdAt: now,
      lastSeenAt: now,
    });
    return summarize(sessionId, {
      deviceId, identityTokenIdentifier: identity, name, createdAt: now, lastSeenAt: now,
    }, identity);
  },
});

export const list = query({
  args: { libraryId: v.string() },
  returns: v.array(sessionSummary),
  handler: async (ctx, args) => {
    const libraryId = requireLibraryId(args.libraryId);
    const role = await requireLibraryAccess(ctx, libraryId, "read");
    const identity = await identityKey(ctx);
    if (!identity) throw accessFailure("LEAFLOGUE_AUTH_REQUIRED", "Authentication is required");
    const sessions = role === "owner"
      ? await ctx.db.query("deviceSessions").withIndex("by_library", (q) => q.eq("libraryId", libraryId)).take(101)
      : await ctx.db.query("deviceSessions").withIndex("by_identity_and_library", (q) => q
        .eq("identityTokenIdentifier", identity).eq("libraryId", libraryId)).take(101);
    if (sessions.length > 100) throw new Error("This library has too many device sessions to list safely");
    return sessions.map((session) => summarize(session._id, session, identity));
  },
});

export const check = query({
  args: { libraryId: v.string(), sessionId: v.string(), deviceId: v.string() },
  returns: v.literal(true),
  handler: async (ctx, args) => {
    await requireActiveDeviceSession(ctx, args.libraryId, args.sessionId, args.deviceId, "read");
    return true as const;
  },
});

export const revoke = mutation({
  args: { libraryId: v.string(), sessionId: v.id("deviceSessions") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const libraryId = requireLibraryId(args.libraryId);
    const role = await requireLibraryAccess(ctx, libraryId, "read");
    const identity = await identityKey(ctx);
    if (!identity) throw accessFailure("LEAFLOGUE_AUTH_REQUIRED", "Authentication is required");
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.libraryId !== libraryId) return false;
    if (role !== "owner" && session.identityTokenIdentifier !== identity) {
      throw new Error("Only an owner can revoke another identity's device");
    }
    if (session.revokedAt !== undefined) return false;
    await ctx.db.patch(session._id, { revokedAt: Date.now() });
    return true;
  },
});

export const forgetRevoked = mutation({
  args: { libraryId: v.string(), sessionId: v.id("deviceSessions") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const libraryId = requireLibraryId(args.libraryId);
    const role = await requireLibraryAccess(ctx, libraryId, "write");
    if (role !== "owner") throw new Error("Only an owner can forget a revoked device");
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.libraryId !== libraryId) return false;
    if (session.revokedAt === undefined) throw new Error("Revoke this device before forgetting it");
    await ctx.db.delete(session._id);
    return true;
  },
});

export async function requireActiveDeviceSession(
  ctx: SessionContext,
  rawLibraryId: string,
  rawSessionId: string,
  rawDeviceId: string,
  permission: "read" | "write",
): Promise<void> {
  const libraryId = requireLibraryId(rawLibraryId);
  const deviceId = requireDeviceId(rawDeviceId);
  await requireLibraryAccess(ctx, libraryId, permission);
  const identity = await identityKey(ctx);
  if (!identity) throw accessFailure("LEAFLOGUE_AUTH_REQUIRED", "Authentication is required");
  const sessionId = ctx.db.normalizeId("deviceSessions", rawSessionId);
  if (!sessionId) throw accessFailure("LEAFLOGUE_SESSION_INACTIVE", "Device session is invalid");
  const session = await ctx.db.get(sessionId);
  if (!session || session.libraryId !== libraryId || session.deviceId !== deviceId ||
      session.identityTokenIdentifier !== identity || session.revokedAt !== undefined) {
    throw accessFailure("LEAFLOGUE_SESSION_INACTIVE", "Device session is inactive");
  }
}

function summarize(
  sessionId: string,
  session: { deviceId: string; identityTokenIdentifier: string; name: string; createdAt: number; lastSeenAt: number; revokedAt?: number },
  identityTokenIdentifier: string,
) {
  return {
    sessionId,
    deviceId: session.deviceId,
    name: session.name,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    ...(session.revokedAt === undefined ? {} : { revokedAt: session.revokedAt }),
    currentIdentity: session.identityTokenIdentifier === identityTokenIdentifier,
  };
}

function requireDeviceId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    throw new Error("Device ID is invalid");
  }
  return value;
}

function requireDeviceName(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (normalized.length < 1 || normalized.length > 80) throw new Error("Device name is invalid");
  return normalized;
}
