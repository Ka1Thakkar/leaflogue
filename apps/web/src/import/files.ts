import type { ImportPreview, ImportProvider } from "@leaflogue/contracts";
import {
  looksLikeBooxExport,
  looksLikeTolinoNotes,
  MAX_KOBO_FILE_BYTES,
  MAX_KOREADER_SIDECARS,
  parseBooxExport,
  parseBooxExports,
  parseKindleClippings,
  parseKOReaderSidecars,
  parsePortableJson,
  parseTolinoNotes,
} from "@leaflogue/importers";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import type { DatabaseReply, DatabaseRequest } from "./database.worker";

export interface ReadImport {
  readonly provider: ImportProvider;
  readonly preview: ImportPreview;
  readonly fileName: string;
}

/** What the file picker offers: the same files the desktop's import dialog does. */
export const IMPORT_ACCEPT = ".sqlite,.sqlite3,.db,.txt,.json,.lua";

const MAX_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_SIDECAR_BYTES = 8 * 1024 * 1024;
const SQLITE_MAGIC = "SQLite format 3\0";

export type ReadDatabase = (bytes: ArrayBuffer) => Promise<{ provider: "kobo" | "pocketbook"; preview: ImportPreview }>;

const extension = (file: File) => file.name.slice(file.name.lastIndexOf(".")).toLocaleLowerCase("en");

async function text(file: File, maximum: number): Promise<string> {
  if (file.size === 0 || file.size > maximum) throw new Error("That file is empty or too large to import.");
  return file.text();
}

/**
 * Read chosen files in the browser with the desktop's importers, telling the
 * format apart the way the desktop does. Several files are KOReader sidecars
 * or Boox exports; anything that is not text is an e-reader database.
 */
export async function readImportFiles(files: readonly File[], readDatabase: ReadDatabase = workerDatabase): Promise<ReadImport> {
  const [first] = files;
  if (!first) throw new Error("Choose a file to import.");
  const fileName = files.length === 1 ? first.name : `${files.length} files`;
  if (files.every((file) => extension(file) === ".lua")) {
    if (files.length > MAX_KOREADER_SIDECARS) throw new Error(`Choose at most ${MAX_KOREADER_SIDECARS} KOReader files.`);
    const sources = await Promise.all(files.map((file) => text(file, MAX_SIDECAR_BYTES)));
    return { provider: "koreader", fileName, preview: await parseKOReaderSidecars(files.map((file, index) => ({ path: file.webkitRelativePath || file.name, source: sources[index]! }))) };
  }
  if (files.length > 1) {
    const sources = files.every((file) => extension(file) === ".txt") ? await Promise.all(files.map((file) => text(file, MAX_TEXT_BYTES))) : [];
    if (!sources.length || !sources.every(looksLikeBooxExport)) throw new Error("Choose one file, or several KOReader or Boox files.");
    return { provider: "boox", fileName, preview: await parseBooxExports(sources) };
  }
  if (extension(first) === ".txt") {
    const source = await text(first, MAX_TEXT_BYTES);
    // Kindle's separator is a line of ten "=", Tolino's and Boox's are dashes.
    if (/^={10}\s*$/mu.test(source)) return { provider: "kindle", fileName, preview: await parseKindleClippings(source) };
    if (looksLikeBooxExport(source)) return { provider: "boox", fileName, preview: await parseBooxExport(source) };
    if (looksLikeTolinoNotes(source)) return { provider: "tolino", fileName, preview: await parseTolinoNotes(source) };
    return { provider: "kindle", fileName, preview: await parseKindleClippings(source) };
  }
  if (extension(first) === ".json") {
    return { provider: "portable", fileName, preview: parsePortableJson(await text(first, MAX_TEXT_BYTES)) };
  }
  if (first.size < 100 || first.size > MAX_KOBO_FILE_BYTES) throw new Error("That file is not an e-reader database Leaflogue can read.");
  const bytes = await first.arrayBuffer();
  const head = new Uint8Array(bytes, 0, SQLITE_MAGIC.length);
  if ([...SQLITE_MAGIC].some((character, index) => head[index] !== character.charCodeAt(0))) {
    throw new Error("That file is not an e-reader database Leaflogue can read.");
  }
  return { ...await readDatabase(bytes), fileName };
}

/** Read a database in a worker, so a large Kobo file does not freeze the page. */
const workerDatabase: ReadDatabase = (bytes) => new Promise((resolve, reject) => {
  const worker = new Worker(new URL("./database.worker.ts", import.meta.url), { type: "module" });
  const finish = () => worker.terminate();
  worker.onmessage = (event: MessageEvent<DatabaseReply>) => {
    finish();
    if (event.data.ok) resolve({ provider: event.data.provider, preview: event.data.preview });
    else reject(new Error("Leaflogue could not read that database."));
  };
  worker.onerror = () => { finish(); reject(new Error("Leaflogue could not read that database.")); };
  const request: DatabaseRequest = { bytes, wasmUrl };
  worker.postMessage(request, [bytes]);
});
