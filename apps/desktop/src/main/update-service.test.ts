import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateKeyId, type TrustedUpdateKey } from "./update-manifest";
import { DesktopUpdater, type DesktopUpdaterOptions, type UpdateTransport } from "./update-service";

const keys = generateKeyPairSync("ed25519");
const trustedKeys: TrustedUpdateKey[] = [{ channel: "stable", publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString() }];
const NEW_APPIMAGE = Buffer.from("the new AppImage bytes");

function release(version = "0.2.0", payload = NEW_APPIMAGE) {
  const manifestBytes = Buffer.from(`${JSON.stringify({
    format: 1, product: "leaflogue", channel: "stable", version, architecture: "x64", releasedAt: "2026-10-01T00:00:00.000Z",
    appImage: { name: `Leaflogue-${version}-x86_64.AppImage`, size: payload.byteLength, sha512: createHash("sha512").update(payload).digest("base64") },
  }, null, 2)}\n`);
  const signatureBytes = Buffer.from(JSON.stringify({
    format: 1, keyId: updateKeyId(keys.publicKey), signature: sign(null, manifestBytes, keys.privateKey).toString("base64"),
  }));
  return { manifestBytes, signatureBytes };
}

let directory: string;
let appImagePath: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "leaflogue-update-"));
  appImagePath = join(directory, "Leaflogue-0.1.0-x86_64.AppImage");
  writeFileSync(appImagePath, "the old AppImage");
  chmodSync(appImagePath, 0o755);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function transport(files: { manifestBytes: Uint8Array; signatureBytes: Uint8Array }, body: Uint8Array = NEW_APPIMAGE) {
  const requested: string[] = [];
  const getBytes = vi.fn(async (url: string) => {
    requested.push(url);
    return url.endsWith(".sig") ? files.signatureBytes : files.manifestBytes;
  });
  const download = vi.fn(async (url: string, _max: number, write: (chunk: Uint8Array) => Promise<void>) => {
    requested.push(url);
    await write(body.subarray(0, 5));
    await write(body.subarray(5));
  });
  const fake: UpdateTransport = { getBytes, download };
  return { fake, requested, getBytes, download };
}

function updater(overrides: Partial<DesktopUpdaterOptions> = {}, files = release()) {
  const { fake, requested, getBytes, download } = transport(files);
  const relaunch = vi.fn();
  const instance = new DesktopUpdater({
    currentVersion: "0.1.0", architecture: "x64", appImagePath, packaged: true, flatpak: false,
    trustedKeys, transport: fake, relaunch, ...overrides,
  });
  return { instance, relaunch, requested, getBytes, download };
}

describe("desktop updater", () => {
  it("finds a signed newer release, then downloads, verifies, replaces, and restarts", async () => {
    const { instance, relaunch, requested } = updater();
    await expect(instance.check()).resolves.toMatchObject({ state: "available", version: "0.2.0", currentVersion: "0.1.0" });
    await instance.install();
    expect(readFileSync(appImagePath)).toEqual(NEW_APPIMAGE);
    expect(statSync(appImagePath).mode & 0o777).toBe(0o755);
    expect(relaunch).toHaveBeenCalledWith(appImagePath);
    expect(requested).toEqual([
      "https://github.com/Ka1Thakkar/leaflogue/releases/latest/download/leaflogue-update-stable-x64.json",
      "https://github.com/Ka1Thakkar/leaflogue/releases/latest/download/leaflogue-update-stable-x64.json.sig",
      "https://github.com/Ka1Thakkar/leaflogue/releases/download/v0.2.0/Leaflogue-0.2.0-x86_64.AppImage",
    ]);
    expect(readdirSync(directory)).toEqual(["Leaflogue-0.1.0-x86_64.AppImage"]);
  });

  it("reports the installed version as up to date", async () => {
    await expect(updater({}, release("0.1.0")).instance.check()).resolves.toEqual({ state: "up-to-date", currentVersion: "0.1.0" });
  });

  it("keeps the old AppImage when the download does not match the signed checksum", async () => {
    const files = release();
    const { fake } = transport(files, Buffer.from("tampered bytes of the same..."));
    const relaunch = vi.fn();
    const instance = new DesktopUpdater({ currentVersion: "0.1.0", architecture: "x64", appImagePath, packaged: true, flatpak: false, trustedKeys, transport: fake, relaunch });
    await instance.check();
    await expect(instance.install()).rejects.toMatchObject({ code: "verification" });
    expect(readFileSync(appImagePath, "utf8")).toBe("the old AppImage");
    expect(readdirSync(directory)).toEqual(["Leaflogue-0.1.0-x86_64.AppImage"]);
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("keeps the old AppImage when the download stops part-way", async () => {
    const { instance, download, relaunch } = updater();
    await instance.check();
    download.mockImplementationOnce(async (_url, _max, write) => {
      await write(NEW_APPIMAGE.subarray(0, 3));
      throw new Error("connection reset");
    });
    await expect(instance.install()).rejects.toMatchObject({ code: "network" });
    expect(readFileSync(appImagePath, "utf8")).toBe("the old AppImage");
    expect(readdirSync(directory)).toHaveLength(1);
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("refuses to install without a verified check, or after a failed one", async () => {
    const { instance } = updater({}, { ...release(), signatureBytes: Buffer.from("{}") });
    await expect(instance.install()).rejects.toMatchObject({ code: "state" });
    await expect(instance.check()).resolves.toMatchObject({ state: "failed", problem: "verification" });
    await expect(instance.install()).rejects.toMatchObject({ code: "state" });
  });

  it("reports a network failure without throwing", async () => {
    const { instance, getBytes } = updater();
    getBytes.mockRejectedValue(new Error("offline"));
    await expect(instance.check()).resolves.toMatchObject({ state: "failed", problem: "network" });
  });

  it("explains why a build cannot update itself and never touches the network", async () => {
    const cases: [Partial<DesktopUpdaterOptions>, string][] = [
      [{ flatpak: true }, "flatpak"],
      [{ packaged: false }, "development"],
      [{ appImagePath: undefined }, "not-appimage"],
      [{ trustedKeys: [] }, "unconfigured"],
    ];
    for (const [overrides, reason] of cases) {
      const { instance, requested } = updater(overrides);
      await expect(instance.check()).resolves.toMatchObject({ state: "unavailable", reason });
      expect(requested).toEqual([]);
    }
  });

  it("fails cleanly when the AppImage's folder cannot be written", async () => {
    const { instance, relaunch } = updater();
    await instance.check();
    chmodSync(directory, 0o500);
    try {
      await expect(instance.install()).rejects.toMatchObject({ code: "write" });
    } finally {
      chmodSync(directory, 0o700);
    }
    expect(readFileSync(appImagePath, "utf8")).toBe("the old AppImage");
    expect(relaunch).not.toHaveBeenCalled();
  });
});
