import { useEffect, useState, type RefObject } from "react";
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { BookId, EpubDocument } from "@leaflogue/contracts";
/** Paint only the visible page. PDF actions and annotation widgets are never executed. */
export function usePdfPages(book: EpubDocument | undefined, bookId: BookId, frame: RefObject<HTMLIFrameElement | null>, loaded: number, chapter: number, onError: (message: string) => void) {
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  useEffect(() => {
    if (book?.format !== "pdf") return;
    let active = true; let task: PDFDocumentLoadingTask | undefined;
    void window.leaflogue.epub!.readPdf(bookId, book.sha256).then(async (bytes) => {
      if (!active) return;
      const { getDocument, GlobalWorkerOptions } = await import("pdfjs-dist");
      if (!active) return;
      GlobalWorkerOptions.workerSrc = workerUrl;
      task = getDocument({ data: bytes, enableXfa: false, useSystemFonts: true, useWorkerFetch: false, disableAutoFetch: true });
      const document = await task.promise;
      if (active) setPdf(document);
    }).catch(() => { if (active) onError("This PDF could not be rendered. Try reopening the linked file."); });
    return () => { active = false; setPdf(undefined); if (task) void task.destroy(); };
  }, [book, bookId, onError]);
  useEffect(() => {
    if (!pdf || !loaded) return;
    const sheet = frame.current?.contentDocument?.querySelector<HTMLElement>(`article[data-chapter="${chapter}"] .pdf-sheet`);
    const canvas = sheet?.querySelector("canvas"); if (!sheet || !canvas) return;
    let active = true; let render: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | undefined;
    void pdf.getPage(chapter + 1).then(async (page) => {
      if (!active) return;
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(2, window.devicePixelRatio || 1, Math.sqrt(16_000_000 / (base.width * base.height)));
      const viewport = page.getViewport({ scale }); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      render = page.render({ canvas, viewport }); await render.promise;
    }).catch((error: unknown) => { if (active && !(error instanceof Error && error.name === "RenderingCancelledException")) onError("This PDF page could not be rendered."); });
    for (const span of sheet.querySelectorAll<HTMLElement>("[data-pdf-text-width]")) {
      const width = span.offsetWidth; const target = Number(span.dataset.pdfTextWidth);
      if (width && Number.isFinite(target) && target > 0) span.style.transform = `rotate(${span.dataset.pdfAngle ?? 0}rad) scaleX(${target / width})`;
    }
    return () => { active = false; render?.cancel(); };
  }, [pdf, frame, loaded, chapter, onError]);
}
