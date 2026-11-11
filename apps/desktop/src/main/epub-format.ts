import { posix } from "node:path";
import { SaxesParser } from "saxes";
import postcss from "postcss";
import valueParser from "postcss-value-parser";

interface Element { tag: string; attributes: Record<string, string>; children: (Element | string)[] }
const escape = (value: string) => value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
const tags = new Set("div section article aside header footer main nav p h1 h2 h3 h4 h5 h6 span em strong b i u s small sub sup br hr blockquote q pre code ul ol li dl dt dd table caption thead tbody tfoot tr th td figure figcaption img a abbr cite time ruby rt rp mark".split(" "));
const anchors = new Set("p h1 h2 h3 h4 h5 h6 li dt dd pre figcaption blockquote".split(" "));
const blocked = new Set("head script style link meta iframe object embed form input button textarea select audio video canvas".split(" "));
const textOf = (node: Element | string): string => typeof node === "string" ? node : node.children.map(textOf).join("");

export function formatEpubChapter(source: string, path: string, files: Map<string, Buffer>, media: Map<string, string>, budget: { bytes: number }) {
  const root: Element = { tag: "root", attributes: {}, children: [] };
  const stack = [root];
  const parser = new SaxesParser({ xmlns: false });
  parser.on("doctype", (value) => { if (value.trim().toLowerCase() !== "html") throw new Error("Unsupported EPUB document type."); });
  parser.on("opentag", (tag) => {
    const node: Element = { tag: tag.name.split(":").at(-1)!.toLowerCase(), attributes: tag.attributes as Record<string, string>, children: [] };
    stack.at(-1)!.children.push(node); stack.push(node);
  });
  parser.on("closetag", () => { stack.pop(); });
  const addText = (value: string) => { stack.at(-1)!.children.push(value); };
  parser.on("text", addText); parser.on("cdata", addText); parser.write(source).close();
  const resolve = (url: string, from: string) => {
    if (/^[a-z][a-z\d+.-]*:|^\/\//iu.test(url) || url.startsWith("/")) return undefined;
    try {
      const resolved = posix.normalize(posix.join(posix.dirname(from), decodeURIComponent(url.split(/[?#]/u)[0]!)));
      return resolved.startsWith("../") ? undefined : resolved;
    } catch { return undefined; }
  };
  const resource = (url: string, from: string) => {
    if (/^data:(image\/(png|jpeg|gif|webp|svg\+xml)|font\/(woff2?|ttf|otf)|application\/(font-woff|vnd\.ms-opentype|x-font-ttf));base64,[a-z\d+/=]+$/iu.test(url)) { budget.bytes += url.length; if (budget.bytes > 40 * 1024 * 1024) throw new Error("EPUB formatted resources exceed the 40 MB limit."); return url; }
    const resolved = resolve(url, from);
    const bytes = resolved ? files.get(resolved) : undefined;
    const mime = resolved ? media.get(resolved) : undefined;
    if (!bytes || !mime || !/^(image\/(png|jpeg|gif|webp|svg\+xml)|font\/(woff2?|ttf|otf)|application\/(font-woff|vnd\.ms-opentype|x-font-ttf))$/u.test(mime)) return "data:,";
    budget.bytes += Math.ceil(bytes.length * 4 / 3);
    if (budget.bytes > 40 * 1024 * 1024) throw new Error("EPUB formatted resources exceed the 40 MB limit.");
    return `data:${mime};base64,${bytes.toString("base64")}`;
  };
  const urls = (value: string, from: string) => {
    const parsed = valueParser(value);
    parsed.walk((node) => {
      if (node.type === "function" && node.value.toLowerCase() === "url") {
        const raw = valueParser.stringify(node.nodes).trim().replace(/^(['"])(.*)\1$/u, "$2");
        node.nodes = [{ type: "string", quote: '"', value: resource(raw, from), sourceIndex: 0, sourceEndIndex: 0 }];
        return false;
      }
    });
    return parsed.toString();
  };
  // Only CSS is read as a stylesheet. Calibre and Adobe tooling often link an
  // XML page template (.xpgt) with rel="stylesheet"; the manifest's media type
  // tells them apart, and a missing one is accepted only for a declared CSS link.
  const isStylesheet = (resolved: string, declared?: string) => {
    const type = media.get(resolved)?.toLowerCase();
    if (type) return type === "text/css";
    return declared === undefined || declared.trim().toLowerCase() === "text/css";
  };
  // A stylesheet the parser cannot read is dropped, so one bad file costs the
  // chapter its publisher styling rather than failing the whole book.
  const parse = (value: string) => {
    try { return postcss.parse(value); } catch (error) {
      if (error instanceof Error && error.name === "CssSyntaxError") return undefined;
      throw error;
    }
  };
  const css = (value: string, from: string, seen = new Set<string>()): string => {
    if (seen.size > 12 || value.length > 2_000_000) throw new Error("EPUB stylesheet exceeds reader limits.");
    const sheet = parse(value);
    if (!sheet) return "";
    sheet.walkAtRules((rule) => {
      if (rule.name.toLowerCase() !== "import") return;
      const first = valueParser(rule.params).nodes[0];
      const url = first?.type === "string" ? first.value : first?.type === "function" ? valueParser.stringify(first.nodes).replace(/^(['"])(.*)\1$/u, "$2") : "";
      const resolved = resolve(url, from);
      if (!resolved || seen.has(resolved) || !files.has(resolved) || !isStylesheet(resolved)) { rule.remove(); return; }
      const nextSeen = new Set(seen); nextSeen.add(resolved);
      const imported = parse(css(files.get(resolved)!.toString("utf8"), resolved, nextSeen));
      if (imported?.nodes.length) rule.replaceWith(...imported.nodes); else rule.remove();
    });
    sheet.walkDecls((decl) => { decl.value = urls(decl.value, from); });
    return sheet.toString();
  };
  const styles: string[] = [];
  let body: Element | undefined;
  const inspect = (node: Element) => {
    if (node.tag === "body") body = node;
    if (node.tag === "style") styles.push(css(textOf(node), path));
    if (node.tag === "link" && node.attributes.rel?.toLowerCase() === "stylesheet") {
      const resolved = resolve(node.attributes.href ?? "", path);
      if (resolved && files.has(resolved) && isStylesheet(resolved, node.attributes.type)) styles.push(css(files.get(resolved)!.toString("utf8"), resolved, new Set([resolved])));
    }
    for (const child of node.children) if (typeof child !== "string") inspect(child);
  };
  inspect(root);
  const paragraphs: string[] = [];
  const visibleText = (node: Element | string): string => typeof node === "string" ? node : blocked.has(node.tag) ? "" : node.children.map(visibleText).join("");
  const hasBlock = (node: Element): boolean => node.children.some((child) => typeof child !== "string" && (anchors.has(child.tag) || hasBlock(child)));
  const serialize = (node: Element | string): string => {
    if (typeof node === "string") return escape(node);
    if (blocked.has(node.tag)) return "";
    if (node.tag === "image") return `<img src="${resource(node.attributes.href ?? node.attributes["xlink:href"] ?? "", path)}" alt=""/>`;
    if (!tags.has(node.tag) && node.tag !== "body") return node.children.map(serialize).join("");
    const tag = node.tag === "body" ? "div" : node.tag;
    const attrs: string[] = [];
    for (const [name, value] of Object.entries(node.attributes)) {
      if (/^(class|id|title|lang|dir|alt|colspan|rowspan|start|type|width|height)$/u.test(name)) attrs.push(`${name}="${escape(value)}"`);
      if (name === "style") attrs.push(`style="${escape(urls(value, path))}"`);
    }
    if (tag === "img") attrs.push(`src="${resource(node.attributes.src ?? "", path)}"`);
    if (tag === "a" && node.attributes.href) {
      const href = node.attributes.href;
      const resolved = href.startsWith("#") ? path : resolve(href, path);
      if (resolved) attrs.push(`data-reader-link="${escape(`${resolved}#${href.split("#")[1] ?? ""}`)}"`);
    }
    if ((anchors.has(tag) || tag === "div") && !hasBlock(node) && visibleText(node).trim()) {
      attrs.push(`data-paragraph="${paragraphs.length}"`); paragraphs.push(visibleText(node));
    }
    const children = node.children.map(serialize).join("");
    return `<${tag} ${attrs.join(" ")}>${children}${["img", "br", "hr"].includes(tag) ? "" : `</${tag}>`}`;
  };
  const html = body ? serialize(body) : "";
  return { html, styles: styles.join("\n"), text: paragraphs.join("\n\n"), paragraphs };
}
