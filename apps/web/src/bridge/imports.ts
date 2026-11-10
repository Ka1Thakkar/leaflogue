import type { ImportBook, ImportProvider, ImportReceipt, ImportSourceProfile, LeaflogueBridge, PendingImport } from "@leaflogue/contracts";
import { IMPORT_ACCEPT, readImportFiles, type ReadImport } from "../import/files";
import { BackendError } from "../transport/transport";
import { newId, type LibraryClient } from "./client";

type Imports = Pick<LeaflogueBridge["imports"], "chooseFile" | "commit">;

const PROVIDER_NAMES: Record<ImportProvider, string> = {
  kobo: "Kobo", kindle: "Kindle", koreader: "KOReader", pocketbook: "PocketBook", tolino: "Tolino", boox: "Boox", portable: "Portable",
};

/** The server takes at most 100 records a call; Convex also limits a call's size. */
const BATCH_RECORDS = 100;
const BATCH_BYTES = 2 * 1024 * 1024;

interface WireSource { readonly id: string; readonly provider: ImportProvider; readonly name: string; readonly updatedAt: number }

/** Open the browser's file picker. Called from the reader's click, so the picker may open. */
export function pickFiles(): Promise<File[] | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = IMPORT_ACCEPT;
    input.multiple = true;
    input.addEventListener("change", () => resolve(input.files?.length ? [...input.files] : undefined), { once: true });
    input.addEventListener("cancel", () => resolve(undefined), { once: true });
    input.click();
  });
}

export function batches<T>(records: readonly T[]): T[][] {
  const result: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const record of records) {
    const size = new TextEncoder().encode(JSON.stringify(record)).byteLength;
    if (current.length && (current.length >= BATCH_RECORDS || bytes + size > BATCH_BYTES)) {
      result.push(current);
      current = [];
      bytes = 0;
    }
    current.push(record);
    bytes += size;
  }
  if (current.length) result.push(current);
  return result;
}

function suggestedName(provider: ImportProvider, fileName: string): string {
  const stem = fileName.replace(/\.[^.]*$/u, "").trim();
  const name = PROVIDER_NAMES[provider];
  return stem && !/^\d+ files$/u.test(stem) && stem.toLocaleLowerCase("en") !== name.toLocaleLowerCase("en") ? `${name} — ${stem}`.slice(0, 200) : `${name} library`;
}

/**
 * Importing in the browser: the chosen files are read here with the desktop's
 * importers, reviewed in the same dialog, then sent in batches. Unlike the
 * desktop's single transaction, a batch that fails leaves the earlier ones in
 * place; importing the same file again picks up where it stopped.
 */
export function createFileImports(client: LibraryClient, choose = pickFiles, read: (files: readonly File[]) => Promise<ReadImport> = readImportFiles): Imports {
  const pending = new Map<string, ReadImport & { readonly newSourceId: string }>();

  return {
    async chooseFile(): Promise<PendingImport | undefined> {
      const files = await choose();
      if (!files) return undefined;
      const [imported, sources] = await Promise.all([read(files), client.query<WireSource[]>("importRuntime:listSources")]);
      const token = newId();
      const newSourceId = newId();
      pending.clear();
      pending.set(token, { ...imported, newSourceId });
      const sourceProfiles: ImportSourceProfile[] = sources
        .filter((source) => source.provider === imported.provider)
        .map((source) => ({ id: source.id, provider: source.provider, name: source.name, lastImportedAt: source.updatedAt }));
      return {
        token,
        fileName: imported.fileName,
        provider: imported.provider,
        preview: imported.preview,
        sourceProfiles,
        newSourceId,
        suggestedSourceName: suggestedName(imported.provider, imported.fileName),
      };
    },

    async commit({ token, sourceId, newSourceName }): Promise<ImportReceipt> {
      const held = pending.get(token);
      if (!held) throw new BackendError("Choose the file again to import it.", "LEAFLOGUE_IMPORT_EXPIRED");
      const creating = sourceId === held.newSourceId;
      if (creating && !newSourceName?.trim()) throw new BackendError("Give the new source a name.", "LEAFLOGUE_REQUEST_INVALID");
      const source = creating
        ? (await client.mutation<{ sourceId: string }>("importRuntime:createSource", { provider: held.provider, name: newSourceName!.trim() })).sourceId
        : sourceId;
      const receipt = { booksCreated: 0, booksReused: 0, highlightsCreated: 0, annotationsUpdated: 0, notesCreated: 0, conflictsCreated: 0 };
      const { books, annotations } = held.preview.document;
      for (const batch of batches(books)) {
        const result = await client.mutation<{ booksCreated: number; booksReused: number }>("importRuntime:importBooks", {
          sourceId: source,
          books: batch.map((book: ImportBook) => ({ ...book, authors: [...book.authors] })),
        });
        receipt.booksCreated += result.booksCreated;
        receipt.booksReused += result.booksReused;
      }
      for (const batch of batches(annotations)) {
        const result = await client.mutation<Omit<ImportReceipt, "booksCreated" | "booksReused">>("importRuntime:importAnnotations", { sourceId: source, annotations: batch });
        receipt.highlightsCreated += result.highlightsCreated;
        receipt.notesCreated += result.notesCreated;
        receipt.annotationsUpdated += result.annotationsUpdated;
        receipt.conflictsCreated += result.conflictsCreated;
      }
      pending.delete(token);
      return receipt;
    },
  };
}
