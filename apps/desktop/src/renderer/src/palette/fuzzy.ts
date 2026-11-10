/**
 * A small fuzzy scorer for the command palette. Every word typed must match
 * one of an item's fields: whole-field and prefix matches score highest, then
 * matches at the start of a word, then anywhere, then letters in order.
 * Scores run from 0 to 100; `undefined` means no match.
 */

export interface FuzzyField {
  readonly text: string | undefined;
  /** How much a match here counts, from 0 to 1. The title is 1. */
  readonly weight?: number;
}

/** Lower case, without accents, so "Brontë" is found by "bronte". */
export function normalize(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

const WORD_BREAK = /[\s\-_/.,:;'"()[\]&+!?—–]/u;

function startsWord(text: string, index: number): boolean {
  return index === 0 || WORD_BREAK.test(text[index - 1]!);
}

/** How well one typed word matches one field, both already normalised. */
export function scoreWord(word: string, text: string): number | undefined {
  if (!word) return 0;
  if (!text) return undefined;
  const at = text.indexOf(word);
  if (at === 0) return text.length === word.length ? 100 : 85;
  if (at > 0) {
    // A later word that starts with it, else somewhere inside a word.
    let index = at;
    while (index >= 0) {
      if (startsWord(text, index)) return 70 - Math.min(index, 40) / 4;
      index = text.indexOf(word, index + 1);
    }
    return 45 - Math.min(at, 40) / 4;
  }
  if (word.length < 2) return undefined;
  // Letters in order, starting at a word, rewarding runs and word starts;
  // too scattered is no match.
  let from = 0;
  let previous = -2;
  let first = -1;
  let points = 0;
  for (const letter of word) {
    const index = text.indexOf(letter, from);
    if (index < 0) return undefined;
    if (first < 0) {
      if (!startsWord(text, index)) {
        // Try the first letter again where a word begins.
        let start = index;
        while (start >= 0 && !startsWord(text, start)) start = text.indexOf(letter, start + 1);
        if (start < 0) return undefined;
        first = start;
        previous = start;
        from = start + 1;
        points += 2.5;
        continue;
      }
      first = index;
    }
    points += index === previous + 1 ? 3 : startsWord(text, index) ? 2.5 : 1;
    previous = index;
    from = index + 1;
  }
  if (previous - first + 1 > word.length * 2 + 3) return undefined;
  return 8 + (points / word.length) * 9;
}

/** Score a query against an item's fields; every word must match somewhere. */
export function fuzzyScore(query: string, fields: readonly FuzzyField[]): number | undefined {
  const words = normalize(query).split(/\s+/u).filter(Boolean);
  if (words.length === 0) return 0;
  const texts = fields.map(({ text, weight = 1 }) => ({ text: text ? normalize(text) : "", weight }));
  let total = 0;
  for (const word of words) {
    let best: number | undefined;
    for (const { text, weight } of texts) {
      const score = scoreWord(word, text);
      if (score !== undefined && (best === undefined || score * weight > best)) best = score * weight;
    }
    if (best === undefined) return undefined;
    total += best;
  }
  return total / words.length;
}
