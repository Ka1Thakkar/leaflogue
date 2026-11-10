import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "@leaflogue/contracts";
import { AUTOMATIC_CHECK_INTERVAL_MS, FIRST_AUTOMATIC_CHECK_MS, scheduleAutomaticUpdateChecks } from "./update-scheduler";

const timers = {
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  setInterval: (callback: () => void, ms: number) => setInterval(callback, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout),
  clearInterval: (handle: unknown) => clearInterval(handle as NodeJS.Timeout),
};
const available = (version: string): UpdateStatus => ({ state: "available", currentVersion: "0.1.0", version, releasedAt: "2026-10-01T00:00:00.000Z", notesUrl: "https://github.com/x" });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("automatic update checks", () => {
  it("never check while turned off", async () => {
    const check = vi.fn(async () => available("0.2.0"));
    const stop = scheduleAutomaticUpdateChecks({ enabled: () => false, check, onAvailable: vi.fn(), timers });
    await vi.advanceTimersByTimeAsync(FIRST_AUTOMATIC_CHECK_MS + 3 * AUTOMATIC_CHECK_INTERVAL_MS);
    expect(check).not.toHaveBeenCalled();
    stop();
  });

  it("check after launch and daily, announcing each new version once", async () => {
    const results = [available("0.2.0"), available("0.2.0"), available("0.3.0")];
    const check = vi.fn(async () => results.shift() ?? ({ state: "up-to-date", currentVersion: "0.1.0" } as UpdateStatus));
    const onAvailable = vi.fn();
    const stop = scheduleAutomaticUpdateChecks({ enabled: () => true, check, onAvailable, timers });
    await vi.advanceTimersByTimeAsync(FIRST_AUTOMATIC_CHECK_MS - 1);
    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onAvailable).toHaveBeenLastCalledWith("0.2.0");
    await vi.advanceTimersByTimeAsync(2 * AUTOMATIC_CHECK_INTERVAL_MS);
    expect(check).toHaveBeenCalledTimes(3);
    expect(onAvailable.mock.calls).toEqual([["0.2.0"], ["0.3.0"]]);
    stop();
    await vi.advanceTimersByTimeAsync(AUTOMATIC_CHECK_INTERVAL_MS);
    expect(check).toHaveBeenCalledTimes(3);
  });

  it("stay quiet when a check fails", async () => {
    const onAvailable = vi.fn();
    const stop = scheduleAutomaticUpdateChecks({ enabled: () => true, check: vi.fn(async () => { throw new Error("offline"); }), onAvailable, timers });
    await vi.advanceTimersByTimeAsync(FIRST_AUTOMATIC_CHECK_MS);
    expect(onAvailable).not.toHaveBeenCalled();
    stop();
  });
});
