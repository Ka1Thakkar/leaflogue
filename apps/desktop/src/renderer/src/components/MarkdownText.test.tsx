/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { MarkdownText, PlainText } from "./MarkdownText";

async function render(element: React.ReactElement): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return container;
}

describe("PlainText", () => {
  it("shows an indented passage as words, not code", async () => {
    const text = "(Even now, as I write the words,\n\n    I begin to feel anxious again.\n* not a list\nstill the same paragraph";
    const container = await render(<PlainText text={text} />);
    expect(container.querySelector("pre, code, ul, li")).toBeNull();
    const paragraphs = [...container.querySelectorAll("p")];
    expect(paragraphs.map((paragraph) => paragraph.textContent)).toEqual([
      "(Even now, as I write the words,",
      "I begin to feel anxious again.* not a liststill the same paragraph",
    ]);
    expect(paragraphs[1]?.querySelectorAll("br")).toHaveLength(2);
  });

  it("leaves notes as Markdown", async () => {
    const container = await render(<MarkdownText text={"    indented code"} />);
    expect(container.querySelector("pre")).not.toBeNull();
  });
});
