import assert from "node:assert/strict";
import { once } from "node:events";
import { Worker } from "node:worker_threads";

// Run after the desktop build. No Electron app, browser, network or user data.
const text = "This synthetic paragraph verifies article extraction in the built worker. ".repeat(12);
const worker = new Worker(new URL("../apps/desktop/out/main/article-worker.js", import.meta.url), {
  workerData: { url: "https://example.com/fixture", html: `<html><head><title>Article fixture</title></head><body><article><p>${text}</p><p>${text}</p></article></body></html>` },
  resourceLimits: { maxOldGenerationSizeMb: 128 },
});
try {
  const [message] = await once(worker, "message", { signal: AbortSignal.timeout(15_000) });
  assert.equal(message.error, undefined);
  assert.equal(message.snapshot.format, "leaflogue-article");
  assert.equal(message.snapshot.version, 1);
  assert.equal(message.snapshot.url, "https://example.com/fixture");
  assert.ok(message.snapshot.paragraphs.length > 0);
  console.log(`Built article worker passed (Node ${process.versions.node}; no GUI or network).`);
} finally { await worker.terminate(); }
