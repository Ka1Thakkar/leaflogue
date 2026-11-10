import type { Auth } from "convex/server";

declare const process: { readonly env: Readonly<Record<string, string | undefined>> };

/**
 * Who the signed-in caller is, as library memberships, device sessions, and
 * AI limits record them.
 *
 * The deployment's own sign-in (Convex Auth, convex/auth.ts) puts the session
 * after the user in the subject, `userId|sessionId`, so its readers are keyed
 * by user; otherwise every new sign-in would look like a stranger. Any other
 * provider's token identifier is used as it is.
 *
 * An app hosting Leaflogue's backend may replace this file with its own (the
 * export keeps a host's copy) when its identities need another rule.
 */
export function ownUserIdentityKey(userId: string): string {
  return `user|${userId}`;
}

export async function identityKey(ctx: { readonly auth: Auth }): Promise<string | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  const ownSignIn = process.env.CONVEX_SITE_URL !== undefined && identity.issuer === process.env.CONVEX_SITE_URL;
  const userId = identity.subject.split("|")[0];
  return ownSignIn && userId ? ownUserIdentityKey(userId) : identity.tokenIdentifier;
}
