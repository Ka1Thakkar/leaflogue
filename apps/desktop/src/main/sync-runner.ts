import {
  MAX_SYNC_CHANGE_PAGE,
  type SyncProblem,
  type SyncProblemKind,
  type SyncExchangeRunResult,
  type SyncRunCounts,
} from "@leaflogue/contracts";
import {
  deliverPendingSyncChanges,
  pullSyncChanges,
  type SyncBootstrapLedger,
  type SyncBootstrapSource,
  type SyncChangeSource,
  type SyncIncomingLedger,
  type SyncOutboxLedger,
  type SyncTransport,
} from "@leaflogue/remote";

/**
 * Main-process sync coordinator. It runs beside the local database, reads the
 * outbox there, and hands only resolved reading data to an injected transport;
 * the renderer sees none of it. Nothing starts it yet: there is no IPC, no
 * timer, and no renderer control. A library without a trusted cursor is
 * bootstrapped when the transport can supply one, and a cursor the provider
 * rejects is rebuilt the same way, at most once per pass.
 */

export interface SyncRunner {
  /** Run one push-then-pull pass; a call during a pass joins it rather than starting another. */
  run(): Promise<SyncExchangeRunResult>;
  /** Cancel between provider calls and wait for the pass to settle; later runs are refused. */
  shutdown(): Promise<void>;
}

const DEFAULT_MAX_BATCHES = 10;

export function createSyncRunner(options: {
  readonly ledger: SyncOutboxLedger & SyncIncomingLedger & Partial<SyncBootstrapLedger>;
  readonly transport: SyncTransport & SyncChangeSource & Partial<SyncBootstrapSource>;
  readonly batchSize?: number;
  readonly maxBatches?: number;
  readonly onProblem?: (problem: SyncProblem) => void;
}): SyncRunner {
  const batchSize = options.batchSize ?? MAX_SYNC_CHANGE_PAGE;
  const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_SYNC_CHANGE_PAGE ||
      !Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 1_000) {
    throw new Error("Sync runner bounds are invalid");
  }
  const controller = new AbortController();
  let inFlight: Promise<SyncExchangeRunResult> | undefined;

  const pass = async (): Promise<SyncExchangeRunResult> => {
    const { signal } = controller;
    let counts: SyncRunCounts = { bootstrapped: 0, pushed: 0, superseded: 0, pulled: 0 };
    let phase: SyncProblem["phase"] = "push";
    let rebuilt = false;
    // An unbootstrapped library would push passages whose books the provider
    // never received, so neither direction runs until a snapshot exists.
    const bootstrap = async (): Promise<boolean> => {
      const { ledger, transport } = options;
      if (!ledger.bootstrapSync || !transport.bootstrapCursor) return false;
      const cursor = await transport.bootstrapCursor(signal);
      if (signal.aborted) return false;
      counts = { ...counts, bootstrapped: counts.bootstrapped + ledger.bootstrapSync(cursor).enqueued };
      return true;
    };
    const exchange = async (): Promise<SyncExchangeRunResult> => {
      phase = "push";
      for (let batch = 0; ; batch += 1) {
        if (signal.aborted) return { ...counts, status: "cancelled" };
        if (batch === maxBatches) return { ...counts, status: "incomplete" };
        const record = ({ delivered, superseded }: { readonly delivered: number; readonly superseded: number }) => {
          counts = { ...counts, pushed: counts.pushed + delivered, superseded: counts.superseded + superseded };
        };
        // A failed delivery still reports its acknowledged prefix, so the count
        // never claims that nothing was sent when part of it was.
        const delivery = await deliverPendingSyncChanges(options.ledger, options.transport, batchSize, signal, record);
        record(delivery);
        if (!delivery.hasMore) break;
        if (delivery.delivered + delivery.superseded === 0) {
          return { ...counts, status: signal.aborted ? "cancelled" : "incomplete" };
        }
      }
      phase = "pull";
      for (let batch = 0; ; batch += 1) {
        if (signal.aborted) return { ...counts, status: "cancelled" };
        if (batch === maxBatches) return { ...counts, status: "incomplete" };
        const pull = await pullSyncChanges(options.ledger, options.transport, batchSize, signal);
        if (pull.status === "snapshot-required") {
          // The provider no longer recognises this cursor: it was restored or
          // replaced. Rebuild once, then push what it is missing and pull again.
          if (rebuilt || !options.ledger.requireSyncSnapshot) return { ...counts, status: "snapshot-required" };
          rebuilt = true;
          options.ledger.requireSyncSnapshot();
          if (!(await bootstrap())) return { ...counts, status: signal.aborted ? "cancelled" : "snapshot-required" };
          return exchange();
        }
        counts = { ...counts, pulled: counts.pulled + pull.applied + pull.superseded };
        if (pull.status === "unsupported-change") return { ...counts, status: "unsupported-change", entityType: pull.entityType };
        if (pull.isDone) return { ...counts, status: signal.aborted ? "cancelled" : "complete" };
      }
    };
    try {
      let state = options.ledger.getSyncState();
      if (!state.snapshotRequired && state.remoteCursor && options.transport.validateCursor &&
          !(await options.transport.validateCursor(state.remoteCursor, signal))) {
        if (!options.ledger.requireSyncSnapshot) return { ...counts, status: "snapshot-required" };
        options.ledger.requireSyncSnapshot();
        state = options.ledger.getSyncState();
      }
      if ((state.snapshotRequired || !state.remoteCursor) && !(await bootstrap())) {
        return { ...counts, status: signal.aborted ? "cancelled" : "snapshot-required" };
      }
      return await exchange();
    } catch (error) {
      if (signal.aborted) return { ...counts, status: "cancelled" };
      const problem = describeSyncProblem(phase, error);
      try {
        options.onProblem?.(problem);
      } catch {
        // A failing observer must not turn a reported problem into an unhandled one.
      }
      return { ...counts, status: "failed", problem };
    }
  };

  return {
    run() {
      if (controller.signal.aborted) return Promise.resolve({ bootstrapped: 0, pushed: 0, superseded: 0, pulled: 0, status: "cancelled" });
      inFlight ??= pass().finally(() => { inFlight = undefined; });
      return inFlight;
    },
    async shutdown() {
      const pending = inFlight;
      controller.abort();
      if (pending) await options.transport.cancel?.().catch(() => undefined);
      await pending;
    },
  };
}

