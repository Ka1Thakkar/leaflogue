/**
 * Everything the server reads from its environment. Secrets (the database
 * URL, the sign-in client secret, AI keys) come only from here, which the
 * self-hoster sets directly or through a secret manager.
 */
export interface ServerConfig {
  readonly databaseUrl: string;
  /** The address readers open, such as https://reading.example.com. */
  readonly publicUrl: URL;
  readonly host: string;
  readonly port: number;
  /**
   * Sign-in through an OpenID Connect provider. Absent only with
   * LEAFLOGUE_AUTH=none, a single-reader server on this computer.
   */
  readonly oidc?: {
    readonly issuer: string;
    readonly clientId: string;
    readonly clientSecret: string;
  };
  /** Lower-cased emails allowed to sign in. Required: a server never opens to everyone. */
  readonly allowedEmails: ReadonlySet<string>;
  /** Which library to serve when the database holds several. */
  readonly libraryId?: string;
  /** Built web client to serve from the same origin, if any. */
  readonly webRoot?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** The one reader of a server without sign-in. */
export const LOCAL_READER_EMAIL = "reader@localhost";

const LOOPBACK = ["localhost", "127.0.0.1", "::1", "[::1]"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function readConfig(env: Readonly<Record<string, string | undefined>>): ServerConfig {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new ConfigError(`Set ${name}`);
    return value;
  };
  let publicUrl: URL;
  try {
    publicUrl = new URL(required("LEAFLOGUE_PUBLIC_URL"));
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError("LEAFLOGUE_PUBLIC_URL must be a full URL, such as https://reading.example.com");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(publicUrl.hostname);
  if (publicUrl.protocol !== "https:" && !(publicUrl.protocol === "http:" && local)) {
    throw new ConfigError("LEAFLOGUE_PUBLIC_URL must use https (http is allowed only for localhost)");
  }
  if (publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password) {
    throw new ConfigError("LEAFLOGUE_PUBLIC_URL must be an origin with no path, such as https://reading.example.com");
  }
  const auth = env.LEAFLOGUE_AUTH?.trim().toLowerCase() || "oidc";
  if (auth !== "oidc" && auth !== "none") throw new ConfigError("LEAFLOGUE_AUTH must be oidc or none");
  const signIn = auth === "oidc";
  const allowedEmails = signIn
    ? new Set(required("AUTH_ALLOWED_EMAILS").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean))
    : new Set([LOCAL_READER_EMAIL]);
  if (!allowedEmails.size) throw new ConfigError("Set AUTH_ALLOWED_EMAILS to the emails that may sign in");
  const port = Number(env.PORT ?? "8787");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new ConfigError("PORT must be a port number");
  const libraryId = env.LEAFLOGUE_LIBRARY_ID?.trim().toLowerCase();
  if (libraryId && !UUID.test(libraryId)) throw new ConfigError("LEAFLOGUE_LIBRARY_ID must be a library ID");
  const issuer = (env.LEAFLOGUE_OIDC_ISSUER?.trim() || "https://accounts.google.com").replace(/\/+$/u, "");
  const issuerUrl = URL.canParse(issuer) ? new URL(issuer) : undefined;
  if (!issuerUrl || (issuerUrl.protocol !== "https:" && !(issuerUrl.protocol === "http:" && ["localhost", "127.0.0.1"].includes(issuerUrl.hostname)))) {
    throw new ConfigError("LEAFLOGUE_OIDC_ISSUER must be an https URL");
  }
  const webRoot = env.LEAFLOGUE_WEB_ROOT?.trim();
  const host = env.HOST?.trim() || "127.0.0.1";
  // Without sign-in, anyone who reaches the server reads the library, so it
  // may only listen on this computer and be opened from it.
  if (!signIn && (!LOOPBACK.includes(host) || !LOOPBACK.includes(publicUrl.hostname))) {
    throw new ConfigError("LEAFLOGUE_AUTH=none works only on this computer: set HOST to 127.0.0.1 and LEAFLOGUE_PUBLIC_URL to a localhost address");
  }
  return {
    databaseUrl: required("DATABASE_URL"),
    publicUrl,
    host,
    port,
    ...(signIn ? {
      oidc: {
        issuer,
        clientId: required("LEAFLOGUE_OIDC_CLIENT_ID"),
        clientSecret: required("LEAFLOGUE_OIDC_CLIENT_SECRET"),
      },
    } : {}),
    allowedEmails,
    ...(libraryId ? { libraryId } : {}),
    ...(webRoot ? { webRoot } : {}),
    env,
  };
}
