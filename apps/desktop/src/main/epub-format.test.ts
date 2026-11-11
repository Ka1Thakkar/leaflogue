import { describe, expect, it } from "vitest";
import { formatEpubChapter } from "./epub-format";

describe("formatted EPUB chapters", () => {
  it("retains headings, emphasis, lists, publisher CSS, fonts and local images", () => {
    const files = new Map([
      ["OPS/style.css", Buffer.from('@import "more.css"; h1 { text-align: center } @font-face { font-family: Book; src: url(font.woff2) }')],
      ["OPS/more.css", Buffer.from('em { font-style: italic }')],
      ["OPS/font.woff2", Buffer.from("font-fixture")],
      ["OPS/cover.png", Buffer.from("image-fixture")],
    ]);
    const result = formatEpubChapter('<html><head><link rel="stylesheet" href="style.css"/></head><body><h1>Title</h1><p>A <em>quiet</em> book.</p><ul><li>One</li></ul><img src="cover.png" alt="Cover"/></body></html>', "OPS/chapter.xhtml", files, new Map([["OPS/font.woff2", "font/woff2"], ["OPS/cover.png", "image/png"]]), { bytes: 0 });
    expect(result.html).toContain('<h1 data-paragraph="0">Title</h1>');
    expect(result.html).toContain("<em >quiet</em>");
    expect(result.html).toContain("<ul >");
    expect(result.html).toContain("data:image/png;base64,");
    expect(result.styles).toContain("text-align: center");
    expect(result.styles).toContain("font-style: italic");
    expect(result.styles).toContain("data:font/woff2;base64,");
    expect(result.text).toBe("Title\n\nA quiet book.\n\nOne");
  });
  it("removes active markup and blocks external and escaping resource references", () => {
    const result = formatEpubChapter('<html><head><style>p{background:url(https://example.com/track)}</style></head><body><p onclick="evil()">Safe<script>evil()</script></p><iframe src="https://example.com"/><img src="../../outside" onerror="evil()"/><a href="javascript:evil()">link</a></body></html>', "OPS/chapter.xhtml", new Map(), new Map(), { bytes: 0 });
    expect(result.html).not.toMatch(/script|iframe|onclick|onerror|evil/u);
    expect(result.styles).not.toContain("https://");
    expect(result.styles).toContain("data:,");
    expect(result.text).toBe("Safe");
  });
});
