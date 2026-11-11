import { Buffer } from "node:buffer";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createUpdateManifest, signUpdateManifest, trustedKeyIds, updateKeyId, updateManifestAssetNames } from "./update-manifest.mjs";
import { verifyUpdateManifest } from "../src/main/update-manifest.ts";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
const trustedKeys = [{ channel: "stable", publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) }];
const sha512 = Buffer.alloc(64, 7).toString("base64");

function release(version = "0.2.0", architecture = "x64") {
  const manifestBytes = createUpdateManifest({ version, architecture, releasedAt: "2026-10-01T00:00:00.000Z", size: 1234, sha512 });
  return { manifestBytes, signatureBytes: signUpdateManifest(manifestBytes, privateKeyPem) };
}

describe("release update manifests", () => {
  it("are verified by the app exactly as the release workflow writes them", () => {
    const verified = verifyUpdateManifest({ ...release(), trustedKeys, channel: "stable", architecture: "x64", currentVersion: "0.1.0" });
    expect(verified).toMatchObject({ newer: true, manifest: { version: "0.2.0", artifact: { name: "Leaflogue-0.2.0-x86_64.AppImage", size: 1234, sha512 } } });
  });

  it("name one manifest and signature per channel and architecture", () => {
    expect(updateManifestAssetNames("stable", "arm64")).toEqual({
      manifest: "leaflogue-update-stable-arm64.json",
      signature: "leaflogue-update-stable-arm64.json.sig",
    });
  });

  it("refuse to publish a pre-release or another channel to stable", () => {
    expect(() => createUpdateManifest({ version: "0.2.0-beta.1", architecture: "x64", releasedAt: "2026-10-01T00:00:00.000Z", size: 1, sha512 }))
      .toThrow(/pre-release/);
    expect(() => createUpdateManifest({ channel: "dev", version: "0.2.0", architecture: "x64", releasedAt: "2026-10-01T00:00:00.000Z", size: 1, sha512 }))
      .toThrow(/channel/);
  });

  it("read the trusted key IDs from the app's key list", () => {
    const pem = publicKey.export({ type: "spki", format: "pem" }).trim();
    const source = `export const TRUSTED_UPDATE_KEYS = [{ channel: "stable", publicKeyPem: ${JSON.stringify(pem)} }];`;
    expect(trustedKeyIds(source)).toEqual([updateKeyId(publicKey)]);
    expect(trustedKeyIds("export const TRUSTED_UPDATE_KEYS = [];")).toEqual([]);
  });

  it("refuse a signing key that is not Ed25519", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
    expect(() => signUpdateManifest(Buffer.from("{}"), rsa)).toThrow(/Ed25519/);
  });
});

for (const platform of ["linux", "mac", "windows"]) {
  it(`pairs the ${platform} beta publisher with the runtime verifier`, () => {
    const bytes = createUpdateManifest({ channel: "beta", platform, version: "0.1.0-beta.2", architecture: "x64", releasedAt: "2026-11-10T00:00:00Z", size: 1234, sha512 });
    const result = verifyUpdateManifest({ manifestBytes: bytes, signatureBytes: signUpdateManifest(bytes, privateKeyPem), trustedKeys: [{ ...trustedKeys[0], channel: "beta" }], channel: "beta", platform, architecture: "x64", currentVersion: "0.1.0-beta.1" });
    expect(result).toMatchObject({ newer: true, manifest: { platform, channel: "beta", version: "0.1.0-beta.2" } });
  });
}
