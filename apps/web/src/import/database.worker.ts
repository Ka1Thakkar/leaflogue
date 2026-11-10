import initSqlJs from "sql.js";
import type { ImportPreview } from "@leaflogue/contracts";
import { extractKoboDatabase, extractPocketBookDatabase, isPocketBookDatabase } from "@leaflogue/importers";
import { readonlyDatabase } from "./sqlite";

export type DatabaseRequest = { readonly bytes: ArrayBuffer; readonly wasmUrl: string };
export type DatabaseReply =
  | { readonly ok: true; readonly provider: "kobo" | "pocketbook"; readonly preview: ImportPreview }
  | { readonly ok: false };

/**
 * Reads Kobo's KoboReader.sqlite or PocketBook's books.db off the page's
 * thread, told apart by their tables. Only the extracted books and
 * annotations come back.
 */
self.onmessage = async (event: MessageEvent<DatabaseRequest>) => {
  const reply = (message: DatabaseReply) => self.postMessage(message);
  try {
    const SQL = await initSqlJs({ locateFile: () => event.data.wasmUrl });
    const database = new SQL.Database(new Uint8Array(event.data.bytes));
    try {
      const reader = readonlyDatabase(database);
      reply(isPocketBookDatabase(reader)
        ? { ok: true, provider: "pocketbook", preview: await extractPocketBookDatabase(reader) }
        : { ok: true, provider: "kobo", preview: extractKoboDatabase(reader) });
    } finally {
      database.close();
    }
  } catch {
    reply({ ok: false });
  }
};
