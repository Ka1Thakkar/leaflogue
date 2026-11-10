import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";

/**
 * Signed update metadata (ADR 0007). Each release publishes, per channel and
 * architecture, a small JSON manifest and a detached Ed25519 signature over
 * its exact bytes. The app trusts a manifest only when a key compiled into it
 * signed those bytes, and only then reads the version and the AppImage's
 * SHA-512 from it. Download URLs are never taken from the manifest: the app
 * builds them from the version, so a manifest cannot point anywhere else.
 */

export type UpdateChannel = "stable";
export type UpdateArchitecture = "x64" | "arm64";

export interface UpdateManifest {
  readonly format: 1;
  readonly product: "leaflogue";
  readonly channel: UpdateChannel;
  readonly version: string;
  readonly architecture: UpdateArchitecture;
  readonly releasedAt: string;
  readonly appImage: {
    readonly name: string;
    readonly size: number;
    readonly sha512: string;
  };
}

export interface UpdateSignature {
  readonly format: 1;
  readonly keyId: string;
  readonly signature: string;
}

/** A public key the app trusts, as an Ed25519 SPKI PEM. */
export interface TrustedUpdateKey {
  readonly channel: UpdateChannel;
  readonly publicKeyPem: string;
}

export class UpdateVerificationError extends Error {
  constructor(message: string, readonly code: "signature" | "format" | "channel" | "architecture" | "version") {
    super(message);
    this.name = "UpdateVerificationError";
  }
}

export const MAX_UPDATE_MANIFEST_BYTES = 4 * 1024;
export const MAX_UPDATE_SIGNATURE_BYTES = 1024;
/** Generous for an Electron AppImage, small enough to refuse a runaway download. */
export const MAX_APPIMAGE_BYTES = 512 * 1024 * 1024;

const VERSION_PATTERN = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(?:-([0-9A-Za-z.-]{1,40}))?$/;
const SHA512_BASE64 = /^[A-Za-z0-9+/]{86}==$/;
const KEY_ID = /^[0-9a-f]{16}$/;

/** First 16 hex characters of the SHA-256 of the key's DER encoding. */
export function updateKeyId(publicKey: KeyObject): string {
  return createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex").slice(0, 16);
}

function parseJson(bytes: Uint8Array, limit: number, label: string): unknown {
  if (bytes.byteLength === 0 || bytes.byteLength > limit) {
    throw new UpdateVerificationError(`${label} size is invalid`, "format");
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new UpdateVerificationError(`${label} is not valid JSON`, "format");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new UpdateVerificationError(`${label} has unexpected fields`, "format");
  }
}

export function parseUpdateSignature(bytes: Uint8Array): UpdateSignature {
  const value = parseJson(bytes, MAX_UPDATE_SIGNATURE_BYTES, "Update signature");
  if (!isRecord(value)) throw new UpdateVerificationError("Update signature is invalid", "format");
  exactKeys(value, ["format", "keyId", "signature"], "Update signature");
  if (value.format !== 1 || typeof value.keyId !== "string" || !KEY_ID.test(value.keyId) ||
      typeof value.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(value.signature)) {
    throw new UpdateVerificationError("Update signature is invalid", "format");
  }
  return { format: 1, keyId: value.keyId, signature: value.signature };
}

function parseManifest(bytes: Uint8Array): UpdateManifest {
  const value = parseJson(bytes, MAX_UPDATE_MANIFEST_BYTES, "Update manifest");
  if (!isRecord(value)) throw new UpdateVerificationError("Update manifest is invalid", "format");
  exactKeys(value, ["format", "product", "channel", "version", "architecture", "releasedAt", "appImage"], "Update manifest");
  const { appImage } = value;
  if (value.format !== 1 || value.product !== "leaflogue" || value.channel !== "stable" ||
      typeof value.version !== "string" || !VERSION_PATTERN.test(value.version) ||
      (value.architecture !== "x64" && value.architecture !== "arm64") ||
      typeof value.releasedAt !== "string" || Number.isNaN(Date.parse(value.releasedAt)) || !isRecord(appImage)) {
    throw new UpdateVerificationError("Update manifest is invalid", "format");
  }
  exactKeys(appImage, ["name", "size", "sha512"], "Update manifest AppImage");
  if (appImage.name !== expectedAppImageName(value.version, value.architecture) ||
      typeof appImage.size !== "number" || !Number.isSafeInteger(appImage.size) || appImage.size <= 0 || appImage.size > MAX_APPIMAGE_BYTES ||
      typeof appImage.sha512 !== "string" || !SHA512_BASE64.test(appImage.sha512)) {
    throw new UpdateVerificationError("Update manifest AppImage is invalid", "format");
  }
  return {
    format: 1,
    product: "leaflogue",
    channel: "stable",
    version: value.version,
    architecture: value.architecture,
    releasedAt: value.releasedAt,
    appImage: { name: appImage.name, size: appImage.size, sha512: appImage.sha512 },
  };
}

