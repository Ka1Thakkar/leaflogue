import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { beginSignIn, completeSignIn, endSession, localReader, SESSION_COOKIE, SESSION_DAYS, sessionUser, STATE_COOKIE } from "./auth";
import type { PostgresClient } from "@leaflogue/remote";
import type { ServerConfig } from "./config";
import type { Fetch, RequestContext } from "./context";
import type { Database } from "./database";
import { ServerError } from "./errors";
import { callFunction } from "./functions";

/**
 * The HTTP surface:
 *
 *   GET  /auth/sign-in        start signing in with the configured provider
 *   GET  /auth/callback       the provider sends the reader back here
 *   POST /auth/sign-out       end this session
 *   GET  /api/session         who is signed in
 *   POST /api/run             { path, args } → { status, value } or an error,
 *                             the shape of Convex's HTTP API
 *   GET  /healthz             liveness
 *
 * and, when LEAFLOGUE_WEB_ROOT is set, the built web client from the same
 * origin. Session cookies are HttpOnly and SameSite=Lax; every POST must come
 * from the public origin with a JSON body, which a cross-site form cannot send.
 */

const MAX_BODY_BYTES = 16 * 1024 * 1024;

export interface ServerOptions {
  readonly config: ServerConfig;
  readonly database: Database;
  readonly fetch?: Fetch;
  readonly log?: (message: string, error?: unknown) => void;
}

function cookies(request: IncomingMessage): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) result.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return result;
}

function cookie(config: ServerConfig, name: string, value: string, options: { path: string; maxAge: number }): string {
  const secure = config.publicUrl.protocol === "https:";
  return [`${name}=${value}`, `Path=${options.path}`, `Max-Age=${options.maxAge}`, "HttpOnly", "SameSite=Lax", ...(secure ? ["Secure"] : [])].join("; ");
}

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
};

function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  const payload = body === undefined ? "" : JSON.stringify(body);
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "cache-control": "no-store",
    ...(body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }),
    ...headers,
  });
  response.end(payload);
}

function redirect(response: ServerResponse, location: string, headers: Record<string, string | string[]> = {}): void {
  response.writeHead(302, { ...SECURITY_HEADERS, "cache-control": "no-store", location, ...headers });
  response.end();
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).byteLength;
    if (size > MAX_BODY_BYTES) throw new ServerError("LEAFLOGUE_REQUEST_TOO_LARGE", "The request is too large", 413);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ServerError("LEAFLOGUE_REQUEST_INVALID", "The request body must be JSON");
  }
}

/** POSTs come only from the public origin, as JSON. */
function requireSameOrigin(request: IncomingMessage, config: ServerConfig, json: boolean): void {
  if (request.headers.origin !== config.publicUrl.origin) throw new ServerError("LEAFLOGUE_ORIGIN_REFUSED", "Requests must come from this site", 403);
  if (json && !request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw new ServerError("LEAFLOGUE_REQUEST_INVALID", "Send the request as JSON", 415);
  }
}

/**
 * What a client may see of a failure. Library mutations throw plain `Error`s
 * with messages written for readers; anything else (database errors, bugs)
 * is logged and reported without details.
 */
function describe(error: unknown): { status: number; code: string; message: string; logged: boolean } {
  if (error instanceof ServerError) return { status: error.status, code: error.code, message: error.message, logged: false };
  if (error instanceof Error && "code" in error && typeof error.code === "string" && error.code.startsWith("LEAFLOGUE_")) {
    return { status: 409, code: error.code, message: error.message, logged: false };
  }
  if (error instanceof Error && error.constructor === Error && !("code" in error)) {
    return { status: 400, code: "LEAFLOGUE_REQUEST_FAILED", message: error.message, logged: false };
  }
  return { status: 500, code: "LEAFLOGUE_SERVER_ERROR", message: "Something went wrong on the server. Try again shortly.", logged: true };
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

const WEB_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  // The web client reads an e-reader's SQLite database with WebAssembly.
  "script-src 'self' 'wasm-unsafe-eval'",
  "img-src 'self' https: data:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Serve the built web client; unknown paths get index.html so client-side routes work. */
async function serveStatic(response: ServerResponse, root: string, pathname: string): Promise<boolean> {
  const base = resolve(root);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (decoded.includes("\0")) return false;
  let file = normalize(join(base, decoded));
  if (file !== base && !file.startsWith(base + sep)) return false;
  let info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) {
    if (extname(decoded)) return false;
    file = join(base, "index.html");
    info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) return false;
  }
  const hashed = decoded.startsWith("/assets/");
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "content-length": String(info.size),
    "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
    "content-security-policy": WEB_CONTENT_SECURITY_POLICY,
  });
  createReadStream(file).pipe(response);
  return true;
}

