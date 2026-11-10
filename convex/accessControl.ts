import type { DataModelFromSchemaDefinition, GenericMutationCtx, GenericQueryCtx } from "convex/server";
import { ConvexError } from "convex/values";
import { identityKey } from "./hostIdentity";
import schema from "./schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type AccessContext = Pick<GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>, "auth" | "db">;
export type LibraryRole = "owner" | "editor" | "viewer";

export async function requireLibraryAccess(
  ctx: AccessContext,
  libraryId: string,
  permission: "read" | "write",
): Promise<LibraryRole> {
  const identity = await identityKey(ctx);
  if (!identity) throw accessFailure("LEAFLOGUE_AUTH_REQUIRED", "Authentication is required");
  const membership = await ctx.db
    .query("libraryMembers")
    .withIndex("by_identity_and_library", (query) => query
      .eq("identityTokenIdentifier", identity)
      .eq("libraryId", libraryId))
    .unique();
  if (!membership || (permission === "write" && membership.role === "viewer")) {
    throw accessFailure("LEAFLOGUE_ACCESS_DENIED", "Library access is denied");
  }
  return membership.role;
}

/**
 * Production Convex deployments redact plain error text before it reaches a
 * client, so authorization failures carry a stable code the desktop can act on.
 */
export function accessFailure(
  code: "LEAFLOGUE_AUTH_REQUIRED" | "LEAFLOGUE_ACCESS_DENIED" | "LEAFLOGUE_SESSION_INACTIVE" | "LEAFLOGUE_MIGRATION_REQUIRED" |
    "LEAFLOGUE_SYNC_KEY_UNCONFIGURED" | "LEAFLOGUE_SYNC_KEY_INVALID" | "LEAFLOGUE_LIBRARY_SELECTION_REQUIRED",
  message: string,
): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code, message });
}

export function requireTokenIdentifier(value: string): string {
  const normalized = value.trim();
  if (normalized !== value || normalized.length < 3 || normalized.length > 2_048) {
    throw new Error("Identity token identifier is invalid");
  }
  return normalized;
}

export function requireLibraryId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error("Library ID is invalid");
  }
  return value;
}
