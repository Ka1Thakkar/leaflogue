import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { PostgresClient } from "@leaflogue/remote";
import { LOCAL_READER_EMAIL, type ServerConfig } from "./config";
import { ServerError } from "./errors";
import { provisionOwner } from "./libraries";

/**
 * Sign-in through any OpenID Connect provider, Google by default. The server
 * runs the authorization code flow with PKCE and a nonce, takes the ID token
 * straight from the provider's token endpoint over TLS (which OpenID Connect
 * Core 3.1.3.7 accepts in place of checking its signature), and then lets in
 * only verified emails on AUTH_ALLOWED_EMAILS.
 *
 * Sessions are random tokens in an HttpOnly cookie; the database keeps only
 * their SHA-256, so a database leak does not hand out sessions.
 */

export const SESSION_COOKIE = "leaflogue_session";
export const STATE_COOKIE = "leaflogue_sign_in";
export const SESSION_DAYS = 30;
const SIGN_IN_MINUTES = 10;

import type { Fetch } from "./context";

interface ProviderMetadata {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
}

const discovered = new Map<string, Promise<ProviderMetadata>>();

const token = () => randomBytes(32).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest();

function secureEndpoint(value: unknown, issuer: string): string {
  if (typeof value !== "string" || !URL.canParse(value)) throw new ServerError("LEAFLOGUE_SIGN_IN_FAILED", "The sign-in provider is misconfigured", 502);
  const url = new URL(value);
  const local = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname) && new URL(issuer).protocol === "http:";
  if (url.protocol !== "https:" && !local) throw new ServerError("LEAFLOGUE_SIGN_IN_FAILED", "The sign-in provider is misconfigured", 502);
  return url.toString();
}

