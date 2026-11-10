/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { appearanceConfiguration } from "@leaflogue/appearance";
import { activateAppearance, activateStoredAppearance, applyAppearance } from "./appearance";

afterEach(() => {
  document.documentElement.removeAttribute("style");
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.appearance;
  vi.restoreAllMocks();
});

/** A media query whose listeners really are added and removed, so a stale one
 *  repaints the page in the test exactly as it would in the window. */
function stubSystemTheme(dark: boolean): (dark: boolean) => void {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  let matches = dark;
  vi.spyOn(window, "matchMedia").mockReturnValue({
    get matches() { return matches; },
    addEventListener: (_name: string, value: EventListenerOrEventListenerObject) => { listeners.add(value as (event: MediaQueryListEvent) => void); },
    removeEventListener: (_name: string, value: EventListenerOrEventListenerObject) => { listeners.delete(value as (event: MediaQueryListEvent) => void); },
  } as unknown as MediaQueryList);
  return (next: boolean) => {
    matches = next;
    for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent);
  };
}

describe("renderer appearance", () => {
  it("applies a complete requested variant without reloading", () => {
    const configuration = appearanceConfiguration({ themeId: "rose-pine", mode: "dark" });
    expect(applyAppearance(configuration, false)).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("rose-pine");
    expect(document.documentElement.style.getPropertyValue("--paper")).toBe("#191724");
    expect(document.documentElement.style.getPropertyValue("--foreground")).toBe("#e0def4");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("follows system changes only while system mode is active", () => {
    let listener: ((event: MediaQueryListEvent) => void) | undefined;
    const remove = vi.fn();
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: false,
      addEventListener: (_name: string, value: EventListenerOrEventListenerObject) => { listener = value as (event: MediaQueryListEvent) => void; },
      removeEventListener: remove,
    } as unknown as MediaQueryList);
    activateAppearance(appearanceConfiguration({ themeId: "tokyo-night", mode: "system" }));
    expect(document.documentElement.dataset.appearance).toBe("light");
    listener?.({ matches: true } as MediaQueryListEvent);
    expect(document.documentElement.dataset.appearance).toBe("dark");
    activateAppearance(appearanceConfiguration({ themeId: "leaflogue", mode: "light" }));
    expect(remove).toHaveBeenCalledOnce();
  });

  it("stops repainting on system changes once a fixed mode is chosen", () => {
    const changeSystemTheme = stubSystemTheme(false);
    activateAppearance(appearanceConfiguration({ themeId: "tokyo-night", mode: "system" }));
    activateAppearance(appearanceConfiguration({ themeId: "tokyo-night", mode: "light" }));
    changeSystemTheme(true);
    expect(document.documentElement.dataset.appearance).toBe("light");
  });

  it("reopens in the stored theme after a restart", async () => {
    stubSystemTheme(false);
    await activateStoredAppearance(async () => appearanceConfiguration({ themeId: "nord", mode: "dark" }));
    expect(document.documentElement.dataset.theme).toBe("nord");
    expect(document.documentElement.dataset.appearance).toBe("dark");
  });

  it("leaves the stylesheet fallback alone when the stored appearance cannot be read", async () => {
    await activateStoredAppearance(async () => { throw new Error("configuration unreadable"); });
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(document.documentElement.style.getPropertyValue("--paper")).toBe("");
  });
});
