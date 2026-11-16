import { createHash } from "node:crypto";
import type { EpubDocument } from "@leaflogue/contracts";
const escape = (value: string) => value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
/** Parse only page geometry and text. PDF scripts, forms, links and attachments never enter the application DOM. */
const parsed = new Map<string, Promise<EpubDocument>>();
export function parsePdf(bytes: Buffer): Promise<EpubDocument> {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const known = parsed.get(hash); if (known) return known;
  const pending = extractPdf(bytes); parsed.set(hash, pending);
  if (parsed.size > 2) parsed.delete(parsed.keys().next().value!);
  void pending.catch(() => parsed.delete(hash));
  return pending;
}
async function extractPdf(bytes: Buffer): Promise<EpubDocument> {
  if (bytes.length > 50 * 1024 * 1024) throw new Error("PDF exceeds the 50 MB limit.");
  const { getDocument, Util } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: new Uint8Array(bytes), enableXfa: false, useSystemFonts: false, disableFontFace: true, useWorkerFetch: false });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 1000) throw new Error("PDF exceeds the 1,000 page limit.");
    const chapters: EpubDocument["chapters"][number][] = []; let size = 0;
    for (let index = 0; index < pdf.numPages; index++) {
      const page = await pdf.getPage(index + 1); const viewport = page.getViewport({ scale: 1 });
      if (![viewport.width, viewport.height].every((n) => Number.isFinite(n) && n > 0 && n <= 14400)) throw new Error("Unsupported PDF page dimensions.");
      const content = await page.getTextContent(); const paragraphs: string[] = [];
      const spans = content.items.flatMap((item) => {
        if (!("str" in item) || !item.str.trim()) return [];
        const t = Util.transform(viewport.transform, item.transform) as number[];
        if (!t.every(Number.isFinite) || !Number.isFinite(item.width)) throw new Error("Invalid PDF text geometry."); const height = Math.hypot(t[2]!, t[3]!); const angle = Math.atan2(t[1]!, t[0]!);
        const ascent = (content.styles[item.fontName]?.ascent ?? 0.8) * height;
        const left = t[4]! + Math.sin(angle) * ascent; const top = t[5]! - Math.cos(angle) * ascent;
        const paragraph = paragraphs.length; paragraphs.push(item.str); size += item.str.length;
        if (size > 10 * 1024 * 1024) throw new Error("PDF text exceeds the 10 MB limit.");
        return [`<span data-paragraph="${paragraph}" data-pdf-text-width="${item.width}" style="position:absolute;left:${left}px;top:${top}px;font-size:${height}px;line-height:1;font-family:sans-serif;white-space:pre;transform-origin:0 0;transform:rotate(${angle}rad);color:transparent" data-pdf-angle="${angle}">${escape(item.str)}</span>`];
      });
      // Empty placeholder keeps page-position persistence valid for image-only pages.
      if (!paragraphs.length) paragraphs.push("");
      chapters.push({ id: `pdf-page-${index + 1}`, title: `Page ${index + 1}`, text: paragraphs.join("\n\n"), paragraphs, html: `<div class="pdf-sheet" data-pdf-width="${viewport.width}" data-pdf-height="${viewport.height}" style="width:${viewport.width}px;height:${viewport.height}px"><canvas aria-hidden="true"></canvas>${spans.join("")}</div>` });
      page.cleanup();
    }
    return { format: "pdf", sha256: createHash("sha256").update(bytes).digest("hex"), chapters, position: { chapter: 0, paragraph: 0 } };
  } catch (error) {
    if (error instanceof Error && error.name === "PasswordException") throw new Error("Password-protected PDFs are not supported.", { cause: error });
    throw error;
  } finally { await task.destroy(); }
}
