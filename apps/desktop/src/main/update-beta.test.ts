import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BETA_RELEASES_API, discoverUpdateFeed } from "./update-feed";
import { expectedUpdateName, updateKeyId, updateManifestAssetNames, verifyUpdateManifest, type TrustedUpdateKey, type UpdatePlatform } from "./update-manifest";
import { DesktopUpdater, type UpdateTransport } from "./update-service";

const keys = generateKeyPairSync("ed25519");
const trustedKeys: TrustedUpdateKey[] = [{ channel: "beta", publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString() }];
const payload = Buffer.from("verified native updater payload");
function files(platform: UpdatePlatform, version = "0.1.0-beta.2") {
  const manifestBytes = Buffer.from(JSON.stringify({ format: 2, product: "leaflogue", channel: "beta", platform, version, architecture: "x64", releasedAt: "2026-11-10T00:00:00Z", artifact: { name: expectedUpdateName(version, "x64", platform), size: payload.length, sha512: createHash("sha512").update(payload).digest("base64") } }));
  const signatureBytes = Buffer.from(JSON.stringify({ format: 1, keyId: updateKeyId(keys.publicKey), signature: sign(null, manifestBytes, keys.privateKey).toString("base64") }));
  return { manifestBytes, signatureBytes };
}
function listing(platform: UpdatePlatform, version = "0.1.0-beta.2", extra = {}) {
  const names = updateManifestAssetNames("beta", "x64", platform);
  return { draft: false, prerelease: true, tag_name: `v${version}`, assets: [{ name: names.manifest }, { name: names.signature }], ...extra };
}
function transport(platform: UpdatePlatform, manifestVersion?: string, body = payload) {
  const signed = files(platform, manifestVersion);
  const getBytes = vi.fn(async (url: string) => url === BETA_RELEASES_API ? Buffer.from(JSON.stringify([listing(platform)])) : url.endsWith(".sig") ? signed.signatureBytes : signed.manifestBytes);
  const download = vi.fn(async (_url: string, _max: number, write: (chunk: Uint8Array) => Promise<void>) => { await write(body); });
  return { getBytes, download } satisfies UpdateTransport;
}

describe("signed beta updates", () => {
  for (const platform of ["linux", "mac", "windows"] as const) {
    it(`verifies ${platform} beta metadata and rejects another platform`, () => {
      const input = { ...files(platform), trustedKeys, channel: "beta" as const, architecture: "x64" as const, currentVersion: "0.1.0-beta.1", platform };
      expect(verifyUpdateManifest(input)).toMatchObject({ newer: true, manifest: { platform, version: "0.1.0-beta.2" } });
      expect(() => verifyUpdateManifest({ ...input, platform: platform === "mac" ? "windows" : "mac" })).toThrow(/platform/);
      expect(() => verifyUpdateManifest({ ...input, channel: "stable" })).toThrow(/key/);
    });
  }
  it("discovers the newest signed beta asset set, ignoring draft and untrusted download URLs", async () => {
    const getBytes = vi.fn(async () => Buffer.from(JSON.stringify([
      listing("mac", "0.1.0-beta.20", { draft: true }), listing("mac", "0.1.0-beta.2"), listing("mac", "0.1.0-beta.10", { url: "https://evil.example/update" }),
    ])));
    expect(await discoverUpdateFeed({ getBytes, download: vi.fn() }, "beta", "x64", "mac")).toEqual({ base: "https://github.com/Ka1Thakkar/leaflogue/releases/download/v0.1.0-beta.10", version: "0.1.0-beta.10" });
  });
  it("rejects a signed manifest whose version differs from its release tag", async () => {
    const updater = new DesktopUpdater({ currentVersion: "0.1.0-beta.1", channel: "beta", platform: "mac", architecture: "x64", appImagePath: undefined, packaged: true, flatpak: false, trustedKeys, temporaryDirectory: tmpdir(), installNative: vi.fn(), transport: transport("mac", "0.1.0-beta.3"), relaunch: vi.fn() });
    expect(await updater.check()).toMatchObject({ state: "failed", problem: "verification" });
  });
  it("hands native installers only verified bytes, preserving a private staging directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "leaflogue-update-test-"));
    try {
      const installer = vi.fn(async (file: string) => { expect(await readFile(file)).toEqual(payload); });
      const updater = new DesktopUpdater({ currentVersion: "0.1.0-beta.1", channel: "beta", platform: "windows", architecture: "x64", appImagePath: undefined, packaged: true, flatpak: false, trustedKeys, temporaryDirectory: directory, installNative: installer, transport: transport("windows"), relaunch: vi.fn() });
      expect(await updater.check()).toMatchObject({ state: "available", version: "0.1.0-beta.2" });
      await updater.install();
      expect(installer).toHaveBeenCalledOnce();
      expect(installer.mock.calls[0]![0]).toMatch(/Leaflogue-0\.1\.0-beta\.2-windows-x64\.exe$/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("never launches a corrupted native payload and cleans its staging files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "leaflogue-update-test-"));
    try {
      const installer = vi.fn();
      const updater = new DesktopUpdater({ currentVersion: "0.1.0-beta.1", channel: "beta", platform: "mac", architecture: "x64", appImagePath: undefined, packaged: true, flatpak: false, trustedKeys, temporaryDirectory: directory, installNative: installer, transport: transport("mac", undefined, Buffer.from("tampered")), relaunch: vi.fn() });
      await updater.check();
      await expect(updater.install()).rejects.toMatchObject({ code: "verification" });
      expect(installer).not.toHaveBeenCalled();
      expect(await readdir(directory)).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
