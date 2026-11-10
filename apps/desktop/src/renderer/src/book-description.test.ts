/** @vitest-environment happy-dom */
import { describe, expect, it } from "vitest";
import { bookDescriptionText } from "./book-description";

describe("book description text", () => {
  it("turns provider HTML into readable paragraphs without exposing markup", () => {
    const value = "<div><p>Every relationship has one beginning.</p><p>This one has <strong>two endings</strong>.<br>Andy loves Jen.</p></div>";
    expect(bookDescriptionText(value)).toBe(
      "Every relationship has one beginning.\n\nThis one has two endings.\nAndy loves Jen.",
    );
  });

  it("drops executable and styling content", () => {
    expect(bookDescriptionText("<p>A description.</p><script>alert('no')</script><style>body{display:none}</style>"))
      .toBe("A description.");
  });

  it("handles provider links and encoded entities without leaking their syntax", () => {
    expect(bookDescriptionText("Read <a href='https://example.test'>more</a> about books &amp; memory."))
      .toBe("Read more about books & memory.");
  });

  it("does not reinterpret ordinary plain text", () => {
    const value = "A story about 2 < 3 choices & an unfinished thought.";
    expect(bookDescriptionText(value)).toBe(value);
  });
});
