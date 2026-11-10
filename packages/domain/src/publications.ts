/**
 * Public links: a frozen copy of one passage, its book's title and authors,
 * and the notes the reader chose to include, served at a random address that
 * anyone can open. Shared by every backend, so a Convex deployment and a
 * PostgreSQL server publish and report the same way.
 */

export const PUBLICATION_LIMITS = Object.freeze({
  /** Notes a reader may include with one passage. */
  notes: 20,
  /** Links one library may hold, published or withdrawn. */
  publications: 1_000,
  /** Reports one anonymous reporter may file per day. */
  reportsPerReporterPerDay: 5,
  /** Reports kept for one link before it counts as under review. */
  reportsPerPublication: 100,
  passageBytes: 20_000,
  noteBytes: 20_000,
  reportDetailsCharacters: 2_000,
});

export const PUBLICATION_REPORT_REASONS = ["copyright", "harassment", "personal_information", "other"] as const;
export type PublicationReportReason = (typeof PUBLICATION_REPORT_REASONS)[number];

export interface PublicationNote {
  readonly markdown: string;
  /** Saved from the AI companion, so a reader of the link can tell. */
  readonly ai: boolean;
}

export interface PublicationSnapshot {
  readonly passage: string;
  readonly bookTitle: string;
  readonly authors: readonly string[];
  readonly notes: readonly PublicationNote[];
}

function fits(value: string, maximumBytes: number): boolean {
  return new TextEncoder().encode(value).byteLength <= maximumBytes;
}

/** Freeze what will be shared, refusing anything too large rather than cutting a passage short. */
export function buildPublicationSnapshot(input: {
  readonly passage: string;
  readonly bookTitle: string;
  readonly authors: readonly string[];
  readonly notes: readonly { readonly markdown: string; readonly origin?: string }[];
}): PublicationSnapshot {
  const passage = input.passage.normalize("NFC").trim();
  if (!passage) throw new Error("This passage has no text to share");
  if (!fits(passage, PUBLICATION_LIMITS.passageBytes)) throw new Error("This passage is too long to share");
  if (input.notes.length > PUBLICATION_LIMITS.notes) throw new Error(`Choose at most ${PUBLICATION_LIMITS.notes} notes`);
  const notes = input.notes.map((note) => {
    const markdown = note.markdown.normalize("NFC").trim();
    if (!fits(markdown, PUBLICATION_LIMITS.noteBytes)) throw new Error("A chosen note is too long to share");
    return { markdown, ai: note.origin === "ai" };
  }).filter((note) => note.markdown);
  return {
    passage,
    bookTitle: input.bookTitle.normalize("NFC").trim() || "Untitled book",
    authors: input.authors.map((author) => author.normalize("NFC").trim()).filter(Boolean),
    notes,
  };
}

/** A link's address: 128 random bits, URL-safe. Guessing one is not practical. */
export function newPublicationId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

export function isPublicationId(value: string): boolean {
  return /^[A-Za-z0-9_-]{22}$/u.test(value);
}

/** A browser-held key that groups one anonymous reporter's reports, for the daily limit. */
export function isReporterKey(value: string): boolean {
  return /^[A-Za-z0-9_-]{20,100}$/u.test(value);
}

export function validReportDetails(details: string | undefined): string | undefined {
  if (details === undefined) return undefined;
  const trimmed = details.normalize("NFC").trim();
  if (trimmed.length > PUBLICATION_LIMITS.reportDetailsCharacters) throw new Error("Report details are too long");
  return trimmed || undefined;
}
