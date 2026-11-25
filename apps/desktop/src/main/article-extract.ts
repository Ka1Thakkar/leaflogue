import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import { articleUrl, MAX_ARTICLE_BYTES, parseArticle, type ArticleSnapshot } from "./article-document";

/** Detached DOM: scripts/resources remain disabled. Extract text, never return remote HTML. */
export function extractArticle(html: string, url: string, now = Date.now()): ArticleSnapshot {
  articleUrl(url);
  if (Buffer.byteLength(html) > MAX_ARTICLE_BYTES || (html.match(/</gu)?.length ?? 0) > 40_000) throw new Error("Article is too complex to extract.");
  const dom = new JSDOM(html, { url, virtualConsole: new VirtualConsole() });
  try {
    const result = new Readability(dom.window.document, { maxElemsToParse: 20_000, charThreshold: 100, disableJSONLD: true }).parse();
    if (!result?.content) throw new Error("No readable article text was found. This page may require sign-in or a browser.");
    const cleaned = new JSDOM(result.content, { virtualConsole: new VirtualConsole() });
    try {
      cleaned.window.document.querySelectorAll("script,style,noscript,iframe,object,embed,form,svg,math").forEach(node => node.remove());
      const tags = "p,h1,h2,h3,h4,h5,h6,li,blockquote,pre";
      const paragraphs = Array.from(cleaned.window.document.querySelectorAll(tags))
        .filter(node => !node.querySelector(tags)).map(node => node.textContent?.replace(/\s+/gu, " ").trim() ?? "").filter(Boolean);
      if (!paragraphs.length) {
        const text = cleaned.window.document.body.textContent?.trim();
        if (text) paragraphs.push(text);
      }
      const snapshot: ArticleSnapshot = { format: "leaflogue-article", version: 1, url,
        title: (result.title?.trim() || new URL(url).hostname).slice(0, 1000), author: (result.byline?.trim() ?? "").slice(0, 300), capturedAt: now, paragraphs };
      parseArticle(Buffer.from(JSON.stringify(snapshot)));
      return snapshot;
    } finally { cleaned.window.close(); }
  } finally { dom.window.close(); }
}
