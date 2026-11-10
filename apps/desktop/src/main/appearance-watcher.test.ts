import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppearanceWatcher } from "./appearance-watcher";

afterEach(() => vi.useRealTimers());

describe("appearance file watcher", () => {
  it("debounces targeted config and theme replacements, then follows a new theme path", () => {
    vi.useFakeTimers();
    let themePath = "/config/themes/first.json";
    const listeners = new Map<string, (fileName?: string) => void>();
    const closed: string[] = [];
    const onChange = vi.fn(() => { themePath = "/elsewhere/second.json"; });
    const stop = createAppearanceWatcher({
      configPath: "/config/config.json",
      resolveThemePath: () => themePath,
      onChange,
      watchDirectory: (directory, listener) => {
        listeners.set(directory, listener);
        return { close: () => { closed.push(directory); listeners.delete(directory); } };
      },
    });

    listeners.get("/config")?.("unrelated.json");
    vi.advanceTimersByTime(200);
    expect(onChange).not.toHaveBeenCalled();
    listeners.get("/config/themes")?.("first.json");
    listeners.get("/config/themes")?.("first.json");
    vi.advanceTimersByTime(100);
    expect(onChange).toHaveBeenCalledOnce();
    expect(listeners.has("/elsewhere")).toBe(true);
    expect(closed).toEqual(expect.arrayContaining(["/config", "/config/themes"]));

    stop();
    expect(listeners.size).toBe(0);
  });

  it("keeps watching the config when its theme reference cannot be resolved", () => {
    const listeners = new Map<string, (fileName?: string) => void>();
    const stop = createAppearanceWatcher({
      configPath: "/config/config.json",
      resolveThemePath: () => { throw new Error("invalid config"); },
      onChange: vi.fn(),
      watchDirectory: (directory, listener) => {
        listeners.set(directory, listener);
        return { close: () => listeners.delete(directory) };
      },
    });
    expect([...listeners.keys()]).toEqual(["/config"]);
    stop();
  });

  it("watches an existing ancestor until a missing theme directory is created", () => {
    vi.useFakeTimers();
    const available = new Set(["/config"]);
    const listeners = new Map<string, Array<(fileName?: string) => void>>();
    const onChange = vi.fn(() => available.add("/config/themes"));
    const stop = createAppearanceWatcher({
      configPath: "/config/config.json",
      resolveThemePath: () => "/config/themes/quiet.json",
      onChange,
      watchDirectory: (directory, listener) => {
        if (!available.has(directory)) throw new Error("missing directory");
        const entries = listeners.get(directory) ?? [];
        entries.push(listener);
        listeners.set(directory, entries);
        return { close: () => listeners.set(directory, (listeners.get(directory) ?? []).filter((entry) => entry !== listener)) };
      },
    });

    for (const listener of listeners.get("/config") ?? []) listener("themes");
    vi.advanceTimersByTime(100);
    expect(onChange).toHaveBeenCalledOnce();
    expect(listeners.get("/config/themes")).toHaveLength(1);
    stop();
  });

  it("recovers and rebinds after a runtime watcher error even when reload throws", () => {
    vi.useFakeTimers();
    const registrations: Array<{ closed: boolean; fail: () => void }> = [];
    const onChange = vi.fn(() => { throw new Error("temporary read failure"); });
    const stop = createAppearanceWatcher({
      configPath: "/config/config.json",
      resolveThemePath: () => undefined,
      onChange,
      watchDirectory: (_directory, _listener, onError) => {
        const registration = { closed: false, fail: onError };
        registrations.push(registration);
        return { close: () => { registration.closed = true; } };
      },
    });

    registrations[0]?.fail();
    expect(registrations[0]?.closed).toBe(true);
    vi.advanceTimersByTime(100);
    expect(onChange).toHaveBeenCalledOnce();
    expect(registrations).toHaveLength(2);
    stop();
    expect(registrations[1]?.closed).toBe(true);
  });
  it("reloads on any change in the themes folder, waiting for the folder to exist", () => {
    vi.useFakeTimers();
    const available = new Set(["/config"]);
    const listeners = new Map<string, (fileName?: string) => void>();
    const onChange = vi.fn(() => available.add("/config/themes"));
    const stop = createAppearanceWatcher({
      configPath: "/config/config.json",
      resolveThemePath: () => undefined,
      themesDirectory: "/config/themes",
      onChange,
      watchDirectory: (directory, listener) => {
        if (!available.has(directory)) throw new Error("missing");
        const previous = listeners.get(directory);
        listeners.set(directory, previous ? (name) => { previous(name); listener(name); } : listener);
        return { close: () => listeners.delete(directory) };
      },
    });
    expect(listeners.has("/config/themes")).toBe(false);
    listeners.get("/config")?.("themes");
    vi.advanceTimersByTime(100);
    expect(onChange).toHaveBeenCalledOnce();
    listeners.get("/config/themes")?.("dusk.json");
    vi.advanceTimersByTime(100);
    expect(onChange).toHaveBeenCalledTimes(2);
    stop();
  });
});
