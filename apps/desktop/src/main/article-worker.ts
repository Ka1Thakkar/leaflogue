import { parentPort, workerData } from "node:worker_threads";
import { extractArticle } from "./article-extract";
const input = workerData as { html: string; url: string };
try { parentPort!.postMessage({ snapshot: extractArticle(input.html, input.url) }); }
catch (error) { parentPort!.postMessage({ error: error instanceof Error ? error.message : "Article extraction failed." }); }
