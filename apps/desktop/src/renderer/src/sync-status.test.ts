import { describe, expect, it } from "vitest";
import { describeSyncStatus } from "./sync-status";

describe("backend transition status", () => {
  it("requires a backend upgrade before any data is sent", () => {
    const status = describeSyncStatus({ state: "idle", lastResult: { status: "failed", bootstrapped: 0, pushed: 0, pulled: 0, superseded: 0,
      problem: { kind: "schema", phase: "connect", message: "Update the backend.",
        backendUpdate: { installedSchema: 17, installedContract: 23, requiredSchema: 17, requiredContract: 24 } } } });
    expect(status.label).toBe("Backend update needed");
    expect(status.tone).toBe("attention");
  });
  it("directs users to update the desktop rather than downgrade a newer backend", () => {
    const status = describeSyncStatus({ state: "idle", lastResult: { status: "failed", bootstrapped: 0, pushed: 0, pulled: 0, superseded: 0,
      problem: { kind: "schema", phase: "connect", message: "Your desktop app needs an update.",
        backendUpdate: { installedSchema: 17, installedContract: 25, requiredSchema: 17, requiredContract: 24, updateDesktop: true } } } });
    expect(status.label).toBe("App update needed");
  });
});
