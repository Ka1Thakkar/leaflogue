import { useEffect, useState, type RefObject } from "react";
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { BookId, ReaderDocument, ThemeTokens } from "@leaflogue/contracts";

type PageColors = { background: string; foreground: string };
type Job = { active: boolean; cancel?: () => void };

/** Pages either side of the open one are painted ahead so turning is instant. */
const PREFETCH = 1;
/** Painted bitmaps further than this from the open page are released. */
const KEEP = 2;

/**
 * Paint the visible page and its neighbours into their own hidden page images.
 * PDF actions and annotation widgets are never executed.
 */
export function usePdfPages(book: ReaderDocument | undefined, bookId: BookId, frame: RefObject<HTMLIFrameElement | null>, loaded: number, chapter: number, onError: (message: string) => void, display: { dark: boolean; theme: boolean }, tokens?: ThemeTokens) {
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  useEffect(() => {
    const ownerDocument = frame.current?.contentDocument;
    if (book?.format !== "pdf" || !loaded || ownerDocument?.body.dataset.edition !== book.sha256) return;
    let active = true; let task: PDFDocumentLoadingTask | undefined;
    void window.leaflogue.reader!.readPdf(bookId, book.sha256).then(async (bytes) => {
      if (!active) return;
      const { getDocument, GlobalWorkerOptions } = await import("pdfjs-dist");
      if (!active) return;
      GlobalWorkerOptions.workerSrc = workerUrl;
      task = getDocument({ ownerDocument, disableWorkerRendering: true, data: bytes, enableXfa: false, useSystemFonts: true, useWorkerFetch: false, disableAutoFetch: true });
      const document = await task.promise;
      if (active) setPdf(document);
    }).catch(() => { if (active) onError("This PDF could not be rendered. Try reopening the linked file."); });
    return () => { active = false; setPdf(undefined); if (task) void task.destroy(); };
  }, [book, bookId, onError, loaded, frame]);
  useEffect(() => {
    const doc = frame.current?.contentDocument;
    if (!pdf || !loaded || !doc) return;
    const requestedColors: PageColors | undefined = display.theme && tokens ? { background: tokens.paper, foreground: tokens.ink } : display.dark ? { background: "#000000", foreground: "#ffffff" } : undefined;
    const key = requestedColors ? `${requestedColors.background}|${requestedColors.foreground}` : "original";
    const image = (index: number) => doc.querySelector<HTMLImageElement>(`article[data-chapter="${index}"] .pdf-sheet .pdf-page-image`);
    // A page painted in other colours must not flash before it is repainted.
    for (const img of doc.querySelectorAll<HTMLImageElement>(".pdf-page-image[data-rendered]")) if (img.dataset.key !== key) delete img.dataset.rendered;
    const job: Job = { active: true };
    const order = [chapter, ...Array.from({ length: PREFETCH }, (_, i) => [chapter + i + 1, chapter - i - 1]).flat()].filter((index) => index >= 0 && index < pdf.numPages);
    void (async () => {
      for (const index of order) {
        const target = image(index); if (!target || !job.active) continue;
        if (target.dataset.rendered === "true" && target.dataset.key === key) continue;
        try { await paintPage(pdf, index, target, requestedColors, key, job); }
        catch (error) {
          if (!job.active || (error instanceof Error && error.name === "RenderingCancelledException")) return;
          // Only the page the reader is looking at reports a failure.
          if (index === chapter) onError("This PDF page could not be rendered.");
        }
      }
    })();
    // Release decoded bitmaps of pages the reader has moved away from.
    for (const img of doc.querySelectorAll<HTMLImageElement>(".pdf-page-image[src]")) {
      const index = Number(img.closest("article[data-chapter]")?.getAttribute("data-chapter"));
      if (Math.abs(index - chapter) > KEEP) { img.removeAttribute("src"); delete img.dataset.rendered; delete img.dataset.key; }
    }
    const sheet = image(chapter)?.parentElement;
    if (sheet) for (const span of sheet.querySelectorAll<HTMLElement>("[data-pdf-text-width]")) {
      const width = span.offsetWidth; const target = Number(span.dataset.pdfTextWidth);
      if (width && Number.isFinite(target) && target > 0) span.style.transform = `rotate(${span.dataset.pdfAngle ?? 0}rad) scaleX(${target / width})`;
    }
    return () => { job.active = false; job.cancel?.(); };
  }, [pdf, frame, loaded, chapter, onError, display.dark, display.theme, tokens]);
}

