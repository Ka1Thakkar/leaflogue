import { beforeEach, describe, expect, it } from "vitest";
import type { ImportAnnotation, ImportBook } from "@leaflogue/contracts";
import { LibraryClient } from "./client";
import { FakeTransport } from "./fake-transport";
import { batches, createFileImports } from "./imports";
import type { ReadImport } from "../import/files";

const LIBRARY = "a0000000-0000-4000-8000-000000000001";
const books: ImportBook[] = [{ providerRecordId: "book-1", title: "Piranesi", authors: ["Susanna Clarke"] }];
const annotations: ImportAnnotation[] = Array.from({ length: 150 }, (_, index) => ({ providerRecordId: `a${index}`, bookProviderRecordId: "book-1", text: `Passage ${index}` }));
const kobo: ReadImport = { provider: "kobo", fileName: "KoboReader.sqlite", preview: { document: { formatVersion: 1, books, annotations }, warnings: [] } };

let transport: FakeTransport;
beforeEach(() => {
  transport = new FakeTransport()
    .on("importRuntime:listSources", () => [
      { id: "s-kobo", provider: "kobo", name: "Kobo Clara", updatedAt: 5 },
      { id: "s-kindle", provider: "kindle", name: "Kindle", updatedAt: 6 },
    ])
    .on("importRuntime:createSource", () => ({ sourceId: "s-new" }))
    .on("importRuntime:importBooks", () => ({ booksCreated: 1, booksReused: 0 }))
    .on("importRuntime:importAnnotations", (args) => ({
      highlightsCreated: (args.annotations as unknown[]).length, notesCreated: 0, annotationsUpdated: 0, conflictsCreated: 0, unchanged: 0, skipped: 0,
    }));
});

const chosen = (files: File[] | undefined) =>
  createFileImports(new LibraryClient(transport, LIBRARY), () => Promise.resolve(files), () => Promise.resolve(kobo));
const imports = () => chosen([new File(["x"], "KoboReader.sqlite")]);

describe("importing in the browser", () => {
  it("reviews the chosen file against this provider's sources", async () => {
    const pending = await imports().chooseFile();
    expect(pending).toMatchObject({
      fileName: "KoboReader.sqlite",
      provider: "kobo",
      sourceProfiles: [{ id: "s-kobo", provider: "kobo", name: "Kobo Clara", lastImportedAt: 5 }],
      suggestedSourceName: "Kobo — KoboReader",
    });
    expect(pending?.preview.document.annotations).toHaveLength(150);
  });

  it("does nothing when the reader closes the picker", async () => {
    expect(await chosen(undefined).chooseFile()).toBeUndefined();
    expect(transport.calls).toEqual([]);
  });

  it("creates a named source and sends books, then annotations, in batches", async () => {
    const flow = imports();
    const pending = (await flow.chooseFile())!;
    const receipt = await flow.commit({ token: pending.token, sourceId: pending.newSourceId, newSourceName: " Kobo Clara 2 " });
    expect(transport.called("importRuntime:createSource")[0]?.args).toEqual({ libraryId: LIBRARY, provider: "kobo", name: "Kobo Clara 2" });
    const sent = transport.called("importRuntime:importAnnotations").map(({ args }) => (args.annotations as unknown[]).length);
    expect(sent).toEqual([100, 50]);
    expect(transport.calls.map(({ name }) => name).slice(-3)).toEqual(["importRuntime:importBooks", "importRuntime:importAnnotations", "importRuntime:importAnnotations"]);
    expect(receipt).toEqual({ booksCreated: 1, booksReused: 0, highlightsCreated: 150, annotationsUpdated: 0, notesCreated: 0, conflictsCreated: 0 });
    await expect(flow.commit({ token: pending.token, sourceId: "s-kobo" })).rejects.toThrow("Choose the file again");
  });

  it("adds to an existing source without creating one", async () => {
    const flow = imports();
    const pending = (await flow.chooseFile())!;
    await flow.commit({ token: pending.token, sourceId: "s-kobo" });
    expect(transport.called("importRuntime:createSource")).toHaveLength(0);
    expect(transport.called("importRuntime:importBooks")[0]?.args).toMatchObject({ sourceId: "s-kobo" });
  });

  it("keeps each batch under the size limit as well as the record limit", () => {
    const large = Array.from({ length: 5 }, (_, index) => ({ id: index, text: "x".repeat(700 * 1024) }));
    expect(batches(large).map((batch) => batch.length)).toEqual([2, 2, 1]);
  });
});
