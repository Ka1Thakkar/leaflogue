import { Buffer } from "node:buffer";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Writes and signs a channel's update manifest for one architecture (ADR 0007).
 * The format must match apps/desktop/src/main/update-manifest.ts, which is what
 * the app verifies; the tests in update-manifest.test.mjs check that pairing.
 *
 * The signing key is an Ed25519 private key in PKCS#8 PEM, read from the
 * LEAFLOGUE_UPDATE_SIGNING_KEY environment variable. Only the protected
 * release environment holds it.
 */

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIRECTORY = resolve(SCRIPT_DIRECTORY, "..");

export function expectedAppImageName(version, architecture) {
  return `Leaflogue-${version}-${architecture === "x64" ? "x86_64" : "arm64"}.AppImage`;
}

export function updateManifestAssetNames(channel, architecture, platform = "linux") {
  const manifest = `leaflogue-update-${channel}-${platform === "linux" ? "" : `${platform}-`}${architecture}.json`;
  return { manifest, signature: `${manifest}.sig` };
}

export function updateKeyId(publicKey) {
  return createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex").slice(0, 16);
}

/** The exact bytes the app verifies: two-space JSON with a trailing newline. */
export function createUpdateManifest({ channel = "stable", platform = "linux", version, architecture, releasedAt, size, sha512 }) {
  if (channel !== "stable" && channel !== "beta") throw new Error("Update channel must be stable or beta");
  if (!["linux", "mac", "windows"].includes(platform)) throw new Error("Update platform is invalid");
  if (channel === "stable" && version.includes("-")) throw new Error("The stable channel cannot publish a pre-release");
  if (architecture !== "x64" && architecture !== "arm64") throw new Error("Architecture must be x64 or arm64");
  const legacy = channel === "stable" && platform === "linux";
  const name = platform === "linux" ? expectedAppImageName(version, architecture) : `Leaflogue-${version}-${platform}-${architecture}.${platform === "mac" ? "zip" : "exe"}`;
  const artifact = { name, size, sha512 };
  const manifest = {
    format: legacy ? 1 : 2,
    ...(!legacy ? { platform } : {}),
    product: "leaflogue",
    channel,
    version,
    architecture,
    releasedAt,
    ...(legacy ? { appImage: artifact } : { artifact }),
  };
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/** Key IDs of the public keys compiled into the app (src/main/update-keys.ts). */
export function trustedKeyIds(updateKeysSource, channel) {
  const entries = [...updateKeysSource.matchAll(/channel:\s*"(stable|beta)"[\s\S]*?publicKeyPem:\s*("(?:[^"\\]|\\.)*")/g)];
  return entries.filter(entry => !channel || entry[1] === channel)
    .map(entry => updateKeyId(createPublicKey(JSON.parse(entry[2]))));
}

export function signUpdateManifest(manifestBytes, privateKeyPem) {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("The update signing key must be Ed25519");
  const signature = {
    format: 1,
    keyId: updateKeyId(createPublicKey(privateKey)),
    signature: sign(null, manifestBytes, privateKey).toString("base64"),
  };
  return Buffer.from(`${JSON.stringify(signature)}\n`, "utf8");
}

async function sha512Base64(path) {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("base64");
}

function parseArguments(argumentsList) {
  const options = { channel: "stable", platform: "linux", architecture: process.arch, directory: join(DESKTOP_DIRECTORY, "dist"), releasedAt: new Date().toISOString() };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!value) throw new Error(`${argument} requires a value`);
    if (argument === "--channel") options.channel = value;
    else if (argument === "--platform") options.platform = value;
    else if (argument === "--architecture") options.architecture = value;
    else if (argument === "--directory") options.directory = resolve(value);
    else if (argument === "--released-at") options.releasedAt = value;
    else throw new Error(`Unknown update-manifest option: ${argument}`);
    index += 1;
  }
  return options;
}

async function main() {
  const { architecture, directory, releasedAt, channel, platform } = parseArguments(process.argv.slice(2));
  const privateKeyPem = process.env.LEAFLOGUE_UPDATE_SIGNING_KEY;
  if (!privateKeyPem) throw new Error("LEAFLOGUE_UPDATE_SIGNING_KEY is not set");
  // Refuse to publish updates that installed copies would reject.
  const signingKeyId = updateKeyId(createPublicKey(createPrivateKey(privateKeyPem)));
  const trusted = trustedKeyIds(await readFile(join(DESKTOP_DIRECTORY, "src/main/update-keys.ts"), "utf8"), channel);
  if (!trusted.includes(signingKeyId)) {
    throw new Error(`The signing key (${signingKeyId}) is not in src/main/update-keys.ts, so released apps would not trust it`);
  }
  const { version } = JSON.parse(await readFile(join(DESKTOP_DIRECTORY, "package.json"), "utf8"));
  const filename = platform === "linux" ? expectedAppImageName(version, architecture) : `Leaflogue-${version}-${platform}-${architecture}.${platform === "mac" ? "zip" : "exe"}`;
  const appImagePath = join(directory, filename);
  const { size } = await stat(appImagePath);
  const manifestBytes = createUpdateManifest({ channel, platform, version, architecture, releasedAt, size, sha512: await sha512Base64(appImagePath) });
  const names = updateManifestAssetNames(channel, architecture, platform);
  await writeFile(join(directory, names.manifest), manifestBytes, { flag: "wx" });
  await writeFile(join(directory, names.signature), signUpdateManifest(manifestBytes, privateKeyPem), { flag: "wx" });
  process.stdout.write(`Wrote ${names.manifest} and ${names.signature}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
