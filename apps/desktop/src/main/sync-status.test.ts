import { describe, expect, it, vi } from "vitest";
import type { SyncRunResult, SyncStatus } from "@leaflogue/contracts";
import { createSyncStatusTracker } from "./sync-status";

const complete: SyncRunResult = { status: "complete", bootstrapped: 0, pushed: 1, superseded: 0, pulled: 2 };

describe("sync status", () => {
  it("is off until a provider is set up", () => {
    let configured = false;
    const published: SyncStatus[] = [];
    const tracker = createSyncStatusTracker({ run: vi.fn(), isConfigured: () => configured, publish: (status) => published.push(status) });
    expect(tracker.current()).toEqual({ state: "off" });
    configured = true;
    tracker.configurationChanged();
    expect(published).toEqual([{ state: "idle" }]);
  });

  it("publishes a run from start to finish, and joins a run already going", async () => {
    let finish!: (result: SyncRunResult) => void;
    const run = vi.fn(() => new Promise<SyncRunResult>((resolve) => { finish = resolve; }));
    const published: SyncStatus[] = [];
    const tracker = createSyncStatusTracker({ run, isConfigured: () => true, publish: (status) => published.push(status), now: () => 42 });
    const first = tracker.run();
    const second = tracker.run();
    expect(run).toHaveBeenCalledTimes(1);
    expect(tracker.current().state).toBe("syncing");
    finish(complete);
    await expect(first).resolves.toBe(complete);
    await expect(second).resolves.toBe(complete);
    expect(published).toEqual([{ state: "syncing" }, { state: "idle", lastFinishedAt: 42, lastResult: complete }]);
  });

  it("keeps the message of a run that could not start", async () => {
    const tracker = createSyncStatusTracker({ run: () => Promise.reject(new Error("Wait for the backup")), isConfigured: () => true, publish: () => undefined, now: () => 7 });
    await expect(tracker.run()).rejects.toThrow("Wait for the backup");
    expect(tracker.current()).toEqual({ state: "idle", lastFinishedAt: 7, lastError: "Wait for the backup" });
    tracker.configurationChanged();
    expect(tracker.current()).toEqual({ state: "idle" });
  });
});

it("publishes live progress only during the active sync and clears it on completion", async () => {
  let finish!: (result: SyncRunResult) => void;
  const tracker = createSyncStatusTracker({ run: () => new Promise((resolve) => { finish = resolve; }), isConfigured: () => true, publish: () => undefined });
  const progress = { phase: "pull" as const, bootstrapped: 0, pushed: 4, pulled: 120, superseded: 0, remaining: 0 };
  tracker.progress(progress);
  expect(tracker.current().progress).toBeUndefined();
  const running = tracker.run();
  tracker.progress(progress);
  expect(tracker.current()).toMatchObject({ state: "syncing", progress });
  finish(complete); await running;
  expect(tracker.current().progress).toBeUndefined();
  tracker.progress(progress);
  expect(tracker.current().state).toBe("idle");
  expect(tracker.current().progress).toBeUndefined();
});