/** The AppImage name electron-builder produces for a version and architecture. */
export function expectedAppImageName(version: string, architecture: UpdateArchitecture): string {
  return `Leaflogue-${version}-${architecture === "x64" ? "x86_64" : "arm64"}.AppImage`;
}

/** Release asset names for a channel's manifest and signature. */
export function updateManifestAssetNames(channel: UpdateChannel, architecture: UpdateArchitecture) {
  const manifest = `leaflogue-update-${channel}-${architecture}.json`;
  return { manifest, signature: `${manifest}.sig` };
}

/** Compare release versions; a pre-release sorts before its release. */
export function compareVersions(left: string, right: string): number {
  const parse = (version: string) => {
    const match = VERSION_PATTERN.exec(version);
    if (!match) throw new UpdateVerificationError(`Invalid version ${version}`, "version");
    return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index]! < b.core[index]! ? -1 : 1;
  }
  if (a.pre === b.pre) return 0;
  if (a.pre === undefined) return 1;
  if (b.pre === undefined) return -1;
  const leftParts = a.pre.split(".");
  const rightParts = b.pre.split(".");
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const x = leftParts[index];
    const y = rightParts[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumber = /^\d+$/.test(x) ? Number(x) : undefined;
    const yNumber = /^\d+$/.test(y) ? Number(y) : undefined;
    if (xNumber !== undefined && yNumber !== undefined) return xNumber < yNumber ? -1 : 1;
    if (xNumber !== undefined) return -1;
    if (yNumber !== undefined) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export interface VerifiedUpdate {
  readonly manifest: UpdateManifest;
  /** True when the manifest's version is newer than the running app. */
  readonly newer: boolean;
}

/**
 * Verify a downloaded manifest and signature. The signature is checked over
 * the exact manifest bytes before any field is trusted; then the manifest must
 * name the expected channel and architecture. A manifest that is not newer is
 * still returned (as up to date), but one older than the running app is a
 * rollback attempt and is refused.
 */
export function verifyUpdateManifest(input: {
  readonly manifestBytes: Uint8Array;
  readonly signatureBytes: Uint8Array;
  readonly trustedKeys: readonly TrustedUpdateKey[];
  readonly channel: UpdateChannel;
  readonly architecture: UpdateArchitecture;
  readonly currentVersion: string;
}): VerifiedUpdate {
  const signature = parseUpdateSignature(input.signatureBytes);
  const key = input.trustedKeys
    .filter(({ channel }) => channel === input.channel)
    .map(({ publicKeyPem }) => createPublicKey(publicKeyPem))
    .find((candidate) => candidate.asymmetricKeyType === "ed25519" && updateKeyId(candidate) === signature.keyId);
  if (!key || !verify(null, input.manifestBytes, key, Buffer.from(signature.signature, "base64"))) {
    throw new UpdateVerificationError("The update is not signed by a key this version of Leaflogue trusts", "signature");
  }
  const manifest = parseManifest(input.manifestBytes);
  if (manifest.channel !== input.channel) {
    throw new UpdateVerificationError("The update is for a different channel", "channel");
  }
  if (manifest.architecture !== input.architecture) {
    throw new UpdateVerificationError("The update is for a different architecture", "architecture");
  }
  if (manifest.channel === "stable" && manifest.version.includes("-")) {
    throw new UpdateVerificationError("The stable channel offered a pre-release", "version");
  }
  const order = compareVersions(manifest.version, input.currentVersion);
  if (order < 0) {
    throw new UpdateVerificationError("The update offered an older version than the one installed", "version");
  }
  return { manifest, newer: order > 0 };
}
