import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { readBoundedConvexResponse, validateConvexDeploymentUrl } from "./convex-http";

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const SUPPORTED_SCHEMA_VERSION = 17;
const MIN_SUPPORTED_MUTATION_CONTRACT_VERSION = 22;
const MAX_SUPPORTED_MUTATION_CONTRACT_VERSION = 23;
/** The first contract that replays threads and passage thread membership. */
export const CONVEX_THREAD_CONTRACT_VERSION = 23;

interface ConvexDeploymentMetadata {
  readonly product: "leaflogue";
  readonly schemaVersion: number;
  readonly mutationContractVersion: number;
}

export interface ConvexConnectionStatus {
  readonly reachable: boolean;
  readonly initialized: boolean;
  readonly schemaVersion?: number;
  readonly mutationContractVersion?: number;
  readonly problem?: string;
}

const deploymentStatus = makeFunctionReference<"query", Record<string, never>, ConvexDeploymentMetadata>("setup:status");

export async function checkConvex(
  deploymentUrl: string,
  options: {
    readonly fetch?: typeof globalThis.fetch;
    readonly timeoutMs?: number;
    readonly releaseVersion?: string;
    readonly signal?: AbortSignal;
  } = {},
): Promise<ConvexConnectionStatus> {
  const url = validateConvexDeploymentUrl(deploymentUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error("Convex timeout is invalid");
  }
  const request = options.fetch ?? globalThis.fetch;
  let deploymentResponded = false;
  const client = new ConvexHttpClient(url, {
    skipConvexDeploymentUrlCheck: true,
    logger: false,
    fetch: async (input, init) => {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      const response = await request(input, { ...init, redirect: "error", signal });
      deploymentResponded = true;
      return readBoundedConvexResponse(response, new URL(url).origin, MAX_RESPONSE_BYTES);
    },
  });
  let result: unknown;
  try {
    result = await client.query(deploymentStatus, {});
  } catch {
    return {
      reachable: deploymentResponded,
      initialized: false,
      problem: deploymentResponded
        ? "The Convex deployment responded, but its Leaflogue status function is unavailable."
        : "Leaflogue could not reach the Convex deployment.",
    };
  }
  if (!isDeploymentMetadata(result)) {
    return {
      reachable: true,
      initialized: false,
      problem: "The deployment responded, but its Leaflogue schema metadata is invalid.",
    };
  }
  if (result.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    return {
      reachable: true,
      initialized: false,
      problem: `This desktop supports Convex schema ${SUPPORTED_SCHEMA_VERSION}; the deployment reports schema ${result.schemaVersion}.${upgradeInstruction(options.releaseVersion)}`,
    };
  }
  if (result.mutationContractVersion < MIN_SUPPORTED_MUTATION_CONTRACT_VERSION ||
      result.mutationContractVersion > MAX_SUPPORTED_MUTATION_CONTRACT_VERSION) {
    return {
      reachable: true,
      initialized: false,
      problem: `This desktop supports Convex mutation contracts ${MIN_SUPPORTED_MUTATION_CONTRACT_VERSION}–${MAX_SUPPORTED_MUTATION_CONTRACT_VERSION}; the deployment reports contract ${result.mutationContractVersion}.${upgradeInstruction(options.releaseVersion)}`,
    };
  }
  return { reachable: true, initialized: true, schemaVersion: result.schemaVersion, mutationContractVersion: result.mutationContractVersion };
}

/**
 * Refuse an incompatible deployment before any library provisioning or data
 * exchange, and report the accepted mutation contract so the transport can
 * hold back changes an older adjacent backend cannot express.
 */
export async function assertCompatibleConvexDeployment(
  deploymentUrl: string,
  options: Parameters<typeof checkConvex>[1] = {},
): Promise<{ readonly mutationContractVersion: number }> {
  const status = await checkConvex(deploymentUrl, options);
  if (options.signal?.aborted) {
    throw Object.assign(new Error("Convex compatibility check was cancelled"), { code: "LEAFLOGUE_SYNC_CANCELLED" });
  }
  if (status.initialized && status.mutationContractVersion !== undefined) {
    return { mutationContractVersion: status.mutationContractVersion };
  }
  throw Object.assign(new Error("Convex deployment is not compatible with this desktop"), {
    code: status.reachable ? "LEAFLOGUE_CONVEX_VERSION_UNSUPPORTED" : "ECONNREFUSED",
  });
}

function upgradeInstruction(releaseVersion: string | undefined): string {
  if (!releaseVersion || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u.test(releaseVersion)) {
    return " Deploy the backend bundle that matches this desktop release.";
  }
  return ` Download Leaflogue-Convex-${releaseVersion}.tar.gz from release v${releaseVersion}, verify its checksum, extract it, then run ./leaflogue-convex-${releaseVersion}/deploy.sh.`;
}

function isDeploymentMetadata(value: unknown): value is ConvexDeploymentMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return result.product === "leaflogue" && Number.isSafeInteger(result.schemaVersion) && Number(result.schemaVersion) >= 0 &&
    Number.isSafeInteger(result.mutationContractVersion) && Number(result.mutationContractVersion) >= 0;
}
