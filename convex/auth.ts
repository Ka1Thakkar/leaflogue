import Google from "@auth/core/providers/google";
import { convexAuth, getAuthUserId } from "@convex-dev/auth/server";
import { makeFunctionReference, queryGeneric, type DataModelFromSchemaDefinition, type GenericMutationCtx, type QueryBuilder } from "convex/server";
import { v } from "convex/values";
import type { GenericId } from "convex/values";
import { ownUserIdentityKey } from "./hostIdentity";
import type schema from "./schema";

declare const process: { readonly env: Readonly<Record<string, string | undefined>> };

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type MutationCtx = GenericMutationCtx<DataModel>;
const query = queryGeneric as QueryBuilder<DataModel, "public">;
const provisionOwner = makeFunctionReference<"mutation", { identityTokenIdentifier: string }, { libraryId: string; libraryCreated: boolean }>("access:provisionHostOwner");

/**
 * Sign-in for the web app on a standalone Leaflogue deployment: Google, open
 * only to the emails in AUTH_ALLOWED_EMAILS. With that unset nobody can sign
 * in, so a deployment used only for desktop sync stays closed. The desktop
 * never signs in here; it uses the deployment's sync key.
 *
 * A host app that brings its own sign-in keeps its own auth.ts (the export
 * never writes this file).
 */

export function allowedEmails(value = process.env.AUTH_ALLOWED_EMAILS): ReadonlySet<string> {
  return new Set((value ?? "").split(",").map((email: string) => email.trim().toLowerCase()).filter(Boolean));
}

function refuse(): never {
  throw new Error("This account is not allowed to sign in here");
}

async function requireAllowed(ctx: MutationCtx, userId: GenericId<"users">): Promise<void> {
  const user = await ctx.db.get(userId);
  const email = typeof user?.email === "string" ? user.email.toLowerCase() : "";
  if (!email || !allowedEmails().has(email)) refuse();
}

/** Preserve Google's verified-email claim instead of dropping it in normalization. */
export function verifiedGoogleProfile(profile: {
  sub: string; email?: string; email_verified?: boolean; name?: string; picture?: string;
}) {
  if (profile.email_verified !== true || !profile.email?.trim() || !profile.sub) refuse();
  return {
    id: profile.sub,
    ...(typeof profile.name === "string" ? { name: profile.name } : {}),
    email: profile.email.trim().toLowerCase(),
    ...(typeof profile.picture === "string" ? { image: profile.picture } : {}),
    emailVerified: true,
  };
}

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Google({ profile: verifiedGoogleProfile })],
  callbacks: {
    async afterUserCreatedOrUpdated(ctx, { userId, profile }) {
      // Failing here rolls the new account back, so a stranger leaves nothing behind.
      const email = typeof profile.email === "string" ? profile.email.toLowerCase() : "";
      if (!email || profile.emailVerified !== true || !allowedEmails().has(email)) refuse();
      // Every allowed reader owns the deployment's one library.
      await ctx.runMutation(provisionOwner, { identityTokenIdentifier: ownUserIdentityKey(userId) });
    },
    // Removing an email from the allowlist stops new sessions for it.
    async beforeSessionCreation(ctx, { userId }) {
      await requireAllowed(ctx as MutationCtx, userId);
    },
  },
});

/** The signed-in reader's email, for the web app's account panel. */
export const account = query({
  args: {},
  returns: v.union(v.null(), v.object({ email: v.optional(v.string()) })),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    const user = userId ? await ctx.db.get(userId) : null;
    return user ? (typeof user.email === "string" ? { email: user.email } : {}) : null;
  },
});