export function createLeaflogueServer(options: ServerOptions): Server {
  const { config, database } = options;
  const fetchImplementation: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const log = options.log ?? ((message: string, error?: unknown) => console.error(message, error));

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", config.publicUrl);
    const method = request.method ?? "GET";
    const jar = cookies(request);
    const session = jar.get(SESSION_COOKIE);

    if (url.pathname === "/healthz" && method === "GET") return send(response, 200, { ok: true });
    // The web client asks which backend it is talking to; this one is the server.
    if (url.pathname === "/config.json" && method === "GET") return send(response, 200, { backend: "server" });
    const reader = (client: PostgresClient) => config.oidc ? sessionUser(client, config, session) : localReader(client, config);

    if (url.pathname === "/auth/sign-in" && method === "GET") {
      if (!config.oidc) return redirect(response, "/");
      const { location, state } = await database.withClient((client) => beginSignIn(client, config, fetchImplementation));
      return redirect(response, location, { "set-cookie": cookie(config, STATE_COOKIE, state, { path: "/auth", maxAge: 600 }) });
    }

    if (url.pathname === "/auth/callback" && method === "GET") {
      const clearState = cookie(config, STATE_COOKIE, "", { path: "/auth", maxAge: 0 });
      try {
        const token = await database.withClient((client) => completeSignIn(client, config, {
          code: url.searchParams.get("code") ?? "",
          state: url.searchParams.get("state") ?? "",
          cookieState: jar.get(STATE_COOKIE),
        }, fetchImplementation));
        return redirect(response, "/", {
          "set-cookie": [clearState, cookie(config, SESSION_COOKIE, token, { path: "/", maxAge: SESSION_DAYS * 24 * 60 * 60 })],
        });
      } catch (error) {
        const { code, logged } = describe(error);
        if (logged) log("Sign-in failed", error);
        return redirect(response, `/?sign_in_error=${encodeURIComponent(code)}`, { "set-cookie": clearState });
      }
    }

    if (url.pathname === "/auth/sign-out" && method === "POST") {
      requireSameOrigin(request, config, false);
      await database.withClient((client) => endSession(client, session));
      return send(response, 204, undefined, { "set-cookie": cookie(config, SESSION_COOKIE, "", { path: "/", maxAge: 0 }) });
    }

    if (url.pathname === "/api/session" && method === "GET") {
      const user = await database.withClient(reader);
      return send(response, 200, user ? { signedIn: true, email: user.email } : { signedIn: false });
    }

    if (url.pathname === "/api/run" && method === "POST") {
      requireSameOrigin(request, config, true);
      const body = await readJson(request);
      if (!body || typeof body !== "object" || typeof (body as { path?: unknown }).path !== "string") {
        throw new ServerError("LEAFLOGUE_REQUEST_INVALID", "Name the function to run in `path`");
      }
      const { path, args } = body as { path: string; args?: unknown };
      const value = await database.withClient(async (client) => {
        const context: RequestContext = { client, config, user: await reader(client), fetch: fetchImplementation };
        return callFunction(context, path, args);
      });
      return send(response, 200, { status: "success", value: value === undefined ? null : value });
    }

    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) {
      throw new ServerError("LEAFLOGUE_NOT_FOUND", "Not found", 404);
    }
    if (config.webRoot && (method === "GET" || method === "HEAD") && await serveStatic(response, config.webRoot, url.pathname)) return;
    throw new ServerError("LEAFLOGUE_NOT_FOUND", "Not found", 404);
  }

  return createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      const { status, code, message, logged } = describe(error);
      if (logged) log(`Request failed: ${request.method} ${request.url?.split("?")[0]}`, error);
      if (response.headersSent) {
        response.destroy();
        return;
      }
      send(response, status, { status: "error", errorMessage: message, errorData: { code, message } });
    });
  });
}
