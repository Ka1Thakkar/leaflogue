import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

/** Bounded reads for immutable local reading sources, through one verified handle. */
export async function readReaderSource(path: string, maximum: number): Promise<{ bytes: Buffer; size: number; mtimeMs: number }> {
  if (!isAbsolute(path) || !Number.isSafeInteger(maximum) || maximum < 1) throw new Error("Invalid local reader source.");
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximum) throw new Error("Reader source exceeds its size limit or is not a regular file.");
    const stream = handle.createReadStream({ start: 0, end: maximum, autoClose: false });
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of stream) {
      const bytes = chunk as Buffer; size += bytes.length;
      if (size > maximum) throw new Error("Reader source exceeds its size limit.");
      chunks.push(bytes);
    }
    return { bytes: Buffer.concat(chunks), size: info.size, mtimeMs: info.mtimeMs };
  } finally { await handle.close(); }
}
