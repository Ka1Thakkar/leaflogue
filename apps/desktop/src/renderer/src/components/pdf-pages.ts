import { useEffect, useState, type RefObject } from "react";
import type { PDFDocumentProxy, PDFDocumentLoadingTask, PDFPageProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { BookId, EpubDocument, ThemeTokens } from "@leaflogue/contracts";
/** Paint only the visible page. PDF actions and annotation widgets are never executed. */
export function usePdfPages(book: EpubDocument | undefined, bookId: BookId, frame: RefObject<HTMLIFrameElement | null>, loaded: number, chapter: number, onError: (message: string) => void, display: { dark: boolean; theme: boolean }, tokens?: ThemeTokens) {
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  useEffect(() => {
    const ownerDocument = frame.current?.contentDocument;
    if (book?.format !== "pdf" || !loaded || ownerDocument?.body.dataset.edition !== book.sha256) return;
    let active = true; let task: PDFDocumentLoadingTask | undefined;
    void window.leaflogue.epub!.readPdf(bookId, book.sha256).then(async (bytes) => {
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
    if (!pdf || !loaded) return;
    const sheet = frame.current?.contentDocument?.querySelector<HTMLElement>(`article[data-chapter="${chapter}"] .pdf-sheet`);
    const image = sheet?.querySelector<HTMLImageElement>(".pdf-page-image"); if (!sheet || !image) return;
    const canvas = sheet.ownerDocument.createElement("canvas");
    let scratch: HTMLCanvasElement | undefined; let renderedPage: PDFPageProxy | undefined;
    let active = true; let render: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | undefined;
    void pdf.getPage(chapter + 1).then(async (page) => {
      renderedPage = page;
      if (!active) return;
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(2, window.devicePixelRatio || 1, Math.sqrt(16_000_000 / (base.width * base.height)));
      const viewport = page.getViewport({ scale }); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      const requestedColors = display.theme && tokens ? { background: tokens.paper, foreground: tokens.ink } : display.dark ? { background: "#000000", foreground: "#ffffff" } : undefined;
      const { OPS } = await import("pdfjs-dist");
      const operators = requestedColors ? await page.getOperatorList() : undefined;
      if (!active) return;
      const imageOps = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintInlineImageXObjectGroup, OPS.paintImageXObjectRepeat]);
      const maskOps = new Set([OPS.paintImageMaskXObject, OPS.paintImageMaskXObjectGroup, OPS.paintImageMaskXObjectRepeat, OPS.paintSolidColorImageMask]);
      const hasImages = operators?.fnArray.some((op) => imageOps.has(op) || maskOps.has(op));
      const hasText = !!sheet.querySelector("[data-pdf-text-width]");
      // Keep scans/covers and complex transparency artwork intact. Separating
      // their text/graphics would need flattening or OCR, not a colour filter.
      const complexArtwork = operators?.fnArray.some((op) => op === OPS.beginGroup || op === OPS.clip || op === OPS.eoClip || op === OPS.setTextRenderingMode || op === OPS.paintFormXObjectBegin || op === OPS.paintImageXObjectRepeat || op === OPS.paintInlineImageXObjectGroup || maskOps.has(op));
      // An image layer must not cover text printed over a photograph. Preserve
      // the original page when these bounds overlap, rather than reorder it.
      let overlappingText = false;
      if (hasImages && hasText && operators && !complexArtwork) {
        const bounds = sheet.getBoundingClientRect();
        const sx = bounds.width / base.width; const sy = bounds.height / base.height;
        const textBounds = Array.from(sheet.querySelectorAll<HTMLElement>("[data-pdf-text-width]"), (span) => span.getBoundingClientRect());
        let matrix = new DOMMatrix(); const stack: DOMMatrix[] = [];
        for (let i = 0; i < operators.fnArray.length; i++) {
          const op = operators.fnArray[i]; const args: unknown = operators.argsArray[i];
          if (op === OPS.save) stack.push(matrix);
          else if (op === OPS.restore) matrix = stack.pop() ?? new DOMMatrix();
          else if (op === OPS.transform && Array.isArray(args) && args.length === 6 && args.every((value: unknown) => typeof value === "number")) matrix = matrix.multiply(new DOMMatrix(args as number[]));
          else if (imageOps.has(op!)) {
            const transform = new DOMMatrix(base.transform).multiply(matrix);
            const points = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => transform.transformPoint({ x, y }));
            const left = bounds.left + Math.min(...points.map((p) => p.x)) * sx; const right = bounds.left + Math.max(...points.map((p) => p.x)) * sx;
            const top = bounds.top + Math.min(...points.map((p) => p.y)) * sy; const bottom = bounds.top + Math.max(...points.map((p) => p.y)) * sy;
            overlappingText = textBounds.some((r) => r.left < right && r.right > left && r.top < bottom && r.bottom > top);
            if (overlappingText) break;
          }
        }
      }
      const pageColors = hasImages && (!hasText || complexArtwork || overlappingText) ? undefined : requestedColors;
      sheet.style.backgroundColor = pageColors?.background ?? "#ffffff";
      render = page.render({ canvas, viewport, ...(pageColors ? { pageColors, operationsFilter: (index, list) => !imageOps.has(list.fnArray[index]!) } : {}) }); await render.promise; render = undefined;
      if (!active || !sheet.isConnected) return;
      if (pageColors && hasImages) {
        // PDF.js caches decoded images. Replay only image paint and its graphics
        // state into a transparent layer; do not recolour the artwork.
        scratch = canvas.ownerDocument.createElement("canvas");
        scratch.width = canvas.width; scratch.height = canvas.height;
        const paints = new Set([OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke, OPS.shadingFill, OPS.rawFillPath, OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText]);
        render = page.render({ canvas: scratch, canvasContext: scratch.getContext("2d", { alpha: true })!, viewport, background: "rgba(0,0,0,0)", operationsFilter: (index, list) => {
          const op = list.fnArray[index]!;
          // Modern PDF.js folds vector painting into constructPath. Clipping
          // paths still need to execute so image crops retain their shape.
          const args: unknown = list.argsArray[index];
          return op === OPS.constructPath ? Array.isArray(args) && args[0] === OPS.endPath : !paints.has(op);
        } });
        await render.promise; render = undefined;
        if (!active) return;
        canvas.getContext("2d")!.drawImage(scratch, 0, 0);
        scratch.width = scratch.height = 0; scratch = undefined;
      }
      // Chromium can retain correct canvas pixels without compositing them in
      // a transformed, sandboxed iframe. Present a decoded local bitmap instead.
      image.src = canvas.toDataURL("image/png"); await image.decode();
      if (active) image.dataset.rendered = "true";
      canvas.width = canvas.height = 0;
    }).catch((error: unknown) => { if (active && !(error instanceof Error && error.name === "RenderingCancelledException")) onError("This PDF page could not be rendered."); }).finally(() => {
      render = undefined;
      canvas.width = canvas.height = 0;
      if (scratch) scratch.width = scratch.height = 0;
      renderedPage?.cleanup();
    });
    for (const span of sheet.querySelectorAll<HTMLElement>("[data-pdf-text-width]")) {
      const width = span.offsetWidth; const target = Number(span.dataset.pdfTextWidth);
      if (width && Number.isFinite(target) && target > 0) span.style.transform = `rotate(${span.dataset.pdfAngle ?? 0}rad) scaleX(${target / width})`;
    }
    return () => { active = false; render?.cancel(); image.removeAttribute("src"); delete image.dataset.rendered; };
  }, [pdf, frame, loaded, chapter, onError, display.dark, display.theme, tokens]);
}
