import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function mcpAccessFile(directory: string): string { return join(directory, "mcp-access.json"); }

/** Missing, malformed or replaced access files fail closed on every tool call. */
export function mcpAccessEnabled(file: string): boolean {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) return false;
    return (JSON.parse(readFileSync(file, "utf8")) as { enabled?: unknown }).enabled === true;
  } catch { return false; }
}

export function saveMcpAccess(file: string, enabled: boolean): void {
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error("MCP access file must not be a symbolic link");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ version: 1, enabled })}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}
