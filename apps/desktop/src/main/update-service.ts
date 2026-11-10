import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { UpdateStatus } from "@leaflogue/contracts";
import {
  UpdateVerificationError,
  updateManifestAssetNames,
  verifyUpdateManifest,
  type TrustedUpdateKey,
  type UpdateArchitecture,
  type UpdateManifest,
  type UpdatePlatform,
  type UpdateChannel,
  MAX_UPDATE_MANIFEST_BYTES,
  MAX_UPDATE_SIGNATURE_BYTES,
} from "./update-manifest";

/**
 * Checks for and installs signed AppImage updates (ADR 0007). Nothing runs
 * until the reader asks: check() fetches the stable channel's manifest and
 * signature and verifies them; install() downloads the AppImage that verified
 * manifest names, checks its size and SHA-512 while it streams, and only then
 * replaces the running AppImage and restarts. Download addresses are built
 * from the verified version, never read from the network.
 */

import { discoverUpdateFeed } from "./update-feed";

export const UPDATE_RELEASES_BASE = "https://github.com/Ka1Thakkar/leaflogue/releases";

export interface UpdateTransport {
  /** Fetch a small HTTPS resource, refusing anything larger than maxBytes. */
  getBytes(url: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array>;
  /** Stream a file to `write`, refusing anything larger than maxBytes. */
  download(url: string, maxBytes: number, write: (chunk: Uint8Array) => Promise<void>, signal?: AbortSignal): Promise<void>;
}

export interface DesktopUpdaterOptions {
  readonly currentVersion: string;
  readonly architecture: string;
  readonly platform?: UpdatePlatform;
  readonly channel?: UpdateChannel;
  /** Private per-user directory used only for verified native update downloads. */
  readonly temporaryDirectory?: string;
  readonly nativeUnavailableReason?: () => "unsupported-installation" | undefined;
  /** Stage and launch the native installer; it must quit only after staging succeeds. */
  readonly installNative?: (download: string, manifest: UpdateManifest) => Promise<void>;
  /** `process.env.APPIMAGE`: the AppImage file this process was started from. */
  readonly appImagePath: string | undefined;
  readonly packaged: boolean;
  readonly flatpak: boolean;
  readonly trustedKeys: readonly TrustedUpdateKey[];
  readonly transport: UpdateTransport;
  /** Restart from the replaced AppImage. */
  readonly relaunch: (appImagePath: string) => void;
}

export class UpdateInstallError extends Error {
  constructor(message: string, readonly code: "network" | "verification" | "write" | "state") {
    super(message);
    this.name = "UpdateInstallError";
  }
}

function architectureOf(value: string): UpdateArchitecture | undefined {
  return value === "x64" || value === "arm64" ? value : undefined;
}

export class DesktopUpdater {
  readonly #options: DesktopUpdaterOptions;
  #verified: UpdateManifest | undefined;
  #busy = false;

  constructor(options: DesktopUpdaterOptions) {
    this.#options = options;
  }

