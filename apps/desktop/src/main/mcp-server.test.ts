import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { LocalLibrary } from "@leaflogue/storage";
import { createLocalMcpServer } from "./mcp-server";
import { mcpAccessEnabled, saveMcpAccess } from "./mcp-access";

const textOf = (result: unknown) => JSON.stringify(result);

describe("read-only local MCP", () => {
  it("negotiates MCP, returns citations, bounds requests, rejects writes, and revokes an existing session", async () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-mcp-"));
    const file = join(directory, "library.sqlite"), access = join(directory, "access.json");
    const library = new LocalLibrary(file);
    const book = library.createBook({ title: "A Test Book", authors: ["A Test Author"] });
    const highlight = library.createHighlight({ bookId: book.id, text: "The tide keeps its own calendar.", sourceLocation: "Chapter 2" });
    library.createNote({ bookId: book.id, highlightId: highlight.id, markdown: "Reader reflection", origin: "reader" });
    library.createNote({ bookId: book.id, markdown: "A standalone note", origin: "reader" });
    const thread = library.createThread({ name: "Time" });
    library.setHighlightThreadMembership({ threadIds: [thread.id], highlightId: highlight.id, bookId: book.id, expectedHighlightRevision: library.listHighlights({ bookId: book.id }).entries[0]!.revision });
    library.close();
    const server = createLocalMcpServer(file, access, "0.1.0");
    const client = new Client({ name: "leaflogue-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools.map(tool => tool.name).sort()).toEqual(["get_book", "get_thread", "list_books", "list_threads", "search_passages"]);
      expect(tools.tools.every(tool => tool.annotations?.readOnlyHint)).toBe(true);
      expect((await client.callTool({ name: "list_books", arguments: {} })).isError).toBe(true);
      saveMcpAccess(access, true);
      expect(mcpAccessEnabled(access)).toBe(true);
      const before = readFileSync(file);
      const result = await client.callTool({ name: "search_passages", arguments: { query: "tide" } });
      expect(result.isError).not.toBe(true);
      expect(textOf(result)).toContain("Chapter 2");
      expect(textOf(result)).toContain("A Test Author");
      expect(textOf(result)).toContain(highlight.id);
      expect(textOf(result)).toContain("Reader reflection");
      expect(textOf(await client.callTool({ name: "get_book", arguments: { bookId: book.id } }))).toContain("A standalone note");
      expect(textOf(await client.callTool({ name: "get_thread", arguments: { threadId: thread.id } }))).toContain("The tide");
      expect((await client.callTool({ name: "list_books", arguments: { limit: 1000 } })).isError).toBe(true);
      expect((await client.callTool({ name: "search_passages", arguments: { query: "x".repeat(201) } })).isError).toBe(true);
      expect((await client.callTool({ name: "delete_book", arguments: { bookId: book.id } })).isError).toBe(true);
      const readOnly = new LocalLibrary(file, { readOnly: true });
      try { expect(() => readOnly.createBook({ title: "Cannot write", authors: [] })).toThrow(); } finally { readOnly.close(); }
      expect(readFileSync(file)).toEqual(before);
      saveMcpAccess(access, false);
      const denied = await client.callTool({ name: "search_passages", arguments: { query: "tide" } });
      expect(denied.isError).toBe(true); expect(textOf(denied)).not.toContain("The tide");
      writeFileSync(access, "invalid");
      expect(mcpAccessEnabled(access)).toBe(false);
    } finally { await client.close(); await server.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
