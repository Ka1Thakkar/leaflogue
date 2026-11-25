import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, createPublicKey, verify } from "node:crypto";

const repo = "Ka1Thakkar/leaflogue";
const tag = "v0.1.1-beta.6";
const staging = "beta-candidate-44087855277-1";
const source = process.env.REFRESH_BUILD_SOURCE;
if (!/^[a-f0-9]{40}$/u.test(source ?? "")) throw Error("Exact staging source is required");
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const json = (...args) => JSON.parse(gh(...args));
const run = (id) => {
  if (!/^\d+$/u.test(id ?? "")) throw Error("A completed workflow run is required");
  const result = json("run", "view", id, "--repo", repo, "--json", "status,conclusion,headSha,jobs");
  if (result.status !== "completed" || result.conclusion !== "success") throw Error(`Workflow ${id} did not pass`);
  return result;
};
const buildRun = process.env.REFRESH_BUILD_RUN;
const signingRun = process.env.REFRESH_SIGNING_RUN;
const build = run(buildRun);
if (build.headSha !== source) throw Error("Build source differs from this promotion source");
for (const name of ["Validate the exact beta source", "mac beta (arm64)", "mac beta (x64)", "windows beta (x64)", "Linux x64 and ARM64 plus backend"]) {
  if (!build.jobs.some((job) => job.name === name && job.conclusion === "success")) throw Error(`Missing passed job: ${name}`);
}
const signing = run(signingRun);
const tagRef = json("api", `repos/${repo}/git/ref/tags/${tag}`);
if (tagRef.object.type !== "commit" || signing.headSha !== tagRef.object.sha ||
    !signing.jobs.some((job) => job.name === "Sign the beta update feeds" && job.conclusion === "success")) {
  throw Error("Feed signing must pass on the unchanged protected beta tag");
}
const old = json("release", "view", tag, "--repo", repo, "--json", "body,assets,isDraft,isPrerelease");
if (old.isDraft || !old.isPrerelease) throw Error("Expected the existing published beta release");
const directory = mkdtempSync(join(tmpdir(), "leaflogue-beta6-refresh-"));
gh("release", "download", staging, "--repo", repo, "--dir", directory, ...old.assets.flatMap((asset) => ["--pattern", asset.name]));
const names = readdirSync(directory).sort();
if (JSON.stringify(names) !== JSON.stringify(old.assets.map((asset) => asset.name).sort())) throw Error("Staged asset set differs from the published release");
const bytes = (name) => readFileSync(join(directory, name));
const hash = (name, algorithm = "sha256", encoding = "hex") => createHash(algorithm).update(bytes(name)).digest(encoding);
for (const name of names.filter((name) => name.startsWith("SHA256SUMS-"))) {
  for (const line of bytes(name).toString().trim().split("\n")) {
    const match = /^([a-f0-9]{64})\s+\*?([^/]+)$/u.exec(line);
    if (!match || !names.includes(match[2]) || hash(match[2]) !== match[1]) throw Error(`Invalid checksum in ${name}`);
  }
}
const expectedLock = createHash("sha256").update(readFileSync("package-lock.json")).digest("hex");
const expectedManifest = createHash("sha256").update(readFileSync("apps/desktop/package.json")).digest("hex");
for (const name of names.filter((name) => name.endsWith(".build-inputs.json"))) {
  const input = JSON.parse(bytes(name));
  if (input.version !== "0.1.1-beta.6" || input.lockfileSha256 !== expectedLock || input.desktopManifestSha256 !== expectedManifest ||
      (input.platform !== undefined && input.commit !== source)) throw Error(`Unexpected build inputs: ${name}`);
}
const keySource = readFileSync("apps/desktop/src/main/update-keys.ts", "utf8");
const match = /channel:\s*"beta",\s*publicKeyPem:\s*("(?:[^"\\]|\\.)*")/u.exec(keySource);
if (!match) throw Error("Trusted beta key is missing");
const key = createPublicKey(JSON.parse(match[1]));
const keyId = createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex").slice(0, 16);
for (const name of names.filter((name) => name.startsWith("leaflogue-update-") && name.endsWith(".json"))) {
  const manifest = JSON.parse(bytes(name));
  const signature = JSON.parse(bytes(`${name}.sig`));
  if (signature.format !== 1 || signature.keyId !== keyId || !verify(null, bytes(name), key, Buffer.from(signature.signature, "base64"))) throw Error(`Invalid signature: ${name}`);
  const artifact = manifest.artifact;
  if (manifest.format !== 2 || manifest.channel !== "beta" || manifest.version !== "0.1.1-beta.6" || !artifact || !names.includes(artifact.name) ||
      bytes(artifact.name).length !== artifact.size || hash(artifact.name, "sha512", "base64") !== artifact.sha512) throw Error(`Invalid update payload: ${name}`);
}
if (process.env.REFRESH_PUBLISH !== "1") {
  console.log(`Verified ${names.length} staged assets from ${source}; publication was not requested.`);
  process.exit(0);
}
// Replace payloads first and signed update feeds last. Never move the existing tag.
for (const group of [names.filter((name) => !name.startsWith("SHA256SUMS-") && !name.startsWith("leaflogue-update-")), names.filter((name) => name.startsWith("SHA256SUMS-")), names.filter((name) => name.startsWith("leaflogue-update-"))]) {
  gh("release", "upload", tag, "--repo", repo, "--clobber", ...group.map((name) => join(directory, name)));
}
const published = json("release", "view", tag, "--repo", repo, "--json", "assets");
for (const asset of published.assets) if (asset.digest !== `sha256:${hash(asset.name)}`) throw Error(`Published digest mismatch: ${asset.name}`);
if (json("api", `repos/${repo}/git/ref/tags/${tag}`).object.sha !== tagRef.object.sha) throw Error("Protected release tag changed");
let notes = readFileSync("docs/releases/beta.6-refresh-notes.md", "utf8");
notes += `\nBuild source: https://github.com/${repo}/commit/${source}\nBuild and validation: https://github.com/${repo}/actions/runs/${buildRun}\nProtected feed signing: https://github.com/${repo}/actions/runs/${signingRun}\n`;
const notesFile = join(directory, "release-notes.md");
writeFileSync(notesFile, notes);
gh("release", "edit", tag, "--repo", repo, "--notes-file", notesFile);
console.log(`Refreshed existing ${tag}: ${names.length} verified assets from ${source}.`);
