import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { open, readFile } from "node:fs/promises";
import type { DictionaryDefinition, DictionaryResult } from "@leaflogue/contracts";

const dictionaryPath = join(dirname(createRequire(import.meta.url).resolve("wordnet-db")), "dict");
const parts = { noun: "noun", verb: "verb", adj: "adjective", adv: "adverb" } as const;
type Part = keyof typeof parts;
type Reference = { part: Part; offset: number };
let indexPromise: Promise<Map<string, Reference[]>> | undefined;

async function loadIndex(): Promise<Map<string, Reference[]>> {
  const result = new Map<string, Reference[]>();
  for (const part of Object.keys(parts) as Part[]) {
    const text = await readFile(join(dictionaryPath, `index.${part}`), "utf8");
    for (const line of text.split("\n")) {
      if (!line || line.startsWith(" ")) continue;
      const fields = line.trim().split(/\s+/u);
      const lemma = fields[0]!;
      const count = Number(fields[2]);
      const pointerCount = Number(fields[3]);
      const offsets = fields.slice(6 + pointerCount, 6 + pointerCount + count);
      result.set(lemma, [...(result.get(lemma) ?? []), ...offsets.map(offset => ({ part, offset: Number(offset) }))]);
    }
  }
  return result;
}

export function normalizeDictionaryWord(value: unknown): string {
  if (typeof value !== "string" || value.length > 100) throw new Error("Enter a word or short phrase of up to 80 characters.");
  const word = value.normalize("NFKC").trim().replaceAll("’", "'").toLowerCase();
  if (word.length > 80 || !/^[\p{L}][\p{L}\p{M}' -]*$/u.test(word)) throw new Error("Enter a word or short phrase using letters, spaces, apostrophes, or hyphens.");
  return word.replace(/\s+/gu, "_");
}

/** Query only the bundled WordNet files. No word is sent to a remote service. */
export async function lookupWord(value: unknown): Promise<DictionaryResult> {
  const word = normalizeDictionaryWord(value);
  indexPromise ??= loadIndex().catch(error => { indexPromise = undefined; throw error; });
  const index = await indexPromise;
  const candidates = [word];
  // Try exact entries first, then regular inflections. No misleading fuzzy matches.
  if (word.endsWith("ies")) candidates.push(word.slice(0, -3) + "y");
  if (word.endsWith("es")) candidates.push(word.slice(0, -2));
  if (word.endsWith("s") && !word.endsWith("ss")) candidates.push(word.slice(0, -1));
  for (const ending of ["ing", "ed"]) if (word.endsWith(ending)) {
    const stem = word.slice(0, -ending.length);
    candidates.push(stem, stem + "e");
    if (/(.)\1$/u.test(stem)) candidates.push(stem.slice(0, -1));
  }
  const match = candidates.find(candidate => index.has(candidate));
  const definitions: DictionaryDefinition[] = [];
  for (const reference of (match ? index.get(match) ?? [] : []).slice(0, 24)) {
    const file = await open(join(dictionaryPath, `data.${reference.part}`), "r");
    try {
      const buffer = Buffer.alloc(16384);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, reference.offset);
      const line = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0]!;
      const separator = line.indexOf("|");
      const fields = line.slice(0, separator).trim().split(/\s+/u);
      const wordCount = Number.parseInt(fields[3]!, 16);
      const synonyms = Array.from({ length: wordCount }, (_, i) => fields[4 + i * 2]!.replaceAll("_", " ").replace(/\((?:a|p|ip)\)$/u, ""));
      const definition = line.slice(separator + 1).trim();
      if (separator >= 0 && definition) definitions.push({ partOfSpeech: parts[reference.part], definition, synonyms: [...new Set(synonyms)].filter(synonym => synonym !== match?.replaceAll("_", " ")) });
    } finally { await file.close(); }
  }
  return { word: (match ?? word).replaceAll("_", " "), definitions };
}