export function discoverProvider(issuer: string, fetchImplementation: Fetch = fetch): Promise<ProviderMetadata> {
  let pending = discovered.get(issuer);
  if (!pending) {
    pending = (async () => {
      const response = await fetchImplementation(`${issuer}/.well-known/openid-configuration`, { redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new ServerError("LEAFLOGUE_SIGN_IN_FAILED", "The sign-in provider is unavailable", 502);
      const metadata = await response.json() as Record<string, unknown>;
      if (metadata.issuer !== issuer) throw new ServerError("LEAFLOGUE_SIGN_IN_FAILED", "The sign-in provider is misconfigured", 502);
      return {
        issuer,
        authorizationEndpoint: secureEndpoint(metadata.authorization_endpoint, issuer),
        tokenEndpoint: secureEndpoint(metadata.token_endpoint, issuer),
      };
    })();
    discovered.set(issuer, pending);
    pending.catch(() => discovered.delete(issuer));
  }
  return pending;
}

export const redirectUri = (config: ServerConfig) => new URL("/auth/callback", config.publicUrl).toString();

/** Start signing in: remember the state, and send the reader to the provider. */
function requireOidc(config: ServerConfig): NonNullable<ServerConfig["oidc"]> {
  if (!config.oidc) throw new ServerError("LEAFLOGUE_SIGN_IN_DISABLED", "This server has no sign-in; it is open on this computer only.", 404);
  return config.oidc;
}

export async function beginSignIn(client: PostgresClient, config: ServerConfig, fetchImplementation: Fetch = fetch): Promise<{ location: string; state: string }> {
  const oidc = requireOidc(config);
  const provider = await discoverProvider(oidc.issuer, fetchImplementation);
  const state = token();
  const nonce = token();
  const codeVerifier = token();
  await client.query("DELETE FROM leaflogue_web.sign_in_states WHERE expires_at < now()", []);
  await client.query(`
    INSERT INTO leaflogue_web.sign_in_states (state_hash, nonce, code_verifier, expires_at)
    VALUES ($1, $2, $3, now() + make_interval(mins => $4))
  `, [hash(state), nonce, codeVerifier, SIGN_IN_MINUTES]);
  const location = new URL(provider.authorizationEndpoint);
  location.search = new URLSearchParams({
    response_type: "code",
    client_id: oidc.clientId,
    redirect_uri: redirectUri(config),
    scope: "openid email",
    state,
    nonce,
    code_challenge: createHash("sha256").update(codeVerifier).digest("base64url"),
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return { location: location.toString(), state };
}

function claims(idToken: unknown): Record<string, unknown> {
  if (typeof idToken !== "string") throw new ServerError("LEAFLOGUE_SIGN_IN_FAILED", "Sign-in failed. Try again.", 401);
  const parts = idToken.split(".");
  if (parts.length !== 3 || !parts[1]) throw new ServerError("LEAFLOGUE_SIGN_IN_FAILED", "Sign-in failed. Try again.", 401);
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) return payload as Record<string, unknown>;
  } catch {
    // Reported below.
  }
  throw new ServerError("LEAFLOGUE_SIGN_IN_FAILED", "Sign-in failed. Try again.", 401);
}

/** The issuers an ID token may name; Google also uses its bare host name. */
function acceptedIssuers(issuer: string): string[] {
  return issuer === "https://accounts.google.com" ? [issuer, "accounts.google.com"] : [issuer];
}

/**
 * Finish signing in. Returns a new session token, or throws when anything
 * does not check out, including an email that is not allowed.
 */
export async function completeSignIn(
  client: PostgresClient,
  config: ServerConfig,
  input: { readonly code: string; readonly state: string; readonly cookieState: string | undefined },
  fetchImplementation: Fetch = fetch,
): Promise<string> {
  const oidc = requireOidc(config);
  const failed = () => new ServerError("LEAFLOGUE_SIGN_IN_FAILED", "Sign-in failed. Try again.", 401);
  const { code, state, cookieState } = input;
  if (!code || !state || !cookieState || code.length > 4_096 || state.length > 100) throw failed();
  const expected = Buffer.from(cookieState);
  const actual = Buffer.from(state);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw failed();
  const pending = await client.query<{ nonce: string; code_verifier: string }>(
    "DELETE FROM leaflogue_web.sign_in_states WHERE state_hash = $1 AND expires_at > now() RETURNING nonce, code_verifier",
    [hash(state)],
  );
  const saved = pending.rows[0];
  if (!saved) throw failed();

  const provider = await discoverProvider(oidc.issuer, fetchImplementation);
  let response: Response;
  try {
    response = await fetchImplementation(provider.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri(config),
        client_id: oidc.clientId,
        client_secret: oidc.clientSecret,
        code_verifier: saved.code_verifier,
      }).toString(),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ServerError("LEAFLOGUE_SIGN_IN_FAILED", "The sign-in provider is unavailable", 502);
  }
  if (!response.ok) throw failed();
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  const identity = claims(body.id_token);

  const now = Math.floor(Date.now() / 1000);
  const audience = Array.isArray(identity.aud) ? identity.aud : [identity.aud];
  if (!acceptedIssuers(provider.issuer).includes(identity.iss as string)) throw failed();
  if (!audience.includes(oidc.clientId)) throw failed();
  if (audience.length > 1 && identity.azp !== oidc.clientId) throw failed();
  if (typeof identity.exp !== "number" || identity.exp <= now - 60) throw failed();
  if (typeof identity.iat !== "number" || identity.iat > now + 300) throw failed();
  if (identity.nonce !== saved.nonce) throw failed();
  if (typeof identity.sub !== "string" || !identity.sub || identity.sub.length > 255) throw failed();
  const email = typeof identity.email === "string" ? identity.email.trim().toLowerCase() : "";
  const verified = identity.email_verified === true || identity.email_verified === "true";
  if (!email || !verified || !config.allowedEmails.has(email)) {
    throw new ServerError("LEAFLOGUE_ACCESS_DENIED", "This account is not allowed to sign in here", 403);
  }

  const user = await client.query<{ id: string }>(`
    INSERT INTO leaflogue_web.users (id, issuer, subject, email) VALUES ($1, $2, $3, $4)
    ON CONFLICT (issuer, subject) DO UPDATE SET email = excluded.email
    RETURNING id::text AS id
  `, [randomUUID(), provider.issuer, identity.sub, email]);
  const userId = user.rows[0]?.id;
  if (!userId) throw failed();
  await provisionOwner(client, userId, config.libraryId);
  return createSession(client, userId);
}

export async function createSession(client: PostgresClient, userId: string): Promise<string> {
  const session = token();
  await client.query("DELETE FROM leaflogue_web.sessions WHERE expires_at < now()", []);
  await client.query(
    "INSERT INTO leaflogue_web.sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))",
    [hash(session), userId, SESSION_DAYS],
  );
  return session;
}

export interface SessionUser {
  readonly userId: string;
  readonly email: string;
}

/**
 * The reader behind a session, if it is still valid and their email is still
 * allowed: removing an email from AUTH_ALLOWED_EMAILS ends its sessions.
 */
export async function sessionUser(client: PostgresClient, config: ServerConfig, session: string | undefined): Promise<SessionUser | undefined> {
  if (!session || session.length > 100) return undefined;
  const result = await client.query<{ user_id: string; email: string }>(`
    SELECT users.id::text AS user_id, users.email FROM leaflogue_web.sessions AS sessions
    JOIN leaflogue_web.users AS users ON users.id = sessions.user_id
    WHERE sessions.token_hash = $1 AND sessions.expires_at > now()
  `, [hash(session)]);
  const row = result.rows[0];
  if (!row || !config.allowedEmails.has(row.email)) return undefined;
  return { userId: row.user_id, email: row.email };
}

const localReaders = new WeakMap<ServerConfig, SessionUser>();

/**
 * A server without sign-in (LEAFLOGUE_AUTH=none, on this computer only) has
 * one reader, who owns the library. Created on first use.
 */
export async function localReader(client: PostgresClient, config: ServerConfig): Promise<SessionUser> {
  const known = localReaders.get(config);
  if (known) return known;
  const user = await client.query<{ id: string }>(`
    INSERT INTO leaflogue_web.users (id, issuer, subject, email) VALUES ($1, 'local', 'reader', $2)
    ON CONFLICT (issuer, subject) DO UPDATE SET email = excluded.email
    RETURNING id::text AS id
  `, [randomUUID(), LOCAL_READER_EMAIL]);
  const userId = user.rows[0]?.id;
  if (!userId) throw new ServerError("LEAFLOGUE_SERVER_ERROR", "The local reader could not be created", 500);
  await provisionOwner(client, userId, config.libraryId);
  const reader = { userId, email: LOCAL_READER_EMAIL };
  localReaders.set(config, reader);
  return reader;
}

export async function endSession(client: PostgresClient, session: string | undefined): Promise<void> {
  if (session && session.length <= 100) await client.query("DELETE FROM leaflogue_web.sessions WHERE token_hash = $1", [hash(session)]);
}
