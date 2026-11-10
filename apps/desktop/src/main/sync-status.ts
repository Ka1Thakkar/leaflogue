import type { SyncRunOptions, SyncRunResult, SyncStatus } from "@leaflogue/contracts";

export interface SyncStatusTracker {
  current(): SyncStatus;
  /** Run a sync, or join the one already running, and publish each change of state. */
  run(options?: SyncRunOptions): Promise<SyncRunResult>;
  /** Re-read whether sync is set up, after the reader changes the provider. */
  configurationChanged(): void;
}

/**
 * The one place a sync starts, whether at launch, from the header, or from
 * Settings, so every view shows the same state.
 */
export function createSyncStatusTracker(options: {
  readonly run: (options?: SyncRunOptions) => Promise<SyncRunResult>;
  readonly isConfigured: () => boolean;
  readonly publish: (status: SyncStatus) => void;
  readonly now?: () => number;
}): SyncStatusTracker {
  const now = options.now ?? Date.now;
  let status: SyncStatus = { state: options.isConfigured() ? "idle" : "off" };
  let inFlight: Promise<SyncRunResult> | undefined;

  const set = (next: SyncStatus) => {
    status = next;
    options.publish(status);
  };
  const state = (): SyncStatus["state"] => options.isConfigured() ? "idle" : "off";

  return {
    current: () => status,
    run(runOptions) {
      if (inFlight) return inFlight;
      set({ ...status, state: "syncing" });
      inFlight = (async () => {
        try {
          const result = await options.run(runOptions);
          set({ state: state(), lastFinishedAt: now(), lastResult: result });
          return result;
        } catch (error) {
          set({ state: state(), lastFinishedAt: now(), lastError: error instanceof Error ? error.message : "Leaflogue could not start synchronization." });
          throw error;
        } finally {
          inFlight = undefined;
        }
      })();
      return inFlight;
    },
    configurationChanged() {
      if (inFlight) return;
      // A new provider starts with a clean slate; the old result described another place.
      set({ state: state() });
    },
  };
}
