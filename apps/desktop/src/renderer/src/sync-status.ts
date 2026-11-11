import { useEffect, useState } from "react";
import type { SyncProgress, SyncRunResult, SyncStatus } from "@leaflogue/contracts";

/** The background sync's state, as the main process last reported it. */
export function useSyncStatus(): SyncStatus | undefined {
  const [status, setStatus] = useState<SyncStatus>();
  useEffect(() => {
    let live = true;
    const stop = window.leaflogue.sync.onStatus((next) => { if (live) setStatus(next); });
    // A change that arrives first is newer than this answer.
    window.leaflogue.sync.status().then((next) => { if (live) setStatus((current) => current ?? next); }, () => undefined);
    return () => { live = false; stop(); };
  }, []);
  return status;
}

export type SyncTone = "ready" | "syncing" | "synced" | "attention" | "failed";

export function describeSyncProgress(progress: SyncProgress): { readonly phase: string; readonly counts: string } {
  const phases = { connect: "Connecting…", prepare: "Preparing library…", push: "Sending changes…", pull: "Receiving changes…" };
  const remaining = progress.remaining === undefined ? "" : ` · ${progress.remaining.toLocaleString()} queued`;
  return { phase: phases[progress.phase], counts: `${progress.pushed.toLocaleString()} sent · ${progress.pulled.toLocaleString()} received${progress.superseded ? ` · ${progress.superseded.toLocaleString()} already current` : ""}${remaining}` };
}

/** A few words for the header, and the full story for its tooltip. */
export function describeSyncStatus(status: SyncStatus): { readonly label: string; readonly tone: SyncTone; readonly detail: string } {
  if (status.state === "syncing") {
    const progress = status.progress ? describeSyncProgress(status.progress) : undefined;
    return { label: "Syncing…", tone: "syncing", detail: progress ? `${progress.phase} ${progress.counts}` : "Sending and receiving changes." };
  }
  if (status.lastError) return { label: "Sync failed", tone: "failed", detail: status.lastError };
  const result = status.lastResult;
  if (!result) return { label: "Ready to sync", tone: "ready", detail: "Not synced since Leaflogue opened." };
  const detail = describeSyncResult(result);
  if (result.status === "complete") {
    const at = status.lastFinishedAt === undefined ? "" : ` at ${new Date(status.lastFinishedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    return { label: "Synced", tone: "synced", detail: `Last synced${at}. ${detail}` };
  }
  if (result.status === "incomplete" || result.status === "migration-incomplete") return { label: "Sync paused", tone: "attention", detail };
  if (result.status === "migration-review-required") return { label: "Sync needs review", tone: "attention", detail: `${detail} Open Settings to continue.` };
  if (result.status === "cancelled") return { label: "Sync cancelled", tone: "attention", detail };
  return { label: "Sync failed", tone: "failed", detail };
}

export function describeSyncResult(result: SyncRunResult): string {
  if (result.status === "failed") return result.problem.message;
  if (result.status === "migration-incomplete") return `Remote setup updated ${result.migration.updated} legacy records and paused at its safety limit. Choose Sync now again to continue.`;
  if (result.status === "migration-review-required") return "Sync paused before changing a legacy attached note. Review and confirm the prompt to preserve it as a standalone note.";
  if (result.status === "complete") {
    const migration = result.migration && (result.migration.updated > 0 || result.migration.detached > 0)
      ? ` Remote setup updated ${result.migration.updated} legacy records${result.migration.detached > 0 ? ` and preserved ${result.migration.detached} as standalone notes` : ""}.`
      : "";
    return `Sync complete. ${result.pushed} sent, ${result.pulled} received, ${result.superseded} already current.${migration}`;
  }
  if (result.status === "incomplete") return "Sync paused at its safety limit. Run it again to continue.";
  if (result.status === "unsupported-change") return "Sync stopped before data this version cannot apply. Update Leaflogue and try again.";
  if (result.status === "snapshot-required") return "The remote history changed and could not be rebuilt safely.";
  return "Sync was cancelled. Unsent changes remain queued.";
}
