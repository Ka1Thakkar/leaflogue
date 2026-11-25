import { articleUrl, MAX_ARTICLE_BYTES } from "./article-document";
import { fetchPublicResource } from "./public-resource-fetch";

export type ArticleFetcher = (url: string, init: RequestInit) => Promise<Response>;

/** Redirects are explicit so every hop gets fresh validation and DNS pinning. */
export async function fetchArticle(value: string, signal: AbortSignal, fetcher: ArticleFetcher = fetchPublicResource): Promise<{ url: string; html: string }> {
  let url = articleUrl(value);
  for (let hop = 0; hop <= 5; hop += 1) {
    signal.throwIfAborted();
    const response = await fetcher(url.href, { signal, redirect: "manual", headers: { Accept: "text/html, application/xhtml+xml", "Accept-Encoding": "identity", "User-Agent": "Leaflogue article reader" } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location || hop === 5) throw new Error("Article redirected too many times or without a destination.");
      url = articleUrl(new URL(location, url).href); continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Article request failed (${response.status}).`); }
    if (!/^(text\/html|application\/xhtml\+xml)(?:;|$)/iu.test(response.headers.get("content-type") ?? "")) {
      await response.body?.cancel(); throw new Error("That URL did not return an HTML article.");
    }
    const encoding = response.headers.get("content-encoding");
    if (encoding && encoding !== "identity") { await response.body?.cancel(); throw new Error("The article server returned an unsupported compressed response."); }
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_ARTICLE_BYTES) { await response.body?.cancel(); throw new Error("Article exceeds the 5 MiB limit."); }
    if (!response.body) throw new Error("The article response was empty.");
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value: chunk } = await reader.read();
        if (done) break;
        size += chunk.byteLength;
        if (size > MAX_ARTICLE_BYTES) throw new Error("Article exceeds the 5 MiB limit.");
        chunks.push(chunk);
      }
    } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
    finally { reader.releaseLock(); }
    const bytes = Buffer.concat(chunks);
    const charset = /charset\s*=\s*["']?([^;\s"']+)/iu.exec(response.headers.get("content-type") ?? "")?.[1] ?? "utf-8";
    let html: string;
    try { html = new TextDecoder(charset, { fatal: true }).decode(bytes); }
    catch { throw new Error("The article uses an unsupported or invalid text encoding."); }
    return { url: url.href, html };
  }
  throw new Error("Article retrieval did not finish.");
}