/**
 * Run passes back to back while each stops at the batch bound having moved
 * something, so a large first sync finishes in one go instead of needing
 * the reader to start it again dozens of times. A pass that makes no
 * progress, fails, or completes ends it; `maxRuns` bounds the whole.
 */
export async function runUntilSettled(runner: Pick<SyncRunner, "run">, maxRuns = 500): Promise<SyncExchangeRunResult> {
  let total: SyncRunCounts = { bootstrapped: 0, pushed: 0, superseded: 0, pulled: 0 };
  for (let run = 1; ; run += 1) {
    const result = await runner.run();
    total = {
      bootstrapped: total.bootstrapped + result.bootstrapped,
      pushed: total.pushed + result.pushed,
      superseded: total.superseded + result.superseded,
      pulled: total.pulled + result.pulled,
    };
    const moved = result.bootstrapped + result.pushed + result.superseded + result.pulled > 0;
    if (result.status !== "incomplete" || !moved || run >= maxRuns) return { ...result, ...total };
  }
}

const PROBLEM_MESSAGES: Readonly<Record<SyncProblemKind, string>> = {
  configuration: "Configure a sync provider, and a sync key for Convex, before synchronizing.",
  schema: "Initialize the Leaflogue schema before synchronizing.",
  library: "Leaflogue could not select a remote library for synchronization.",
  credentials: "The sync provider rejected the configured credentials.",
  permission: "The configured sync role lacks permission for this library.",
  unreachable: "Leaflogue could not reach the sync provider.",
  busy: "The sync provider was busy. Unsent changes remain queued.",
  stopped: "Synchronization stopped before finishing. Unsent changes remain queued.",
};

/**
 * Classify by error code only. Driver and provider messages can quote the
 * connection string, a statement, or row values, so none of their text is kept.
 */
export function describeSyncProblem(phase: SyncProblem["phase"], error: unknown): SyncProblem {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "";
  let kind: SyncProblemKind = "stopped";
  if (["42P01", "LEAFLOGUE_SCHEMA_REQUIRED", "LEAFLOGUE_SCHEMA_NEWER"].includes(code)) kind = "schema";
  else if (code === "LEAFLOGUE_LIBRARY_SELECTION_REQUIRED") kind = "library";
  else if (code === "LEAFLOGUE_MIGRATION_REQUIRED") kind = "schema";
  else if (code === "LEAFLOGUE_CONVEX_UPGRADE_REQUIRED") {
    return { phase, kind: "schema", message: "Update the Convex deployment to this Leaflogue release to sync threads, passages, reading history, and daily picks. Earlier changes were sent; the rest wait on this device, and nothing is lost." };
  }
  else if (code === "LEAFLOGUE_CONVEX_VERSION_UNSUPPORTED") {
    return { phase, kind: "schema", message: "The Convex backend version is unsupported. Check connection in Settings for upgrade steps." };
  }
  else if (code === "LEAFLOGUE_SYNC_KEY_UNCONFIGURED") kind = "configuration";
  else if (code === "LEAFLOGUE_SYNC_KEY_INVALID") kind = "credentials";
  else if (["28P01", "28000", "LEAFLOGUE_AUTH_REQUIRED", "LEAFLOGUE_SESSION_INACTIVE"].includes(code)) kind = "credentials";
  else if (code === "42501" || code === "LEAFLOGUE_ACCESS_DENIED") kind = "permission";
  else if (code.startsWith("08") || ["57P01", "57P03", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT",
    "EHOSTUNREACH", "ENETUNREACH", "EPIPE"].includes(code)) kind = "unreachable";
  else if (["40001", "40P01", "55P03", "57014"].includes(code)) kind = "busy";
  return { phase, kind, message: PROBLEM_MESSAGES[kind] };
}
