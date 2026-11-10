import type { TrustedUpdateKey } from "./update-manifest";

/**
 * Public keys this build trusts to sign update manifests (ADR 0007). The
 * matching private key lives only in the protected GitHub release
 * environment. With no stable key, the app reports that this build cannot
 * update itself rather than trusting anything unsigned.
 *
 * To add a key, paste the output of
 * `openssl pkey -in leaflogue-update-stable.pem -pubout` below. Keep the old
 * key alongside a new one for at least one release when rotating.
 */
export const TRUSTED_UPDATE_KEYS: readonly TrustedUpdateKey[] = [
  {
    // Stable key created 2026-11-09.
    channel: "stable",
    // One string: the release signing script reads this PEM straight from the source.
    publicKeyPem: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAPy7QlwEM+DR34G9pgM3+S4XNgmoEpJFO/WAm/K1SlYc=\n-----END PUBLIC KEY-----\n",
  },
];