async function paintPage(pdf: PDFDocumentProxy, index: number, image: HTMLImageElement, requestedColors: PageColors | undefined, key: string, job: Job) {
  const sheet = image.parentElement!;
  const page = await pdf.getPage(index + 1);
  const canvas = image.ownerDocument.createElement("canvas");
  let scratch: HTMLCanvasElement | undefined;
  try {
    if (!job.active) return;
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2, window.devicePixelRatio || 1, Math.sqrt(16_000_000 / (base.width * base.height)));
    const viewport = page.getViewport({ scale }); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    const { OPS } = await import("pdfjs-dist");
    const operators = requestedColors ? await page.getOperatorList() : undefined;
    if (!job.active) return;
    const imageOps = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintInlineImageXObjectGroup, OPS.paintImageXObjectRepeat]);
    const maskOps = new Set([OPS.paintImageMaskXObject, OPS.paintImageMaskXObjectGroup, OPS.paintImageMaskXObjectRepeat, OPS.paintSolidColorImageMask]);
    const hasImages = operators?.fnArray.some((op) => imageOps.has(op) || maskOps.has(op));
    const spans = Array.from(sheet.querySelectorAll<HTMLElement>("[data-pdf-text-width]"));
    const hasText = spans.length > 0;
    // Keep scans/covers and complex transparency artwork intact. Separating
    // their text/graphics would need flattening or OCR, not a colour filter.
    let pendingClip = false;
    const complexArtwork = operators?.fnArray.some((op, i) => {
      if (op === OPS.clip || op === OPS.eoClip) pendingClip = true;
      if (op === OPS.constructPath && pendingClip) {
        pendingClip = false;
        const args: unknown = operators.argsArray[i];
        // A clip followed by endPath is ordinary page/image cropping, not
        // transparency artwork. Replay it in the original-image layer.
        if (!Array.isArray(args) || args[0] !== OPS.endPath) return true;
      }
      return op === OPS.beginGroup || op === OPS.setTextRenderingMode || op === OPS.paintFormXObjectBegin || op === OPS.paintImageXObjectRepeat || op === OPS.paintInlineImageXObjectGroup || maskOps.has(op);
    });
    // An image layer must not cover text printed over a photograph. Preserve
    // the original page when these bounds overlap, rather than reorder it.
    // Compared in unscaled page units so pages that are not displayed (the
    // neighbours painted ahead) are measured the same way as the open one.
    let overlappingText = false;
    if (hasImages && hasText && operators && !complexArtwork) {
      const textBounds = spans.map((span) => {
        const left = parseFloat(span.style.left); const top = parseFloat(span.style.top);
        return { left, top, right: left + Number(span.dataset.pdfTextWidth), bottom: top + parseFloat(span.style.fontSize) };
      }).filter((r) => [r.left, r.top, r.right, r.bottom].every(Number.isFinite));
      let matrix = new DOMMatrix(); const stack: DOMMatrix[] = [];
      for (let i = 0; i < operators.fnArray.length; i++) {
        const op = operators.fnArray[i]; const args: unknown = operators.argsArray[i];
        if (op === OPS.save) stack.push(matrix);
        else if (op === OPS.restore) matrix = stack.pop() ?? new DOMMatrix();
        else if (op === OPS.transform && Array.isArray(args) && args.length === 6 && args.every((value: unknown) => typeof value === "number")) matrix = matrix.multiply(new DOMMatrix(args as number[]));
        else if (imageOps.has(op!)) {
          const transform = new DOMMatrix(base.transform).multiply(matrix);
          const points = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => transform.transformPoint({ x, y }));
          const left = Math.min(...points.map((p) => p.x)); const right = Math.max(...points.map((p) => p.x));
          const top = Math.min(...points.map((p) => p.y)); const bottom = Math.max(...points.map((p) => p.y));
          overlappingText = textBounds.some((r) => r.left < right && r.right > left && r.top < bottom && r.bottom > top);
          if (overlappingText) break;
        }
      }
    }
    const pageColors = hasImages && (!hasText || complexArtwork || overlappingText) ? undefined : requestedColors;
    await run(job, page.render({ canvas, viewport, ...(pageColors ? { pageColors, operationsFilter: (i, list) => !imageOps.has(list.fnArray[i]!) } : {}) }));
    if (!job.active) return;
    if (pageColors && hasImages) {
      // PDF.js caches decoded images. Replay only image paint and its graphics
      // state into a transparent layer; do not recolour the artwork.
      scratch = canvas.ownerDocument.createElement("canvas");
      scratch.width = canvas.width; scratch.height = canvas.height;
      const paints = new Set([OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke, OPS.shadingFill, OPS.rawFillPath, OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText]);
      await run(job, page.render({ canvas: scratch, canvasContext: scratch.getContext("2d", { alpha: true })!, viewport, background: "rgba(0,0,0,0)", operationsFilter: (i, list) => {
        const op = list.fnArray[i]!;
        // Modern PDF.js folds vector painting into constructPath. Clipping
        // paths still need to execute so image crops retain their shape.
        const args: unknown = list.argsArray[i];
        return op === OPS.constructPath ? Array.isArray(args) && args[0] === OPS.endPath : !paints.has(op);
      } }));
      if (!job.active) return;
      canvas.getContext("2d")!.drawImage(scratch, 0, 0);
    } else if (requestedColors && !pageColors) {
      // Pages kept whole (scans, figures with captions, layered artwork) would
      // otherwise flash white between themed pages. Tone mostly-monochrome
      // pages into the reader's paper and ink; leave colour artwork as printed.
      themeMonochromePage(canvas, requestedColors);
    }
    // Chromium can retain correct canvas pixels without compositing them in
    // a transformed, sandboxed iframe. Present a decoded local bitmap instead.
    const source = canvas.toDataURL("image/png");
    canvas.width = canvas.height = 0;
    if (!job.active || !image.isConnected) return;
    // The image stays hidden (no data-rendered) until decoded, so the reader
    // sees themed paper rather than a blank or broken image while it loads.
    image.src = source; await image.decode();
    if (!job.active) return;
    image.dataset.key = key; image.dataset.rendered = "true";
  } finally {
    canvas.width = canvas.height = 0;
    if (scratch) scratch.width = scratch.height = 0;
    page.cleanup();
  }
}

