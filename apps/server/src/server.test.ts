import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { COMPANION_PROMPTS } from "@leaflogue/ai";
import { WEB_DEVICE_ID } from "@leaflogue/contracts";
import { checkPostgres, PostgresLibraryMutations, REMOTE_SCHEMA_VERSION } from "@leaflogue/remote";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConfig, type ServerConfig } from "./config";
import type { Database } from "./database";
import { createLeaflogueServer } from "./http";
import { pgliteDatabase } from "./pglite";
import { prepareDatabase } from "./web-schema";

/**
 * The server end to end: real HTTP, a real PostgreSQL (PGlite in-process),
 * and stand-ins for the sign-in provider, Gemini, and Google Books.
 */

const ORIGIN = "http://localhost:5173";
const ISSUER = "https://accounts.google.com";
const CLIENT_ID = "leaflogue-test-client";
const OWNER = "reader@example.test";

interface Identity { email: string; sub: string; emailVerified?: boolean; nonce?: string; aud?: string }

let pglite: PGlite;
let database: Database;
let server: Server;
let base: string;
let config: ServerConfig;
let identity: Identity;
let geminiAnswers: string[];
let geminiCalls: { url: string; body: string }[];
let issuedNonce: string | undefined;

function idToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part(claims)}.signature`;
}

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url === `${ISSUER}/.well-known/openid-configuration`) {
    return json({ issuer: ISSUER, authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth", token_endpoint: "https://oauth2.googleapis.com/token" });
  }
  if (url === "https://oauth2.googleapis.com/token") {
    const form = new URLSearchParams(String(init?.body));
    if (form.get("client_secret") !== "test-secret" || !form.get("code_verifier")) return json({ error: "invalid_client" }, 401);
    const now = Math.floor(Date.now() / 1000);
    return json({
      id_token: idToken({
        iss: ISSUER, aud: identity.aud ?? CLIENT_ID, sub: identity.sub, email: identity.email,
        email_verified: identity.emailVerified ?? true, nonce: identity.nonce ?? issuedNonce, iat: now, exp: now + 3600,
      }),
    });
  }
  if (url.startsWith("https://generativelanguage.googleapis.com/")) {
    geminiCalls.push({ url, body: String(init?.body) });
    return json({ candidates: [{ content: { parts: [{ text: geminiAnswers.shift() ?? "" }] } }] });
  }
  if (url.startsWith("https://www.googleapis.com/books/v1/volumes")) {
    return json({ items: [{ id: "glass1", volumeInfo: { title: "The Glass Orchard", authors: ["Imogen Vale"], publisher: "Lantern" } }] });
  }
  throw new Error(`Unexpected request to ${url}`);
}

async function start(env: Record<string, string> = {}): Promise<void> {
  config = readConfig({
    DATABASE_URL: "pglite://memory",
    LEAFLOGUE_PUBLIC_URL: ORIGIN,
    LEAFLOGUE_OIDC_CLIENT_ID: CLIENT_ID,
    LEAFLOGUE_OIDC_CLIENT_SECRET: "test-secret",
    AUTH_ALLOWED_EMAILS: `${OWNER}, Second@Example.test`,
    ...env,
  });
  server = createLeaflogueServer({ config, database, fetch: fakeFetch, log: () => undefined });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  pglite = new PGlite();
  database = pgliteDatabase(pglite);
  await prepareDatabase(database);
  identity = { email: OWNER, sub: "owner-sub" };
  geminiAnswers = [];
  geminiCalls = [];
  issuedNonce = undefined;
  await start();
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pglite.close();
});

function setCookies(response: Response): Map<string, string> {
  const result = new Map<string, string>();
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";");
    const index = pair!.indexOf("=");
    result.set(pair!.slice(0, index), pair!.slice(index + 1));
  }
  return result;
}

/** Sign in as `identity` and return the session cookie, or the callback's redirect when refused. */
async function signIn(overrides: Partial<{ state: string }> = {}): Promise<{ cookie?: string; location: string }> {
  const begin = await fetch(`${base}/auth/sign-in`, { redirect: "manual" });
  expect(begin.status).toBe(302);
  const authorize = new URL(begin.headers.get("location")!);
  expect(authorize.origin + authorize.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorize.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
  issuedNonce = authorize.searchParams.get("nonce")!;
  const state = setCookies(begin).get("leaflogue_sign_in")!;
  const callback = await fetch(`${base}/auth/callback?code=provider-code&state=${overrides.state ?? authorize.searchParams.get("state")}`, {
    redirect: "manual",
    headers: { cookie: `leaflogue_sign_in=${state}` },
  });
  expect(callback.status).toBe(302);
  const session = setCookies(callback).get("leaflogue_session");
  return { ...(session ? { cookie: `leaflogue_session=${session}` } : {}), location: callback.headers.get("location")! };
}

async function run<T = unknown>(cookie: string | undefined, path: string, args: Record<string, unknown> = {}, origin = ORIGIN) {
  const response = await fetch(`${base}/api/run`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ path, args }),
  });
  const body = await response.json() as { status: "success"; value: T } | { status: "error"; errorData: { code: string; message: string } };
  return { http: response.status, ...body } as { http: number } & typeof body;
}

async function value<T>(cookie: string | undefined, path: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await run<T>(cookie, path, args);
  if (result.status !== "success") throw new Error(`${path}: ${result.errorData.code} ${result.errorData.message}`);
  return result.value;
}

async function owner() {
  const { cookie } = await signIn();
  const [library] = await value<{ libraryId: string; role: string }[]>(cookie, "access:myLibraries");
  return { cookie: cookie!, libraryId: library!.libraryId };
}

async function bookWithPassage(cookie: string, libraryId: string) {
  const bookId = randomUUID();
  const highlightId = randomUUID();
  const noteId = randomUUID();
  await value(cookie, "runtime:createBook", { libraryId, id: bookId, title: "The Glass Orchard", authors: ["Imogen Vale"], publisher: "Lantern" });
  const highlight = await value<{ id: string; revision: number }>(cookie, "runtime:createHighlight", {
    libraryId, id: highlightId, bookId, text: "Every pane held a season.", noteId, noteMarkdown: "Seasons as windows.",
  });
  return { bookId, highlightId, noteId, highlight };
}

describe("schema", () => {
  it("keeps the version desktops check unchanged", async () => {
    await database.withClient(async (client) => {
      await expect(checkPostgres("pglite", () => client)).resolves.toMatchObject({ initialized: true, schemaVersion: REMOTE_SCHEMA_VERSION });
    });
    await prepareDatabase(database);
  });
});

describe("sign-in", () => {
  it("signs in an allowed email and makes it the owner of a new library", async () => {
    const { cookie, location } = await signIn();
    expect(location).toBe("/");
    const session = await (await fetch(`${base}/api/session`, { headers: { cookie: cookie! } })).json();
    expect(session).toEqual({ signedIn: true, email: OWNER });
    const libraries = await value<{ libraryId: string; role: string }[]>(cookie, "access:myLibraries");
    expect(libraries).toEqual([{ libraryId: expect.any(String), role: "owner" }]);

    identity = { email: "second@example.test", sub: "second-sub" };
    const second = await signIn();
    expect(await value(second.cookie, "access:myLibraries")).toEqual(libraries);
  });

  it("refuses emails that are not allowed or not verified", async () => {
    identity = { email: "stranger@example.test", sub: "stranger" };
    expect(await signIn()).toEqual({ location: "/?sign_in_error=LEAFLOGUE_ACCESS_DENIED" });
    identity = { email: OWNER, sub: "owner-sub", emailVerified: false };
    expect(await signIn()).toEqual({ location: "/?sign_in_error=LEAFLOGUE_ACCESS_DENIED" });
  });

  it("refuses a mismatched state, a replayed nonce, or a token for another app", async () => {
    expect(await signIn({ state: "forged" })).toEqual({ location: "/?sign_in_error=LEAFLOGUE_SIGN_IN_FAILED" });
    identity = { email: OWNER, sub: "owner-sub", nonce: "old-nonce" };
    expect(await signIn()).toEqual({ location: "/?sign_in_error=LEAFLOGUE_SIGN_IN_FAILED" });
    identity = { email: OWNER, sub: "owner-sub", aud: "someone-else" };
    expect(await signIn()).toEqual({ location: "/?sign_in_error=LEAFLOGUE_SIGN_IN_FAILED" });
  });

  it("ends a session on sign-out, and when the email leaves the allowlist", async () => {
    const { cookie } = await signIn();
    const out = await fetch(`${base}/auth/sign-out`, { method: "POST", headers: { cookie: cookie!, origin: ORIGIN } });
    expect(out.status).toBe(204);
    expect((await run(cookie, "access:myLibraries")).http).toBe(401);

    const again = await signIn();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await start({ AUTH_ALLOWED_EMAILS: "someone@example.test" });
    expect(await run(again.cookie, "access:myLibraries")).toMatchObject({ http: 401, errorData: { code: "LEAFLOGUE_AUTH_REQUIRED" } });
  });
});

describe("without sign-in", () => {
  it("serves its one local reader the library, and says it is the server backend", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await start({ LEAFLOGUE_AUTH: "none" });
    expect(await (await fetch(`${base}/config.json`)).json()).toEqual({ backend: "server" });
    expect(await (await fetch(`${base}/api/session`)).json()).toEqual({ signedIn: true, email: "reader@localhost" });
    const signIn = await fetch(`${base}/auth/sign-in`, { redirect: "manual" });
    expect(signIn.headers.get("location")).toBe("/");
    const libraries = await value<{ libraryId: string; role: string }[]>(undefined, "access:myLibraries");
    expect(libraries).toEqual([{ libraryId: expect.any(String) as string, role: "owner" }]);
    expect(await value(undefined, "access:myLibraries")).toEqual(libraries);
  });
});

describe("API", () => {
  it("refuses other origins, unknown functions, unexpected arguments, and strangers", async () => {
    const { cookie, libraryId } = await owner();
    expect(await run(cookie, "access:myLibraries", {}, "https://evil.example")).toMatchObject({ http: 403, errorData: { code: "LEAFLOGUE_ORIGIN_REFUSED" } });
    expect(await run(cookie, "library:createBook")).toMatchObject({ http: 404, errorData: { code: "LEAFLOGUE_FUNCTION_UNKNOWN" } });
    expect(await run(cookie, "runtime:createNote", { libraryId, id: randomUUID(), bookId: randomUUID(), markdown: "x", origin: "import" }))
      .toMatchObject({ http: 400, errorData: { code: "LEAFLOGUE_REQUEST_INVALID" } });
    expect(await run(undefined, "reading:listBooks", { libraryId, paginationOpts: { numItems: 10, cursor: null } }))
      .toMatchObject({ http: 401, errorData: { code: "LEAFLOGUE_AUTH_REQUIRED" } });
    expect(await run(cookie, "reading:listBooks", { libraryId: randomUUID(), paginationOpts: { numItems: 10, cursor: null } }))
      .toMatchObject({ http: 403, errorData: { code: "LEAFLOGUE_ACCESS_DENIED" } });
  });

  it("lets viewers read but not write", async () => {
    const { cookie, libraryId } = await owner();
    identity = { email: "second@example.test", sub: "second-sub" };
    const second = await signIn();
    await database.withClient((client) => client.query(`
      UPDATE leaflogue_web.library_members SET role = 'viewer'
      WHERE user_id = (SELECT id FROM leaflogue_web.users WHERE subject = 'second-sub')
    `, []));
    await bookWithPassage(cookie, libraryId);
    const books = await value<{ page: unknown[] }>(second.cookie, "reading:listBooks", { libraryId, paginationOpts: { numItems: 10, cursor: null } });
    expect(books.page).toHaveLength(1);
    expect(await run(second.cookie, "runtime:createBook", { libraryId, id: randomUUID(), title: "Nope" }))
      .toMatchObject({ http: 403, errorData: { code: "LEAFLOGUE_ACCESS_DENIED" } });
  });

  it("writes the library the way desktops pull it, and reads it back in Convex's shapes", async () => {
    const { cookie, libraryId } = await owner();
    const { bookId, highlightId, noteId } = await bookWithPassage(cookie, libraryId);
    const books = await value<{ page: Record<string, unknown>[]; isDone: boolean }>(cookie, "reading:listBooks", { libraryId, paginationOpts: { numItems: 10, cursor: null } });
    expect(books).toMatchObject({ isDone: true, page: [{ id: bookId, title: "The Glass Orchard", publisher: "Lantern", highlightCount: 1, noteCount: 1 }] });
    const highlights = await value<{ page: Record<string, unknown>[] }>(cookie, "reading:listHighlights", { libraryId, bookId, paginationOpts: { numItems: 10, cursor: null } });
    expect(highlights.page).toEqual([expect.objectContaining({ id: highlightId, text: "Every pane held a season." })]);
    const notes = await value<{ page: Record<string, unknown>[] }>(cookie, "reading:listNotes", { libraryId, bookId, paginationOpts: { numItems: 10, cursor: null } });
    expect(notes.page).toEqual([expect.objectContaining({ id: noteId, highlightId, origin: "reader" })]);
    const changes = await value<{ page: { entityType: string }[]; resetRequired: boolean }>(cookie, "reading:listChanges", {
      libraryId, cursor: { generation: 1, afterSequence: 0 }, limit: 50,
    });
    expect(changes.resetRequired).toBe(false);
    expect(new Set(changes.page.map((change) => change.entityType))).toEqual(new Set(["book", "highlight", "note"]));

    const pulled = await database.withClient(async (client) => {
      const desktop = new PostgresLibraryMutations(client, libraryId);
      return desktop.readSyncedChangePage(await desktop.syncOrigin(), 50);
    });
    const highlightChange = pulled.changes.find((change) => change?.entityType === "highlight");
    expect(highlightChange).toMatchObject({ deviceId: WEB_DEVICE_ID, operation: "upsert" });
  });
});

describe("features", () => {
  it("keeps each reader's dashboard layouts, without custom widgets", async () => {
    const { cookie, libraryId } = await owner();
    expect(await value(cookie, "dashboardRuntime:layouts", { libraryId })).toEqual({});
    const saved = await value(cookie, "dashboardRuntime:saveLayout", {
      libraryId, dashboard: "library", layout: [{ widget: "on-this-day", width: "half", tall: true }, { widget: "shelf" }, { widget: "passages", width: "full" }],
    });
    expect(saved).toEqual({ library: [{ widget: "on-this-day", width: "half", tall: true }, { widget: "shelf" }, { widget: "passages" }] });
    identity = { email: "second@example.test", sub: "second-sub" };
    const second = await signIn();
    await database.withClient((client) => client.query(`
      UPDATE leaflogue_web.library_members SET role = 'viewer'
      WHERE user_id = (SELECT id FROM leaflogue_web.users WHERE subject = 'second-sub')
    `, []));
    // A viewer arranges their own view; the owner's stays as it was.
    await value(second.cookie, "dashboardRuntime:saveLayout", { libraryId, dashboard: "statistics", layout: [{ widget: "hours" }] });
    expect(await value(second.cookie, "dashboardRuntime:layouts", { libraryId })).toEqual({ statistics: [{ widget: "hours" }] });
    expect(await value(cookie, "dashboardRuntime:layouts", { libraryId })).toEqual(saved);
    expect(await run(cookie, "dashboardRuntime:saveLayout", { libraryId, dashboard: "library", layout: [{ widget: "custom:mine" }] }))
      .toMatchObject({ http: 400, errorData: { code: "LEAFLOGUE_INVALID_LAYOUT" } });
    expect(await run(undefined, "dashboardRuntime:layouts", { libraryId })).toMatchObject({ http: 401 });
    expect(await value(cookie, "dashboardRuntime:saveLayout", { libraryId, dashboard: "library", layout: null })).toEqual({});
  });

  it("looks up books", async () => {
    const { cookie, libraryId } = await owner();
    const result = await value<{ source: string; items: { title: string }[] }>(cookie, "catalogRuntime:search", { libraryId, query: "glass orchard" });
    expect(result).toMatchObject({ source: "google-books", items: [{ title: "The Glass Orchard", publisher: "Lantern" }] });
  });

  it("runs the companion with the chosen provider and the server's key, within the hourly limit", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await start({ GEMINI_API_KEY: "secret-gemini-key", LEAFLOGUE_AI_HOURLY_LIMIT: "1" });
    const { cookie, libraryId } = await owner();
    const { highlightId } = await bookWithPassage(cookie, libraryId);
    const settings = await value<{ providers: { id: string; configured: boolean }[]; selected: unknown }>(cookie, "aiRuntime:settings", { libraryId });
    expect(settings.providers.find((provider) => provider.id === "gemini")).toMatchObject({ configured: true });
    expect(JSON.stringify(settings)).not.toContain("secret-gemini-key");
    expect(await run(cookie, "aiRuntime:setSettings", { libraryId, provider: "openai", model: "gpt-5-mini" }))
      .toMatchObject({ errorData: { code: "LEAFLOGUE_AI_UNCONFIGURED" } });
    await value(cookie, "aiRuntime:setSettings", { libraryId, provider: "gemini", model: "gemini-3.8-flash" });

    geminiAnswers = ["Each pane frames a season."];
    const answer = await value(cookie, "aiRuntime:companion", { libraryId, highlightId, prompt: COMPANION_PROMPTS.explain, history: [] });
    expect(answer).toEqual({ answer: "Each pane frames a season.", remaining: 0, saveable: true });
    expect(geminiCalls).toHaveLength(1);
    expect(geminiCalls[0]!.body).toContain("Every pane held a season.");
    expect(geminiCalls[0]!.body).not.toContain("Seasons as windows.");
    expect(await run(cookie, "aiRuntime:companion", { libraryId, highlightId, prompt: COMPANION_PROMPTS.explain, history: [] }))
      .toMatchObject({ http: 429, errorData: { code: "LEAFLOGUE_AI_LIMIT" } });
  });

  it("publishes a frozen passage, hides it once edited, and takes anonymous reports", async () => {
    const { cookie, libraryId } = await owner();
    const { bookId, highlightId, noteId, highlight } = await bookWithPassage(cookie, libraryId);
    expect(await run(cookie, "publicationRuntime:publish", { libraryId, highlightId, noteIds: [], rightsConfirmed: false }))
      .toMatchObject({ errorData: { code: "LEAFLOGUE_PUBLICATION_INVALID" } });
    const { publicId } = await value<{ publicId: string }>(cookie, "publicationRuntime:publish", { libraryId, highlightId, noteIds: [noteId], rightsConfirmed: true });

    const shared = await value(undefined, "publicationRuntime:get", { publicId });
    expect(shared).toEqual({
      publicId, passage: "Every pane held a season.", bookTitle: "The Glass Orchard", authors: ["Imogen Vale"],
      notes: [{ markdown: "Seasons as windows.", ai: false }], publishedAt: expect.any(Number),
    });
    const mine = await value<{ page: { publicId: string; needsReview: boolean }[] }>(cookie, "publicationRuntime:listMine", { libraryId, paginationOpts: { numItems: 10, cursor: null } });
    expect(mine.page).toEqual([expect.objectContaining({ publicId, needsReview: false, notes: 1 })]);

    const reporterKey = "r".repeat(32);
    await value(undefined, "publicationRuntime:report", { publicId, reporterKey, reason: "copyright" });

    await value(cookie, "runtime:updateHighlight", { libraryId, id: highlightId, bookId, text: "Every pane held a different season.", expectedRevision: highlight.revision });
    expect(await value(undefined, "publicationRuntime:get", { publicId })).toBeNull();
    expect(await value(cookie, "publicationRuntime:settings", { libraryId, highlightId })).toMatchObject({ publicId, needsReview: true });
    await value(cookie, "publicationRuntime:publish", { libraryId, highlightId, noteIds: [], rightsConfirmed: true });
    expect(await value(undefined, "publicationRuntime:get", { publicId })).toMatchObject({ passage: "Every pane held a different season.", notes: [] });
    await value(cookie, "publicationRuntime:withdraw", { libraryId, publicId });
    expect(await value(undefined, "publicationRuntime:get", { publicId })).toBeNull();
  });

  it("imports in batches, skips what is unchanged, and keeps the reader's edits as conflicts", async () => {
    const { cookie, libraryId } = await owner();
    const { sourceId } = await value<{ sourceId: string }>(cookie, "importRuntime:createSource", { libraryId, provider: "kobo", name: "  My   Kobo " });
    expect(await value(cookie, "importRuntime:listSources", { libraryId })).toEqual([expect.objectContaining({ id: sourceId, name: "My Kobo" })]);
    const books = [{ providerRecordId: "book-1", title: "The Glass Orchard", authors: ["Imogen Vale"], status: "reading" }];
    const annotations = [
      { providerRecordId: "a-1", bookProviderRecordId: "book-1", text: "Every pane held a season.", note: "Windows.", createdAt: 1_700_000_000_000 },
      { providerRecordId: "a-2", bookProviderRecordId: "book-1", note: "A standalone thought." },
      { providerRecordId: "a-3", bookProviderRecordId: "book-1" },
    ];
    expect(await value(cookie, "importRuntime:importAnnotations", { libraryId, sourceId, annotations: [{ ...annotations[0], bookProviderRecordId: "missing" }] }).catch((error: Error) => error.message))
      .toContain("LEAFLOGUE_IMPORT_INVALID");
    expect(await value(cookie, "importRuntime:importBooks", { libraryId, sourceId, books })).toEqual({ booksCreated: 1, booksReused: 0 });
    expect(await value(cookie, "importRuntime:importAnnotations", { libraryId, sourceId, annotations }))
      .toEqual({ highlightsCreated: 1, notesCreated: 1, annotationsUpdated: 0, conflictsCreated: 0, unchanged: 0, skipped: 1 });

    const [book] = (await value<{ page: { id: string; status: string; noteCount: number }[] }>(cookie, "reading:listBooks", { libraryId, paginationOpts: { numItems: 10, cursor: null } })).page;
    expect(book).toMatchObject({ status: "reading", noteCount: 2 });
    const notes = await value<{ page: { origin: string }[] }>(cookie, "reading:listNotes", { libraryId, bookId: book!.id, paginationOpts: { numItems: 10, cursor: null } });
    expect(notes.page.map((note) => note.origin)).toEqual(["import", "import"]);
    const [highlight] = (await value<{ page: { id: string; revision: number; sourceCreatedAt?: number }[] }>(cookie, "reading:listHighlights", {
      libraryId, bookId: book!.id, paginationOpts: { numItems: 10, cursor: null },
    })).page;
    expect(highlight!.sourceCreatedAt).toBe(1_700_000_000_000);

    // Sending the same batch again changes nothing.
    expect(await value(cookie, "importRuntime:importBooks", { libraryId, sourceId, books })).toEqual({ booksCreated: 0, booksReused: 1 });
    expect(await value(cookie, "importRuntime:importAnnotations", { libraryId, sourceId, annotations }))
      .toMatchObject({ highlightsCreated: 0, notesCreated: 0, unchanged: 2, skipped: 1 });

    // An untouched passage follows the source; an edited one becomes a conflict.
    const changed = [{ ...annotations[0], text: "Every pane held two seasons." }];
    expect(await value(cookie, "importRuntime:importAnnotations", { libraryId, sourceId, annotations: changed })).toMatchObject({ annotationsUpdated: 1 });
    const updated = (await value<{ page: { id: string; text: string; revision: number }[] }>(cookie, "reading:listHighlights", {
      libraryId, bookId: book!.id, paginationOpts: { numItems: 10, cursor: null },
    })).page[0]!;
    expect(updated.text).toBe("Every pane held two seasons.");
    await value(cookie, "runtime:updateHighlight", { libraryId, id: updated.id, bookId: book!.id, text: "My own wording.", expectedRevision: updated.revision });
    const again = [{ ...annotations[0], text: "Every pane held three seasons." }];
    expect(await value(cookie, "importRuntime:importAnnotations", { libraryId, sourceId, annotations: again })).toMatchObject({ conflictsCreated: 1 });
    const [conflict] = await value<{ id: string; sourceName: string }[]>(cookie, "importRuntime:listConflicts", { libraryId });
    expect(conflict).toMatchObject({ sourceName: "My Kobo" });
    await value(cookie, "importRuntime:resolveConflict", { libraryId, conflictId: conflict!.id, resolution: "accept-incoming" });
    expect(await value(cookie, "importRuntime:listConflicts", { libraryId })).toEqual([]);
    const resolved = (await value<{ page: { text: string }[] }>(cookie, "reading:listHighlights", {
      libraryId, bookId: book!.id, paginationOpts: { numItems: 10, cursor: null },
    })).page[0]!;
    expect(resolved.text).toBe("Every pane held three seasons.");

    // The reader edits it again, then puts the imported version back.
    const latest = (await value<{ page: { id: string; revision: number }[] }>(cookie, "reading:listHighlights", {
      libraryId, bookId: book!.id, paginationOpts: { numItems: 10, cursor: null },
    })).page[0]!;
    expect(await value(cookie, "importRuntime:importedVersion", { libraryId, highlightId: latest.id })).toMatchObject({ edited: false });
    await value(cookie, "runtime:updateHighlight", { libraryId, id: latest.id, bookId: book!.id, text: "Mine again.", expectedRevision: latest.revision });
    expect(await value(cookie, "importRuntime:importedVersion", { libraryId, highlightId: latest.id }))
      .toEqual({ text: "Every pane held three seasons.", note: "Windows.", edited: true });
    await value(cookie, "importRuntime:resetToImported", { libraryId, highlightId: latest.id });
    expect(await value(cookie, "importRuntime:importedVersion", { libraryId, highlightId: latest.id })).toMatchObject({ edited: false });
  });

  it("rolls back a whole import batch when one record fails", async () => {
    const { cookie, libraryId } = await owner();
    const { sourceId } = await value<{ sourceId: string }>(cookie, "importRuntime:createSource", { libraryId, provider: "kindle", name: "Kindle" });
    const result = await run(cookie, "importRuntime:importBooks", {
      libraryId, sourceId,
      books: [
        { providerRecordId: "ok", title: "Fine", authors: [] },
        { providerRecordId: "bad", title: "Broken", authors: [], isbn13: "not-an-isbn" },
      ],
    });
    expect(result.status).toBe("error");
    const books = await value<{ page: unknown[] }>(cookie, "reading:listBooks", { libraryId, paginationOpts: { numItems: 10, cursor: null } });
    expect(books.page).toEqual([]);
  });
});
