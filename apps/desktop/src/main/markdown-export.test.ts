import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BookContents, BookId, LibraryExportDocument } from "@leaflogue/contracts";
import { createMarkdownExport, markdownSlug, writeMarkdownExport } from "./markdown-export";

const at = Date.parse("2026-09-20T10:00:00.000Z");
const orchard = "5a540f21-7f61-44d7-89a5-f1b4643ce26c" as BookId;
const twin = "6b651032-8a72-45e8-9ab6-a2c5754df37d" as BookId;
const PASSAGE = "77a0ecda-8fa0-413c-9738-577e8b2ec5cf";
const NOTE = "9bc4a985-51c7-4cc3-8c65-80d6c7e49435";
const passageId = PASSAGE as never;
const noteId = NOTE as never;
const tagId = "40000000-0000-4000-8000-000000000000" as never;
const threadId = "70000000-0000-4000-8000-000000000000" as never;
const collectionId = "30000000-0000-4000-8000-000000000000" as never;

function book(id: BookId, title: string, overrides: Partial<BookContents> = {}): BookContents {
  return {
    book: { id, title, authors: ["Imogen Vale"], status: "reading", archived: false, createdAt: at, updatedAt: at, revision: 1, highlightCount: 0 },
    highlights: [],
    standaloneNotes: [],
    ...overrides,
  };
}

const document: LibraryExportDocument = {
  format: "leaflogue-library",
  formatVersion: 4,
  exportedAt: "2026-10-05T08:00:00.000Z",
  books: [
    book(orchard, "The Glass Orchard: \"Seasons\"", {
      highlights: [{
        id: passageId, bookId: orchard, text: "Every pane held a season.\nAnd every season a pane.", sourceCreatedAt: Date.parse("2026-01-04T10:00:00Z"),
        createdAt: at, updatedAt: at, revision: 1,
        notes: [{ id: "8ad86070-a9f3-4f58-a760-dcd21b02fc38" as never, bookId: orchard, highlightId: passageId, markdown: "Return to this **image**.", origin: "reader", createdAt: at, updatedAt: at, revision: 1 }],
      }],
      standaloneNotes: [{ id: noteId, bookId: orchard, markdown: "Thoughts on the whole book.", origin: "reader", createdAt: at, updatedAt: at, revision: 1 }],
    }),
    book(twin, "The Glass Orchard \"Seasons\""),
  ],
  collections: [{ id: collectionId, name: "Keepers", bookCount: 1, createdAt: at, updatedAt: at, revision: 1 }],
  tags: [{ id: tagId, name: "Revisit", color: "ochre", bookCount: 1, highlightCount: 1, createdAt: at, updatedAt: at, revision: 1 }],
  organizations: [
    { bookId: orchard, collectionIds: [collectionId], tagIds: [tagId], highlightTags: [{ highlightId: passageId, tagIds: [tagId] }] },
    { bookId: twin, collectionIds: [], tagIds: [], highlightTags: [] },
  ],
  readingStatusEvents: [],
  threads: [{ id: threadId, name: "Patience", passageCount: 1, createdAt: at, updatedAt: at, revision: 1 }],
  threadHighlightMemberships: [{ threadId, highlightId: passageId, addedAt: at }],
  dailySelections: [],
};

describe("Markdown export", () => {
  const files = createMarkdownExport(document);
  const byPath = new Map(files.map(({ path, content }) => [path, content]));

  it("writes one file per book with distinct names and a merged library", () => {
    expect([...byPath.keys()].sort()).toEqual(["books/the-glass-orchard-seasons-2.md", "books/the-glass-orchard-seasons.md", "library.md"]);
  });

  it("gives each book safe front matter, quoted passages, notes, and stable IDs", () => {
    const content = files.find(({ content: text }) => text.includes(`leaflogue_id: "${orchard}"`))!.content;
    expect(content).toContain('title: "The Glass Orchard: \\"Seasons\\""');
    expect(content).toContain(`leaflogue_id: "${orchard}"`);
    expect(content).toContain('tags: ["Revisit"]');
    expect(content).toContain('collections: ["Keepers"]');
    expect(content).toContain("> Every pane held a season.\n> And every season a pane.");
    expect(content).toContain("Return to this **image**.");
    expect(content).toContain("*Tags: Revisit · Threads: Patience · Added 2026-01-04*");
    expect(content).toContain(`<!-- leaflogue:passage ${PASSAGE} -->`);
    expect(content).toContain(`## Notes\n\nThoughts on the whole book.\n\n<!-- leaflogue:note ${NOTE} -->`);
    expect(content.endsWith("\n")).toBe(true);
    expect(content).not.toMatch(/\n{3,}/u);
  });

  it("merges every book into one readable file without internal IDs", () => {
    const library = byPath.get("library.md")!;
    expect(library).toContain('## The Glass Orchard: "Seasons" — Imogen Vale');
    expect(library).toContain("> Every pane held a season.");
    expect(library).toContain("### Notes");
    expect(library).not.toContain("leaflogue:");
  });

  it("makes safe file names from any title", () => {
    expect(markdownSlug("Café: Ñoño / ../Secret")).toBe("cafe-nono-secret");
    expect(markdownSlug("《三体》")).toBe("book");
    expect(markdownSlug("a".repeat(200))).toHaveLength(80);
  });

  it("writes into a new dated folder, never into an existing one, and leaves nothing temporary", () => {
    const parent = mkdtempSync(join(tmpdir(), "leaflogue-markdown-"));
    try {
      expect(writeMarkdownExport(parent, document)).toEqual({ folderName: "Leaflogue Markdown 2026-10-05", booksExported: 2, highlightsExported: 1, notesExported: 2 });
      expect(writeMarkdownExport(parent, document).folderName).toBe("Leaflogue Markdown 2026-10-05 (2)");
      expect(readdirSync(parent).sort()).toEqual(["Leaflogue Markdown 2026-10-05", "Leaflogue Markdown 2026-10-05 (2)"]);
      const folder = join(parent, "Leaflogue Markdown 2026-10-05");
      expect(readFileSync(join(folder, "library.md"), "utf8")).toContain("# Leaflogue library");
      expect(readdirSync(join(folder, "books"))).toHaveLength(2);
      expect(statSync(join(folder, "library.md")).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
