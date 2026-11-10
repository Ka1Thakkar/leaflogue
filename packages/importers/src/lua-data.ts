/**
 * A reader for the one Lua shape KOReader writes to its sidecar files:
 * `return { ... }` holding strings, numbers, booleans, and nested tables.
 *
 * It parses data and never evaluates anything. Identifiers, calls, operators
 * other than a leading minus, and every other Lua construct are refused, so a
 * hostile sidecar can only fail to import. Keys go into a `Map`, never a plain
 * object, so a key such as `__proto__` is just a key.
 */

export type LuaValue = string | number | boolean | LuaTable;
export type LuaTable = Map<string | number, LuaValue>;

const MAX_DEPTH = 32;
const MAX_ENTRIES = 200_000;

export function parseLuaData(source: string): LuaTable {
  const parser = new Parser(source);
  parser.skipSpace();
  parser.expectWord("return");
  parser.skipSpace();
  const value = parser.table(0);
  parser.skipSpace();
  if (parser.peek(";")) parser.position += 1;
  parser.skipSpace();
  if (parser.position !== source.length) parser.fail("unexpected content after the table");
  return value;
}

class Parser {
  position = 0;
  #entries = 0;

  constructor(private readonly source: string) {}

  fail(message: string): never {
    throw new Error(`Not a KOReader sidecar: ${message} at character ${this.position}`);
  }

  peek(text: string): boolean {
    return this.source.startsWith(text, this.position);
  }

  expectWord(word: string): void {
    if (!this.peek(word) || /[\w]/u.test(this.source[this.position + word.length] ?? "")) {
      this.fail(`expected "${word}"`);
    }
    this.position += word.length;
  }

  skipSpace(): void {
    for (;;) {
      const character = this.source[this.position];
      if (character === " " || character === "\t" || character === "\n" || character === "\r" || character === "\f" || character === "\v") {
        this.position += 1;
      } else if (this.peek("--")) {
        this.position += 2;
        const level = this.longBracketLevel();
        if (level !== undefined) {
          this.longString(level);
        } else {
          const end = this.source.indexOf("\n", this.position);
          this.position = end === -1 ? this.source.length : end + 1;
        }
      } else {
        return;
      }
    }
  }

