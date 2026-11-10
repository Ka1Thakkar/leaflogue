const HTML_DESCRIPTION_PATTERN = /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>|&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]+);/iu;
const BLOCK_SELECTOR = "article,blockquote,div,h1,h2,h3,h4,h5,h6,li,p,section";

/**
 * Metadata providers often wrap descriptions in small HTML fragments. Display
 * their readable text without ever inserting that untrusted markup into the
 * document. Plain descriptions are returned unchanged.
 */
export function bookDescriptionText(value: string): string {
  if (!HTML_DESCRIPTION_PATTERN.test(value)) return value;
  const document = new DOMParser().parseFromString(value, "text/html");
  document.querySelectorAll("script,style,template,noscript").forEach((element) => element.remove());
  document.querySelectorAll("br").forEach((element) => element.replaceWith("\n"));
  document.querySelectorAll(BLOCK_SELECTOR).forEach((element) => element.append("\n\n"));
  return (document.body.textContent ?? "")
    .replaceAll("\u00a0", " ")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n[ \t]+/gu, "\n")
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}
