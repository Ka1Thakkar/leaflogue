import { containsUnsupportedControlCharacter, MAX_TEXT_FILE_BYTES } from "./common";

/** Bounded CSV grammar shared by review-export adapters; never evaluates cells. */
export function readCsv(source: string): readonly (readonly string[])[] {
  if (new TextEncoder().encode(source).byteLength > MAX_TEXT_FILE_BYTES) throw new Error("CSV exceeds the 16 MiB limit");
  if (containsUnsupportedControlCharacter(source)) throw new Error("CSV contains unsupported control characters");
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false, closed = false;
  const field = () => {
    if (row.length >= 100) throw new Error("CSV exceeds 100 columns");
    row.push(cell); cell = ""; closed = false;
  };
  const record = () => {
    field();
    if (row.some((value) => value.trim())) rows.push(row);
    row = [];
    if (rows.length > 20_001) throw new Error("CSV exceeds 20,000 books");
  };
  const text = source.replace(/^\uFEFF/u, "");
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { cell += '"'; index += 1; }
        else { quoted = false; closed = true; }
      } else cell += char;
    } else if (char === ',') field();
    else if (char === '\r' || char === '\n') {
      record(); if (char === '\r' && text[index + 1] === '\n') index += 1;
    } else if (char === '"' && !cell && !closed) quoted = true;
    else if (closed || char === '"') throw new Error("Malformed CSV quoting");
    else cell += char;
    if (cell.length > 200_000) throw new Error("CSV cell exceeds 200,000 characters");
  }
  if (quoted) throw new Error("CSV ends inside a quoted field");
  if (cell || row.length || closed) record();
  return rows;
}
