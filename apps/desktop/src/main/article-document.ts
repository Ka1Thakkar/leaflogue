import { createHash } from "node:crypto";
import type { EpubDocument } from "@leaflogue/contracts";

export interface ArticleSnapshot {
  readonly format: "leaflogue-article";
  readonly version: 1;
  readonly url: string;
  readonly title: string;
  readonly author: string;
  readonly capturedAt: number;
  readonly paragraphs: readonly string[];
}
export const MAX_ARTICLE_BYTES = 5 * 1024 * 1024;
export function articleUrl(value: string): URL {
  if (value.length > 4096) throw new Error("Article URL is too long.");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password ||
      [...url.searchParams.keys()].some(key => /^(?:access_token|api_key|auth|password|secret|signature|token)$/iu.test(key)) || (url.port && url.port !== "443")) {
    throw new Error("Use a public HTTPS article URL without credentials or a custom port.");
  }
  url.hash = "";
  return url;
}
const escape = (text: string) => text.replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/** Native, versioned reader format. Only validated text is ever turned into markup. */
export function parseArticle(bytes: Buffer): EpubDocument {
  if (bytes.length > MAX_ARTICLE_BYTES) throw new Error("Saved article exceeds the 5 MiB limit.");
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (!value || typeof value !== "object") throw new Error("Invalid saved article.");
  const article = value as ArticleSnapshot;
  if (article.format !== "leaflogue-article" || article.version !== 1 ||
      typeof article.title !== "string" || !article.title.trim() || article.title.length > 1000 ||
      typeof article.author !== "string" || article.author.length > 300 || typeof article.url !== "string" ||
      !Number.isSafeInteger(article.capturedAt) || article.capturedAt < 0 ||
      !Array.isArray(article.paragraphs) || !article.paragraphs.length || article.paragraphs.length > 5000 ||
      article.paragraphs.some((p: unknown) => typeof p !== "string" || !p.trim() || p.length > 100_000)) {
    throw new Error("Saved article has invalid or unsupported fields.");
  }
  articleUrl(article.url);
  return {
    format: "article", source: { url: article.url, capturedAt: article.capturedAt },
    sha256: createHash("sha256").update(bytes).digest("hex"), position: { chapter: 0, paragraph: 0 },
    chapters: [{ id: "article", title: article.title, text: article.paragraphs.join("\n\n"), paragraphs: article.paragraphs,
      html: article.paragraphs.map((p: string, index: number) => `<p data-chapter="0" data-paragraph="${index}">${escape(p)}</p>`).join("") }],
  };
}
