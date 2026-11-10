/* Capture actual renderers against a read-only library of published books.
   Start desktop preview on 5199 and Libredex dev on 3100 before running.
   No Convex connection is made. Covers and passages are checked-in sources. */
import { chromium } from "@playwright/test";
import { build } from "esbuild";
import { readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const host = resolve(process.argv[2] ?? join(root, "../libredex"));
const corpus = JSON.parse(readFileSync(join(root, "tests/marketing/books.json"), "utf8"));
const built = join(tmpdir(), "leaflogue-marketing-statistics.mjs");
await build({ entryPoints: [join(root, "packages/domain/src/library-statistics.ts")], bundle: true, platform: "node", format: "esm", outfile: built });
const { libraryStatistics } = await import(pathToFileURL(built).href);
const now = Date.UTC(2026, 10, 9, 12);
const id = (index) => `cc000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const books = corpus.map((entry, index) => ({
  id: entry.id, title: entry.title, authors: entry.authors, status: entry.status,
  coverUrl: `https://showcase.leaflogue.test/${entry.gutenbergId}.jpg`,
  archived: false, createdAt: now - (300 - index * 31) * 86400000, updatedAt: now - index * 86400000,
  revision: 1, highlightCount: entry.passages.length, collectionIds: [], tagIds: [], language: "en",
  ...(entry.status === "finished" ? { completedOn: `2026-0${index + 1}-18` } : {}),
}));
const highlights = corpus.flatMap((entry, bookIndex) => entry.passages.map((text, index) => {
  const highlightId = id(bookIndex * 100 + index);
  const at = now - (Math.floor(index / 3) * 9 + bookIndex * 28 + (index % 3 === 2 ? 1 : 0) + 1) * 86400000 - ((index * 7) % 21) * 3600000;
  return { id: highlightId, bookId: entry.id, text, sourceLocation: `Chapter ${Math.floor(index / 2) + 1}`, sourceCreatedAt: at, createdAt: at, updatedAt: at, revision: 1, notes: index === 2 || (index === 7 && bookIndex % 2 === 0) ? [{ id: id(9000 + bookIndex), bookId: entry.id, highlightId, markdown: ["First impressions are doing so much work here. Read this alongside Elizabeth's change of mind.", "The need to be understood comes before the anger. Worth returning to this when the narration changes.", "A useful distinction: choosing a simpler life is not the same as refusing the world.", "He notices the detail everyone else has decided is ordinary. That is the whole method.", "Beauty becomes a way of looking away. The portrait keeps the account.", "The distance between the life he describes and the life he wants is already there."][bookIndex], origin: "reader", createdAt: at, updatedAt: at, revision: 1 }] : [] };
}));
const entries = highlights.map(highlight => { const book = books.find(book => book.id === highlight.bookId); return { ...highlight, bookTitle: book.title, authors: book.authors, bookAuthors: book.authors, imported: true, importedVersion: null, tagIds: [], tags: [] }; });
const document = { format: "leaflogue-library", formatVersion: 4, exportedAt: new Date(now).toISOString(), books: books.map(book => ({ book, highlights: highlights.filter(highlight => highlight.bookId === book.id), standaloneNotes: [] })), collections: [], tags: [], organizations: [], readingStatusEvents: [], threads: [], threadHighlightMemberships: [], dailySelections: [] };
const statistics = libraryStatistics(document, new Date(now));
const dailyHighlight = entries.find(entry => entry.bookId === books[2].id && entry.text.includes("deliberately")) ?? entries.find(entry => entry.bookId === books[2].id);
const daily = { selection: { id: id(20000), localDay: "2026-11-09", timezone: "UTC", highlightId: dailyHighlight.id, candidateDigest: "0".repeat(64), recentHighlightIds: [], selectedAt: now, updatedAt: now, revision: 1 }, passage: { highlightId: dailyHighlight.id, bookId: dailyHighlight.bookId, bookTitle: dailyHighlight.bookTitle, authors: dailyHighlight.authors, text: dailyHighlight.text, notes: dailyHighlight.notes }, hasAlternatives: true };
const layouts = { library: [{widget:"books"},{widget:"passages"},{widget:"notes"},{widget:"finished"},{widget:"active-days"},{widget:"longest-run"},{widget:"daily",width:"full"},{widget:"shelf"},{widget:"activity",width:"full"}] };
const browser = await chromium.launch();
const output = join(root, "apps/docs/public/images");
const webOutput = join(host, "public/images");
mkdirSync(output, { recursive: true }); mkdirSync(webOutput, { recursive: true });
async function assets(page) {
  await page.route("https://showcase.leaflogue.test/**", route => route.fulfill({ path: join(root, "tests/marketing/covers", new URL(route.request().url()).pathname.slice(1)), contentType: "image/jpeg" }));
}
async function capture(page, destination) {
  await page.evaluate(() => globalThis.document.fonts.ready);
  await page.waitForFunction(() => [...globalThis.document.images].filter(image => image.getBoundingClientRect().width > 0).every(image => image.complete && image.naturalWidth > 0));
  await page.mouse.move(0, 0);
  const png = join(tmpdir(), "leaflogue-marketing-capture.png");
  await page.screenshot({ path: png });
  execFileSync("cwebp", ["-quiet", "-q", "91", png, "-o", destination]);
}
for (const mode of ["light", "dark"]) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: mode, reducedMotion: "reduce" });
  const page = await context.newPage(); await assets(page);
  await page.addInitScript(({ books, entries, statistics, daily, layouts }) => {
    const define = Object.defineProperty;
    Object.defineProperty = function (target, key, descriptor) {
      if (target === globalThis && key === "leaflogue") {
        const base = descriptor.value;
        descriptor = { ...descriptor, value: { ...base,
          library: { ...base.library, listBooks: async () => books, listHighlights: async query => ({ entries: entries.filter(entry => !query.bookId || entry.bookId === query.bookId).slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 20)), hasMore: false }) },
          statistics: { get: async () => statistics },
          organization: { ...base.organization, listCollections: async () => [], listTags: async () => [], getBook: async bookId => ({ bookId, collectionIds: [], tagIds: [], highlightTags: [] }) },
          daily: { get: async () => daily, ensure: async () => daily },
          dashboards: { ...base.dashboards, describe: async () => layouts },
        } };
      }
      return define(target, key, descriptor);
    };
  }, { books, entries, statistics, daily, layouts });
  for (const name of ["library", "highlights", "statistics"]) {
    await page.goto(`http://127.0.0.1:5199/?theme=leaflogue&mode=${mode}#/${name}`);
    await page.getByText(name === "library" ? "Today's highlight" : name === "highlights" ? "Your highlights" : "Most highlighted authors").first().waitFor();
    await capture(page, join(output, `desktop-${name}-${mode}.webp`));
  }
  await context.close();
}
// The web capture uses the same records and real Convex query shapes.
for (const palette of ["leaflogue", "everforest", "catppuccin", "rose-pine", "tokyo-night", "nord"]) for (const mode of ["light", "dark"]) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: mode, reducedMotion: "reduce" });
  const page = await context.newPage(); await assets(page);
  await page.route("**/api/auth/**", route => route.abort());
  await page.route("**/_next/static/chunks/*.js", async route => {
    const response = await route.fetch(); const source = await response.text();
    const body = source.replace(/(function useConvexAuth\(\) \{[\s\S]*?)return authContext;/, hook => {
      const react = hook.match(/(\S+)\["useContext"\]/)?.[1];
      if (!react) throw new Error("The capture auth hook no longer matches this development bundle");
      return hook.replace("return authContext;", `const [ready,setReady]=${react}["useState"](false);${react}["useEffect"](()=>{setReady(true)},[]);return ready?{isLoading:false,isAuthenticated:true}:authContext;`);
    });
    await route.fulfill({ response, body });
  });
  await page.routeWebSocket(/\.convex\.cloud\//, socket => {
    let version = { querySet: 0, identity: 0, ts: "AAAAAAAAAAA=" };
    socket.onMessage(raw => {
      const message = JSON.parse(String(raw));
      if (message.type === "Mutation") {
        const result = message.udfPath === "libraryAccess:connect" ? { libraryId: id(30000) } : message.udfPath === "dailyRuntime:ensureDailySelection" ? daily.selection : undefined;
        if (!result) throw new Error(`Capture attempted unexpected write: ${message.udfPath}`);
        socket.send(JSON.stringify({ type: "MutationResponse", requestId: message.requestId, success: true, result, logLines: [], ts: version.ts }));
        socket.send(JSON.stringify({ type: "Transition", startVersion: version, endVersion: version, modifications: [] })); return;
      }
      if (message.type !== "ModifyQuerySet") return;
      const modifications = message.modifications.map(query => {
        if (query.type === "Remove") return { type: "QueryRemoved", queryId: query.queryId };
        let value; const args = query.args?.[0] ?? {};
        switch (query.udfPath) {
          case "browse:books": value = books.map(book => ({ ...book, noteCount: highlights.filter(entry => entry.bookId === book.id).reduce((n,entry) => n + entry.notes.length, 0) })); break;
          case "browse:highlights": value = { page: entries, isDone: true, continueCursor: "" }; break;
          case "browse:highlight": value = dailyHighlight; break;
          case "browse:collections": case "browse:tags": case "browse:threads": case "browse:readingHistory": value = []; break;
          case "auth:currentUser": value = { _id: id(31000), _creationTime: 0, name: "Reader" }; break;
          case "preferences:get": value = { themeId: palette, mode, customTheme: null, dashboards: layouts, updatedAt: 0 }; break;
          case "aiRuntime:settings": value = { providers: [], selected: null, hourlyLimit: 30 }; break;
          case "libraryInsights:changes": value = { marker: { generation: 1, sequence: 1 }, reset: true }; break;
          case "libraryInsights:rows": {
            const rows = args.table === "books" ? books.map(book => ({ ...book, completedOn: book.completedOn ?? null, series: null })) : args.table === "highlights" ? highlights.map(entry => ({ ...entry, length: entry.text.length })) : args.table === "notes" ? highlights.flatMap(entry => entry.notes) : [];
            value = { rows: rows.filter(row => (!args.from || row.id >= args.from) && (!args.to || row.id < args.to)), continueCursor: "", isDone: true }; break;
          }
          default: throw new Error(`Add a read-only screenshot response for ${query.udfPath}`);
        }
        return { type: "QueryUpdated", queryId: query.queryId, value, logLines: [], journal: null };
      });
      const endVersion = { ...version, querySet: message.newVersion }; socket.send(JSON.stringify({ type: "Transition", startVersion: version, endVersion, modifications })); version = endVersion;
    });
  });
  for (const name of ["library", "highlights", "statistics"]) {
    await page.goto(`http://localhost:3100/${name}`);
    await page.getByText(name === "library" ? "Today's highlight" : name === "highlights" ? "Your highlights" : "Most highlighted authors").first().waitFor();
    await page.waitForFunction(() => globalThis.document.querySelector('.ui-title'));
    await capture(page, join(webOutput, `${palette}-${name}-${mode}.webp`));
  }
  await context.close();
}
for (const mode of ["light", "dark"]) {
  const { copyFileSync } = await import("node:fs");
  copyFileSync(join(webOutput, `leaflogue-library-${mode}.webp`), join(output, `leaflogue-library-${mode}.webp`));
}
await browser.close();
