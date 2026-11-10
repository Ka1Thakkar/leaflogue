import type { UpdateStatus } from "@leaflogue/contracts";

/**
 * Optional automatic update checks (ADR 0007): once shortly after launch,
 * then daily, and only while the reader has them turned on. A check only
 * looks; installing always waits for the reader. Each newly found version is
 * announced once.
 */

export const FIRST_AUTOMATIC_CHECK_MS = 60_000;
export const AUTOMATIC_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface UpdateSchedulerTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  setInterval(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  clearInterval(handle: unknown): void;
}

export function scheduleAutomaticUpdateChecks(options: {
  readonly enabled: () => boolean;
  readonly check: () => Promise<UpdateStatus>;
  readonly onAvailable: (version: string) => void;
  readonly timers?: UpdateSchedulerTimers;
}): () => void {
  const timers: UpdateSchedulerTimers = options.timers ?? {
    setTimeout: (callback, ms) => setTimeout(callback, ms).unref(),
    setInterval: (callback, ms) => setInterval(callback, ms).unref(),
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
  };
  let announced: string | undefined;
  let running = false;
  const tick = () => {
    if (running || !options.enabled()) return;
    running = true;
    void options.check()
      .then((status) => {
        if (status.state === "available" && status.version !== announced) {
          announced = status.version;
          options.onAvailable(status.version);
        }
      })
      // A failed automatic check stays quiet; the reader can check by hand.
      .catch(() => undefined)
      .finally(() => { running = false; });
  };
  const first = timers.setTimeout(tick, FIRST_AUTOMATIC_CHECK_MS);
  const daily = timers.setInterval(tick, AUTOMATIC_CHECK_INTERVAL_MS);
  return () => {
    timers.clearTimeout(first);
    timers.clearInterval(daily);
  };
}
