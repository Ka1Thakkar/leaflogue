import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compareVersions, updateKeyId, verifyUpdateManifest, type TrustedUpdateKey } from "./update-manifest";

const keys = generateKeyPairSync("ed25519");
const stranger = generateKeyPairSync("ed25519");
const trustedKeys: TrustedUpdateKey[] = [{ channel: "stable", publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString() }];
const sha512 = Buffer.alloc(64, 1).toString("base64");

function manifest(overrides: Record<string, unknown> = {}) {
  const version = (overrides.version as string | undefined) ?? "0.2.0";
  const architecture = (overrides.architecture as string | undefined) ?? "x64";
  return {
    format: 1,
    product: "leaflogue",
    channel: "stable",
    version,
    architecture,
    releasedAt: "2026-10-01T00:00:00.000Z",
    appImage: { name: `Leaflogue-${version}-${architecture === "x64" ? "x86_64" : "arm64"}.AppImage`, size: 100, sha512 },
    ...overrides,
  };
}

function signed(value: unknown, signer = keys) {
  const manifestBytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const signatureBytes = Buffer.from(JSON.stringify({
    format: 1,
    keyId: updateKeyId(signer.publicKey),
    signature: sign(null, manifestBytes, signer.privateKey).toString("base64"),
  }));
  return { manifestBytes, signatureBytes };
}

const verifyAs = (bytes: ReturnType<typeof signed>, currentVersion = "0.1.0", architecture: "x64" | "arm64" = "x64") =>
  verifyUpdateManifest({ ...bytes, trustedKeys, channel: "stable", architecture, currentVersion });

describe("signed update manifests", () => {
  it("accept a newer release signed by a trusted key", () => {
    expect(verifyAs(signed(manifest()))).toMatchObject({ newer: true, manifest: { version: "0.2.0" } });
  });

  it("report the installed version as up to date", () => {
    expect(verifyAs(signed(manifest({ version: "0.1.0" })))).toMatchObject({ newer: false });
  });

  it("refuse a signature from a key the app does not trust", () => {
    expect(() => verifyAs(signed(manifest(), stranger))).toThrow(expect.objectContaining({ code: "signature" }));
  });

  it("refuse a manifest changed after signing", () => {
    const bytes = signed(manifest());
    const tampered = Buffer.from(bytes.manifestBytes.toString().replace("0.2.0", "0.3.0"));
    expect(() => verifyAs({ ...bytes, manifestBytes: tampered })).toThrow(expect.objectContaining({ code: "signature" }));
  });

  it("refuse an older version, a pre-release on stable, and a different architecture", () => {
    expect(() => verifyAs(signed(manifest({ version: "0.0.9" })))).toThrow(expect.objectContaining({ code: "version" }));
    expect(() => verifyAs(signed(manifest({ version: "0.2.0-beta.1" })))).toThrow(expect.objectContaining({ code: "version" }));
    expect(() => verifyAs(signed(manifest()), "0.1.0", "arm64")).toThrow(expect.objectContaining({ code: "architecture" }));
  });

  it("refuse signed manifests with unexpected fields or a mismatched AppImage name", () => {
    expect(() => verifyAs(signed({ ...manifest(), url: "https://elsewhere.example/x" }))).toThrow(expect.objectContaining({ code: "format" }));
    const renamed = manifest();
    expect(() => verifyAs(signed({ ...renamed, appImage: { ...renamed.appImage, name: "other.AppImage" } })))
      .toThrow(expect.objectContaining({ code: "format" }));
    expect(() => verifyAs(signed({ ...renamed, appImage: { ...renamed.appImage, size: -1 } }))).toThrow(expect.objectContaining({ code: "format" }));
  });

  it("refuse malformed signature files", () => {
    const bytes = signed(manifest());
    expect(() => verifyAs({ ...bytes, signatureBytes: Buffer.from("not json") })).toThrow(expect.objectContaining({ code: "format" }));
    expect(() => verifyAs({ ...bytes, signatureBytes: Buffer.alloc(0) })).toThrow(expect.objectContaining({ code: "format" }));
  });

  it("order versions with pre-releases before their release", () => {
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBe(-1);
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBe(-1);
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
  });
});
