import type { AuthConfig } from "convex/server";

declare const process: { readonly env: Readonly<Record<string, string | undefined>> };

/**
 * The deployment's own sign-in (convex/auth.ts) issues the web app's tokens.
 * The desktop does not sign in: it authorizes with the sync key.
 */
export default {
  providers: [{ domain: process.env.CONVEX_SITE_URL!, applicationID: "convex" }],
} satisfies AuthConfig;