async function run(job: Job, task: { promise: Promise<void>; cancel: () => void }) {
  job.cancel = () => task.cancel();
  try { await task.promise; } finally { job.cancel = undefined; }
}

/** Share of sampled pixels that are visibly coloured before a page counts as artwork. */
const COLOUR_LIMIT = 0.04;

/** Remap a greyscale page's lightness onto paper→ink. Returns false for colour artwork. */
export function themeMonochromePage(canvas: HTMLCanvasElement, colors: PageColors): boolean {
  const context = canvas.getContext("2d"); if (!context || !canvas.width || !canvas.height) return false;
  const data = context.getImageData(0, 0, canvas.width, canvas.height); const px = data.data;
  if (!isMonochrome(px)) return false;
  const paper = parseColor(canvas.ownerDocument, colors.background); const ink = parseColor(canvas.ownerDocument, colors.foreground);
  if (!paper || !ink) return false;
  remapLightness(px, paper, ink);
  context.putImageData(data, 0, 0);
  return true;
}

export function isMonochrome(px: Uint8ClampedArray): boolean {
  let sampled = 0; let colourful = 0;
  // Every fourth pixel is plenty to tell a scan from a photograph.
  for (let i = 0; i < px.length; i += 16) {
    const r = px[i]!; const g = px[i + 1]!; const b = px[i + 2]!;
    sampled++; if (Math.max(r, g, b) - Math.min(r, g, b) > 40) colourful++;
  }
  return sampled > 0 && colourful / sampled <= COLOUR_LIMIT;
}

export function remapLightness(px: Uint8ClampedArray, paper: [number, number, number], ink: [number, number, number]) {
  const lut = [0, 1, 2].map((c) => Float32Array.from({ length: 256 }, (_, y) => ink[c]! + (paper[c]! - ink[c]!) * y / 255));
  const [lr, lg, lb] = lut as [Float32Array, Float32Array, Float32Array];
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i]!; const g = px[i + 1]!; const b = px[i + 2]!;
    const y = (r * 54 + g * 183 + b * 19) >> 8;
    // Keep any faint tint (stamps, highlighter) on top of the remapped tone.
    px[i] = lr[y]! + r - y; px[i + 1] = lg[y]! + g - y; px[i + 2] = lb[y]! + b - y;
  }
}

function parseColor(doc: Document, value: string): [number, number, number] | undefined {
  const canvas = doc.createElement("canvas"); canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d"); if (!context) return undefined;
  context.fillStyle = "#000"; context.fillStyle = value; context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return [r!, g!, b!];
}
