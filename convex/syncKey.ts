import { accessFailure } from "./accessControl";

declare const process: { readonly env: Readonly<Record<string, string | undefined>> };

/** 32 characters is the floor; `openssl rand -base64 32` produces 44. */
const MIN_SYNC_KEY_LENGTH = 32;
const MAX_SYNC_KEY_LENGTH = 512;

/**
 * Desktop sync is authorized by one operator-chosen secret, set with
 * `npx convex env set LEAFLOGUE_SYNC_KEY …`. A deployment without it refuses
 * every sync call. Digests are compared in constant time so response timing
 * reveals nothing about the key. The key authorizes reading-data sync only:
 * deploying code, changing environment variables, and arbitrary function calls
 * stay with the Convex CLI's own credentials. The key can invoke only the
 * fixed, bounded compatibility migrations exposed by syncRuntime.
 */
export async function requireSyncKey(presented: string): Promise<void> {
  const configured = process.env.LEAFLOGUE_SYNC_KEY?.trim();
  if (!configured || configured.length < MIN_SYNC_KEY_LENGTH || configured.length > MAX_SYNC_KEY_LENGTH) {
    throw accessFailure("LEAFLOGUE_SYNC_KEY_UNCONFIGURED", "Set LEAFLOGUE_SYNC_KEY on this deployment before syncing");
  }
  if (typeof presented !== "string" || presented.length > MAX_SYNC_KEY_LENGTH) {
    throw accessFailure("LEAFLOGUE_SYNC_KEY_INVALID", "The sync key is not valid for this deployment");
  }
  const [expected, actual] = await Promise.all([digest(configured), digest(presented.trim())]);
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= expected[index]! ^ actual[index]!;
  if (difference !== 0) throw accessFailure("LEAFLOGUE_SYNC_KEY_INVALID", "The sync key is not valid for this deployment");
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}
