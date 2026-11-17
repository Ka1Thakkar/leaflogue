import { describe, expect, it } from "vitest";
import { describeSyncStatus } from "./sync-status";

describe("backend transition status", () => {
  it("does not claim every feature is synced while colour choices are deferred", () => {
    const status = describeSyncStatus({ state: "idle", lastResult: { status: "complete", bootstrapped: 0, pushed: 5, pulled: 2, superseded: 0,
      backendUpdate: { installedSchema: 17, installedContract: 23, requiredSchema: 17, requiredContract: 24, deferredColours: 3 } } });
    expect(status.label).toBe("Backend update available");
    expect(status.tone).toBe("attention");
    expect(status.detail).toContain("Ordinary library data synced");
    expect(status.detail).toContain("3 highlight colour choices remain saved locally");
  });
  it("directs users to update the desktop rather than downgrade a newer backend", () => {
    const status = describeSyncStatus({ state: "idle", lastResult: { status: "failed", bootstrapped: 0, pushed: 0, pulled: 0, superseded: 0,
      problem: { kind: "schema", phase: "connect", message: "Your desktop app needs an update.",
        backendUpdate: { installedSchema: 17, installedContract: 25, requiredSchema: 17, requiredContract: 24, updateDesktop: true } } } });
    expect(status.label).toBe("App update needed");
  });
});
