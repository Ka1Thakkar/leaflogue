/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatePicker } from "./DatePicker";

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function render(value: string | undefined, onChange: (value: string | undefined) => void) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<DatePicker label="Filter date" value={value} onChange={onChange} />));
}

const click = (element: Element | null | undefined) => act(async () => { (element as HTMLElement).click(); });
const day = (date: string) => document.querySelector<HTMLButtonElement>(`[data-date="${date}"]`);

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
});

describe("DatePicker", () => {
  it("opens on the chosen month, picks a day and closes", async () => {
    const onChange = vi.fn();
    await render("2026-03-10", onChange);
    expect(container!.textContent).toContain("Mar");
    await click(container!.querySelector("button[aria-haspopup]"));
    expect(day("2026-03-10")?.getAttribute("aria-pressed")).toBe("true");
    await click(day("2026-03-15"));
    expect(onChange).toHaveBeenCalledWith("2026-03-15");
    expect(document.querySelector("[role='dialog']")).toBeNull();
  });

  it("moves between months and clears the date", async () => {
    const onChange = vi.fn();
    await render("2026-03-10", onChange);
    await click(container!.querySelector("button[aria-haspopup]"));
    await click(document.querySelector("button[aria-label='Next month']"));
    await click(day("2026-04-02"));
    expect(onChange).toHaveBeenLastCalledWith("2026-04-02");

    await click(container!.querySelector("button[aria-haspopup]"));
    await click(Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Clear"));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it("steps through days with the arrow keys and closes on Escape", async () => {
    await render("2026-03-10", vi.fn());
    await click(container!.querySelector("button[aria-haspopup]"));
    const panel = document.querySelector("[role='dialog']")!;
    await act(async () => { panel.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
    expect(day("2026-03-11")?.tabIndex).toBe(0);
    await act(async () => { panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(document.querySelector("[role='dialog']")).toBeNull();
  });
});
