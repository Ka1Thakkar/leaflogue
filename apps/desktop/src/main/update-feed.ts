import { compareVersions, updateManifestAssetNames, type UpdateArchitecture, type UpdateChannel, type UpdatePlatform } from "./update-manifest";
import type { UpdateTransport } from "./update-service";

export const BETA_RELEASES_API = "https://api.github.com/repos/Ka1Thakkar/leaflogue/releases?per_page=20";
export const RELEASES_BASE = "https://github.com/Ka1Thakkar/leaflogue/releases";

/** Discovery is untrusted. The caller must verify the signed manifest and its version. */
export async function discoverUpdateFeed(transport: UpdateTransport, channel: UpdateChannel, architecture: UpdateArchitecture, platform: UpdatePlatform, signal?: AbortSignal): Promise<{ base: string; version?: string }> {
  if (channel === "stable") return { base: `${RELEASES_BASE}/latest/download` };
  const bytes = await transport.getBytes(BETA_RELEASES_API, 1024 * 1024, signal);
  const releases: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!Array.isArray(releases) || releases.length > 20) throw new Error("Invalid release listing");
  const names = updateManifestAssetNames(channel, architecture, platform);
  const versions: string[] = [];
  for (const release of releases as unknown[]) {
    if (!release || typeof release !== "object") continue;
    const value = release as Record<string, unknown>;
    if (value.draft !== false || typeof value.tag_name !== "string" || !Array.isArray(value.assets)) continue;
    const version = value.tag_name.slice(1);
    if (!/^v\d{1,6}\.\d{1,6}\.\d{1,6}(?:-beta\.\d{1,6})?$/.test(value.tag_name)) continue;
    const assets = new Set(value.assets.map((asset: unknown) => asset && typeof asset === "object" ? (asset as Record<string, unknown>).name : undefined));
    if (assets.has(names.manifest) && assets.has(names.signature)) versions.push(version);
  }
  versions.sort((a, b) => compareVersions(b, a));
  if (!versions[0]) throw new Error("No published signed beta feed");
  return { base: `${RELEASES_BASE}/download/v${versions[0]}`, version: versions[0] };
}
