import { Worker } from "node:worker_threads";
import type { ArticleSnapshot } from "./article-document";

/** Keep DOM parsing off the UI/main process; cancellation terminates the worker. */
export function extractArticleOffThread(html: string, url: string, signal: AbortSignal): Promise<ArticleSnapshot> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./article-worker.js", import.meta.url), { workerData: { html, url }, resourceLimits: { maxOldGenerationSizeMb: 128 } });
    let settled = false;
    const finish = (error?: unknown, snapshot?: ArticleSnapshot) => {
      if (settled) return; settled = true;
      signal.removeEventListener("abort", abort); void worker.terminate();
      if (error) reject(error instanceof Error ? error : new Error("Article extraction failed.")); else resolve(snapshot!);
    };
    const abort = () => finish(signal.reason ?? new Error("Article extraction cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    worker.once("message", (message: { error?: string; snapshot?: ArticleSnapshot }) => {
      if (message.error || !message.snapshot) finish(new Error(message.error ?? "Article extraction failed."));
      else finish(undefined, message.snapshot);
    });
    worker.once("error", error => finish(error));
    worker.once("exit", () => { if (!settled) finish(new Error("Article extraction stopped before finishing.")); });
    if (signal.aborted) abort();
  });
}
