import type { ReaderDocument } from "@leaflogue/contracts";
import { parseEpub } from "./epub";
import { parsePdf } from "./pdf";
import { parseArticle } from "./article-document";

/** Parsers adapt source bytes into one document model; storage and UI stay shared. */
const formats: readonly { readonly matches: (bytes: Buffer) => boolean; readonly parse: (bytes: Buffer) => Promise<ReaderDocument> | ReaderDocument }[] = [
  { matches: (bytes) => bytes.subarray(0, 5).toString() === "%PDF-", parse: parsePdf },
  { matches: (bytes) => bytes[0] === 123, parse: parseArticle },
  { matches: (bytes) => bytes[0] === 0x50 && bytes[1] === 0x4b, parse: parseEpub },
];

export async function parseReaderDocument(bytes: Buffer): Promise<ReaderDocument> {
  const adapter = formats.find((format) => format.matches(bytes));
  if (!adapter) throw new Error("Unsupported reader file format.");
  return adapter.parse(bytes);
}