  /** Why this installation cannot update itself, if it cannot. */
  unavailableReason(): Extract<UpdateStatus, { state: "unavailable" }>["reason"] | undefined {
    const { packaged, flatpak, appImagePath, trustedKeys, architecture } = this.#options;
    if (flatpak) return "flatpak";
    if (!packaged) return "development";
    const platform = this.#options.platform ?? "linux";
    if (platform === "linux" && !appImagePath) return "not-appimage";
    if (platform !== "linux" && (!this.#options.installNative || !this.#options.temporaryDirectory)) return "unsupported-installation";
    const nativeReason = this.#options.nativeUnavailableReason?.();
    if (nativeReason) return nativeReason;
    if (!architectureOf(architecture)) return "unsupported-installation";
    if (!trustedKeys.some(({ channel }) => channel === (this.#options.channel ?? "stable"))) return "unconfigured";
    return undefined;
  }

  async check(signal?: AbortSignal): Promise<UpdateStatus> {
    const reason = this.unavailableReason();
    if (reason) return { state: "unavailable", reason, currentVersion: this.#options.currentVersion };
    const architecture = architectureOf(this.#options.architecture)!;
    const channel = this.#options.channel ?? "stable";
    const platform = this.#options.platform ?? "linux";
    const names = updateManifestAssetNames(channel, architecture, platform);
    let expectedVersion: string | undefined;
    let manifestBytes: Uint8Array;
    let signatureBytes: Uint8Array;
    try {
      const feed = await discoverUpdateFeed(this.#options.transport, channel, architecture, platform, signal);
      expectedVersion = feed.version;
      const latest = feed.base;
      [manifestBytes, signatureBytes] = await Promise.all([
        this.#options.transport.getBytes(`${latest}/${names.manifest}`, MAX_UPDATE_MANIFEST_BYTES, signal),
        this.#options.transport.getBytes(`${latest}/${names.signature}`, MAX_UPDATE_SIGNATURE_BYTES, signal),
      ]);
    } catch {
      this.#verified = undefined;
      return { state: "failed", problem: "network", currentVersion: this.#options.currentVersion };
    }
    try {
      const { manifest, newer } = verifyUpdateManifest({
        manifestBytes,
        signatureBytes,
        trustedKeys: this.#options.trustedKeys,
        channel,
        platform,
        architecture,
        currentVersion: this.#options.currentVersion,
      });
      if (expectedVersion && manifest.version !== expectedVersion) throw new UpdateVerificationError("Release and manifest versions differ", "version");
      this.#verified = newer ? manifest : undefined;
      return newer
        ? { state: "available", currentVersion: this.#options.currentVersion, version: manifest.version, releasedAt: manifest.releasedAt, notesUrl: `${UPDATE_RELEASES_BASE}/tag/v${manifest.version}` }
        : { state: "up-to-date", currentVersion: this.#options.currentVersion };
    } catch (error) {
      this.#verified = undefined;
      if (error instanceof UpdateVerificationError) {
        return { state: "failed", problem: "verification", currentVersion: this.#options.currentVersion };
      }
      throw error;
    }
  }

  /**
   * Download, verify, and swap in the update the last check verified, then
   * restart. The new file is written beside the running AppImage and renamed
   * over it only after its size and SHA-512 match the signed manifest, so an
   * interrupted or corrupted download never replaces a working app.
   */
  async install(signal?: AbortSignal): Promise<void> {
    const manifest = this.#verified;
    const appImagePath = this.#options.appImagePath;
    if (!manifest || this.unavailableReason()) {
      throw new UpdateInstallError("Check for updates first", "state");
    }
    if (this.#busy) throw new UpdateInstallError("An update is already being installed", "state");
    this.#busy = true;
    const native = (this.#options.platform ?? "linux") !== "linux";
    let staging: string | undefined;
    let temporaryPath: string | undefined;
    try {
      staging = native ? await mkdtemp(join(this.#options.temporaryDirectory!, "leaflogue-update-")) : undefined;
      const directory = staging ?? dirname(appImagePath!);
      temporaryPath = native ? join(directory, manifest.artifact.name) : join(directory, `.${basename(appImagePath!)}.${randomUUID()}.update`);
      const file = await open(temporaryPath, "wx", 0o700).catch(() => {
        throw new UpdateInstallError("Leaflogue cannot write beside its AppImage", "write");
      });
      const hash = createHash("sha512");
      let size = 0;
      try {
        const url = `${UPDATE_RELEASES_BASE}/download/v${manifest.version}/${manifest.artifact.name}`;
        await this.#options.transport.download(url, manifest.artifact.size, async (chunk) => {
          size += chunk.byteLength;
          if (size > manifest.artifact.size) throw new UpdateInstallError("The update is larger than its signed size", "verification");
          hash.update(chunk);
          await file.writeFile(chunk);
        }, signal).catch((error: unknown) => {
          if (error instanceof UpdateInstallError) throw error;
          throw new UpdateInstallError("The update could not be downloaded", "network");
        });
        await file.sync();
      } finally {
        await file.close();
      }
      if (size !== manifest.artifact.size || hash.digest("base64") !== manifest.artifact.sha512) {
        throw new UpdateInstallError("The downloaded update does not match its signed checksum", "verification");
      }
      if (native) {
        await this.#options.installNative!(temporaryPath, manifest);
        this.#verified = undefined;
        return;
      }
      await chmod(temporaryPath, 0o755);
      await rename(temporaryPath, appImagePath!).catch(() => {
        throw new UpdateInstallError("Leaflogue cannot replace its AppImage", "write");
      });
    } catch (error) {
      if (temporaryPath) await rm(temporaryPath, { force: true });
      if (staging) await rm(staging, { recursive: true, force: true });
      throw error;
    } finally {
      this.#busy = false;
    }
    this.#verified = undefined;
    this.#options.relaunch(appImagePath!);
  }
}
