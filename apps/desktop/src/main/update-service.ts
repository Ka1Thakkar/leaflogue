import { createHash, randomUUID } from "node:crypto";
import { chmod, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { UpdateStatus } from "@leaflogue/contracts";
import {
  UpdateVerificationError,
  updateManifestAssetNames,
  verifyUpdateManifest,
  type TrustedUpdateKey,
  type UpdateArchitecture,
  type UpdateManifest,
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
    if (!appImagePath) return "not-appimage";
    if (!architectureOf(architecture)) return "not-appimage";
    if (!trustedKeys.some(({ channel }) => channel === "stable")) return "unconfigured";
    return undefined;
  }

  async check(signal?: AbortSignal): Promise<UpdateStatus> {
    const reason = this.unavailableReason();
    if (reason) return { state: "unavailable", reason, currentVersion: this.#options.currentVersion };
    const architecture = architectureOf(this.#options.architecture)!;
    const names = updateManifestAssetNames("stable", architecture);
    // GitHub's "latest" release excludes drafts and pre-releases.
    const latest = `${UPDATE_RELEASES_BASE}/latest/download`;
    let manifestBytes: Uint8Array;
    let signatureBytes: Uint8Array;
    try {
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
        channel: "stable",
        architecture,
        currentVersion: this.#options.currentVersion,
      });
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
    if (!manifest || !appImagePath || this.unavailableReason()) {
      throw new UpdateInstallError("Check for updates first", "state");
    }
    if (this.#busy) throw new UpdateInstallError("An update is already being installed", "state");
    this.#busy = true;
    const directory = dirname(appImagePath);
    const temporaryPath = join(directory, `.${basename(appImagePath)}.${randomUUID()}.update`);
    try {
      const file = await open(temporaryPath, "wx", 0o700).catch(() => {
        throw new UpdateInstallError("Leaflogue cannot write beside its AppImage", "write");
      });
      const hash = createHash("sha512");
      let size = 0;
      try {
        const url = `${UPDATE_RELEASES_BASE}/download/v${manifest.version}/${manifest.appImage.name}`;
        await this.#options.transport.download(url, manifest.appImage.size, async (chunk) => {
          size += chunk.byteLength;
          if (size > manifest.appImage.size) throw new UpdateInstallError("The update is larger than its signed size", "verification");
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
      if (size !== manifest.appImage.size || hash.digest("base64") !== manifest.appImage.sha512) {
        throw new UpdateInstallError("The downloaded update does not match its signed checksum", "verification");
      }
      await chmod(temporaryPath, 0o755);
      await rename(temporaryPath, appImagePath).catch(() => {
        throw new UpdateInstallError("Leaflogue cannot replace its AppImage", "write");
      });
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    } finally {
      this.#busy = false;
    }
    this.#verified = undefined;
    this.#options.relaunch(appImagePath);
  }
}
