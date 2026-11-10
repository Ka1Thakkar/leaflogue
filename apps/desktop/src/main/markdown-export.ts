import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BookContents, LibraryExportDocument, MarkdownExportReceipt } from "@leaflogue/contracts";
import { countLibraryExport } from "./library-export";

/**
 * Markdown export (roadmap: reader features). Built from the same snapshot as
 * the JSON export, so both always agree. Each book becomes one file with YAML
 * front matter and stable Leaflogue IDs (kept in HTML comments, which Markdown
 * apps hide) for a future two-way folder sync. `library.md` merges every book
 * into one plain file, without IDs, for reading or pasting into an AI tool.
 */

export interface MarkdownFile {
  /** Path relative to the export folder, always with forward slashes. */
  readonly path: string;
  readonly content: string;
}

const MAX_SLUG = 80;

/** A readable, filesystem-safe file name stem. */
export function markdownSlug(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/gu, "");
  return slug || "book";
}

/** YAML double-quoted scalars are JSON strings, so JSON quoting is safe. */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

function yamlList(values: readonly string[]): string {
  return `[${values.map(yamlString).join(", ")}]`;
}

function quote(text: string): string {
  return text.split(/\r?\n/u).map((line) => (line ? `> ${line}` : ">")).join("\n");
}

function day(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

interface Lookups {
  readonly tagNames: ReadonlyMap<string, string>;
  readonly collectionNames: ReadonlyMap<string, string>;
  readonly threadNames: ReadonlyMap<string, string>;
  readonly highlightThreads: ReadonlyMap<string, readonly string[]>;
  readonly organizations: LibraryExportDocument["organizations"];
}

function lookups(document: LibraryExportDocument): Lookups {
  const threadNames = new Map(document.threads.map(({ id, name }) => [id, name] as const));
  const highlightThreads = new Map<string, string[]>();
  for (const { threadId, highlightId } of document.threadHighlightMemberships) {
    const name = threadNames.get(threadId);
    if (name) highlightThreads.set(highlightId, [...(highlightThreads.get(highlightId) ?? []), name]);
  }
  return {
    tagNames: new Map(document.tags.map(({ id, name }) => [id, name] as const)),
    collectionNames: new Map(document.collections.map(({ id, name }) => [id, name] as const)),
    threadNames,
    highlightThreads,
    organizations: document.organizations,
  };
}

function names(ids: readonly string[], table: ReadonlyMap<string, string>): string[] {
  return ids.map((id) => table.get(id)).filter((name): name is string => Boolean(name)).sort((a, b) => a.localeCompare(b));
}

function passageSection(contents: BookContents, found: Lookups, withIds: boolean): string[] {
  const organization = found.organizations.find(({ bookId }) => bookId === contents.book.id);
  const lines: string[] = [];
  for (const highlight of contents.highlights) {
    lines.push(quote(highlight.text), "");
    for (const note of highlight.notes) lines.push(note.markdown.trim(), "");
    const tags = names(organization?.highlightTags.find(({ highlightId }) => highlightId === highlight.id)?.tagIds ?? [], found.tagNames);
    const threads = [...(found.highlightThreads.get(highlight.id) ?? [])].sort((a, b) => a.localeCompare(b));
    const details = [
      ...(tags.length ? [`Tags: ${tags.join(", ")}`] : []),
      ...(threads.length ? [`Threads: ${threads.join(", ")}`] : []),
      `Added ${day(highlight.sourceCreatedAt ?? highlight.createdAt)}`,
    ];
    lines.push(`*${details.join(" · ")}*`);
    if (withIds) lines.push(`<!-- leaflogue:passage ${highlight.id} -->`);
    lines.push("");
  }
  return lines;
}

function notesSection(contents: BookContents, withIds: boolean): string[] {
  const lines: string[] = [];
  for (const note of contents.standaloneNotes) {
    lines.push(note.markdown.trim(), "");
    if (withIds) lines.push(`<!-- leaflogue:note ${note.id} -->`, "");
  }
  return lines;
}

function bookFile(contents: BookContents, found: Lookups, exportedAt: string): string {
  const { book } = contents;
  const organization = found.organizations.find(({ bookId }) => bookId === book.id);
  const lines = [
    "---",
    `title: ${yamlString(book.title)}`,
    `authors: ${yamlList(book.authors)}`,
    `leaflogue_id: ${yamlString(book.id)}`,
    `status: ${yamlString(book.status)}`,
    ...(book.archived ? ["archived: true"] : []),
    `tags: ${yamlList(names(organization?.tagIds ?? [], found.tagNames))}`,
    `collections: ${yamlList(names(organization?.collectionIds ?? [], found.collectionNames))}`,
    `exported: ${yamlString(exportedAt)}`,
    "---",
    "",
    `# ${book.title}`,
    "",
    ...(book.authors.length ? [`*${book.authors.join(", ")}*`, ""] : []),
  ];
  if (contents.highlights.length) lines.push("## Passages", "", ...passageSection(contents, found, true));
  if (contents.standaloneNotes.length) lines.push("## Notes", "", ...notesSection(contents, true));
  return `${lines.join("\n").replace(/\n{3,}/gu, "\n\n").trimEnd()}\n`;
}

function libraryFile(document: LibraryExportDocument, found: Lookups): string {
  const lines = ["# Leaflogue library", "", `Exported ${day(Date.parse(document.exportedAt))}.`, ""];
  for (const contents of document.books) {
    const { book } = contents;
    lines.push(`## ${book.title}${book.authors.length ? ` — ${book.authors.join(", ")}` : ""}`, "");
    lines.push(...passageSection(contents, found, false));
    if (contents.standaloneNotes.length) lines.push("### Notes", "", ...notesSection(contents, false));
  }
  return `${lines.join("\n").replace(/\n{3,}/gu, "\n\n").trimEnd()}\n`;
}

export function createMarkdownExport(document: LibraryExportDocument): readonly MarkdownFile[] {
  const found = lookups(document);
  const books = [...document.books].sort((a, b) => a.book.title.localeCompare(b.book.title) || a.book.id.localeCompare(b.book.id));
  const used = new Set<string>();
  const files: MarkdownFile[] = books.map((contents) => {
    const stem = markdownSlug(contents.book.title);
    let name = stem;
    for (let copy = 2; used.has(name); copy += 1) name = `${stem}-${copy}`;
    used.add(name);
    return { path: `books/${name}.md`, content: bookFile(contents, found, document.exportedAt) };
  });
  files.push({ path: "library.md", content: libraryFile({ ...document, books }, found) });
  return files;
}

/**
 * Write the export into a new folder inside `parent`, named for the day. Files
 * go into a hidden temporary folder first and it is renamed into place at the
 * end, so a failed export leaves nothing behind and an existing folder is
 * never written into.
 */
export function writeMarkdownExport(parent: string, document: LibraryExportDocument): MarkdownExportReceipt {
  const files = createMarkdownExport(document);
  const base = `Leaflogue Markdown ${document.exportedAt.slice(0, 10)}`;
  let folderName = base;
  for (let copy = 2; existsSync(join(parent, folderName)); copy += 1) folderName = `${base} (${copy})`;
  const staging = join(parent, `.leaflogue-markdown-${randomUUID()}`);
  try {
    mkdirSync(staging, { mode: 0o700 });
    for (const { path, content } of files) {
      const target = join(staging, ...path.split("/"));
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, content, { flag: "wx", mode: 0o600 });
    }
    renameSync(staging, join(parent, folderName));
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return { folderName, ...countLibraryExport(document) };
}