  table(depth: number): LuaTable {
    if (depth >= MAX_DEPTH) this.fail("tables are nested too deeply");
    if (!this.peek("{")) this.fail("expected a table");
    this.position += 1;
    const table: LuaTable = new Map();
    let nextIndex = 1;
    for (;;) {
      this.skipSpace();
      if (this.peek("}")) {
        this.position += 1;
        return table;
      }
      let key: string | number | undefined;
      if (this.peek("[") && this.longBracketLevel() === undefined) {
        this.position += 1;
        this.skipSpace();
        const keyValue = this.value(depth);
        if (typeof keyValue !== "string" && typeof keyValue !== "number") this.fail("a table key must be a string or number");
        if (typeof keyValue === "number" && !Number.isFinite(keyValue)) this.fail("a table key must be finite");
        key = keyValue;
        this.skipSpace();
        if (!this.peek("]")) this.fail('expected "]"');
        this.position += 1;
        this.skipSpace();
        if (!this.peek("=")) this.fail('expected "="');
        this.position += 1;
      } else {
        const name = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(this.source.slice(this.position, this.position + 256))?.[0];
        const after = name ? this.source.slice(this.position + name.length, this.position + name.length + 256).match(/^\s*=(?!=)/u) : null;
        if (name && after && !["true", "false", "nil"].includes(name)) {
          key = name;
          this.position += name.length + after[0].length;
        }
      }
      this.skipSpace();
      const value = this.value(depth);
      if (++this.#entries > MAX_ENTRIES) this.fail("too many entries");
      if (key === undefined) {
        if (value !== undefined) table.set(nextIndex, value);
        nextIndex += 1;
      } else if (value !== undefined) {
        table.set(key, value);
      }
      this.skipSpace();
      if (this.peek(",") || this.peek(";")) {
        this.position += 1;
      } else if (!this.peek("}")) {
        this.fail('expected "," or "}"');
      }
    }
  }

  /** A value; `undefined` stands for `nil`, which Lua tables do not store. */
  value(depth: number): LuaValue | undefined {
    const character = this.source[this.position];
    if (character === "{") return this.table(depth + 1);
    if (character === '"' || character === "'") return this.quotedString(character);
    if (character === "[") {
      const level = this.longBracketLevel();
      if (level === undefined) this.fail("unexpected \"[\"");
      return this.longString(level);
    }
    if (this.peek("true")) return this.keyword("true", true);
    if (this.peek("false")) return this.keyword("false", false);
    if (this.peek("nil")) {
      this.expectWord("nil");
      return undefined;
    }
    return this.number();
  }

  keyword<T>(word: string, value: T): T {
    this.expectWord(word);
    return value;
  }

  number(): number {
    const match = /^-?\s*(?:0[xX][0-9A-Fa-f]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/u.exec(
      this.source.slice(this.position, this.position + 64),
    );
    if (!match) this.fail("expected a value");
    this.position += match[0].length;
    const text = match[0].replace(/\s+/gu, "");
    const negative = text.startsWith("-");
    const body = negative ? text.slice(1) : text;
    const parsed = /^0[xX]/u.test(body) ? Number.parseInt(body.slice(2), 16) : Number(body);
    if (!Number.isFinite(parsed)) this.fail("number is out of range");
    if (/[\w.]/u.test(this.source[this.position] ?? "")) this.fail("malformed number");
    return negative ? -parsed : parsed;
  }

  /** The level of a long bracket (`[[` is 0, `[==[` is 2) starting here, if any. */
  longBracketLevel(): number | undefined {
    const match = /^\[(=*)\[/u.exec(this.source.slice(this.position, this.position + 64));
    return match ? match[1]!.length : undefined;
  }

  longString(level: number): string {
    this.position += level + 2;
    const close = `]${"=".repeat(level)}]`;
    const end = this.source.indexOf(close, this.position);
    if (end === -1) this.fail("unterminated long string");
    let value = this.source.slice(this.position, end);
    // Lua drops a newline straight after the opening bracket.
    if (value.startsWith("\r\n")) value = value.slice(2);
    else if (value.startsWith("\n") || value.startsWith("\r")) value = value.slice(1);
    this.position = end + close.length;
    return value;
  }

  quotedString(quote: string): string {
    this.position += 1;
    let value = "";
    for (;;) {
      const character = this.source[this.position];
      if (character === undefined) this.fail("unterminated string");
      if (character === quote) {
        this.position += 1;
        return value;
      }
      if (character === "\n" || character === "\r") this.fail("unescaped line break in a string");
      if (character !== "\\") {
        const end = this.#plainRun(quote);
        value += this.source.slice(this.position, end);
        this.position = end;
        continue;
      }
      this.position += 1;
      const escape = this.source[this.position];
      if (escape === undefined) this.fail("unterminated string");
      const simple: Record<string, string> = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", '"': '"', "'": "'" };
      if (Object.hasOwn(simple, escape)) {
        value += simple[escape];
        this.position += 1;
      } else if (escape === "\n" || escape === "\r") {
        // `%q` writes a newline as a backslash followed by a real line break.
        value += "\n";
        this.position += 1;
        const pair = this.source[this.position];
        if ((pair === "\n" || pair === "\r") && pair !== escape) this.position += 1;
      } else if (escape === "x") {
        const hex = /^[0-9A-Fa-f]{2}/u.exec(this.source.slice(this.position + 1, this.position + 3))?.[0];
        if (!hex) this.fail("malformed \\x escape");
        value += this.#byteEscape(Number.parseInt(hex, 16));
        this.position += 3;
      } else if (escape === "z") {
        this.position += 1;
        while (/\s/u.test(this.source[this.position] ?? "")) this.position += 1;
      } else if (escape === "u") {
        const match = /^\{([0-9A-Fa-f]{1,6})\}/u.exec(this.source.slice(this.position + 1, this.position + 10));
        const codePoint = match ? Number.parseInt(match[1]!, 16) : Number.NaN;
        if (!match || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) this.fail("malformed \\u escape");
        value += String.fromCodePoint(codePoint);
        this.position += match[0].length + 1;
      } else if (/\d/u.test(escape)) {
        const digits = /^\d{1,3}/u.exec(this.source.slice(this.position, this.position + 3))![0];
        const byte = Number(digits);
        if (byte > 255) this.fail("malformed decimal escape");
        value += this.#byteEscape(byte);
        this.position += digits.length;
      } else {
        this.fail("unknown escape in a string");
      }
    }
  }

  #plainRun(quote: string): number {
    let end = this.position;
    while (end < this.source.length) {
      const character = this.source[end];
      if (character === quote || character === "\\" || character === "\n" || character === "\r") break;
      end += 1;
    }
    return end;
  }

  /**
   * Byte escapes are kept only for ASCII. KOReader writes UTF-8 text as-is, so
   * a non-ASCII byte escape would split a character; it becomes U+FFFD.
   */
  #byteEscape(byte: number): string {
    return byte < 0x80 ? String.fromCharCode(byte) : "�";
  }
}

/** Read a field from a parsed table only when it has the expected type. */
export function luaString(table: LuaTable | undefined, key: string | number): string | undefined {
  const value = table?.get(key);
  return typeof value === "string" ? value : undefined;
}

export function luaNumber(table: LuaTable | undefined, key: string | number): number | undefined {
  const value = table?.get(key);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function luaTable(table: LuaTable | undefined, key: string | number): LuaTable | undefined {
  const value = table?.get(key);
  return value instanceof Map ? value : undefined;
}

/** The positional entries `[1]`, `[2]`, … of a table, in order, stopping at the first gap. */
export function luaList(table: LuaTable | undefined): LuaValue[] {
  const items: LuaValue[] = [];
  for (let index = 1; table?.has(index); index += 1) items.push(table.get(index)!);
  return items;
}
