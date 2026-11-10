import process from "node:process";
import { Buffer } from "node:buffer";
import { error as writeError } from "node:console";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { listPackage } from "@electron/asar";
import { verifyManualReleasePolicy } from "./release-policy.mjs";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(desktop, "../..");
const require = createRequire(import.meta.url);

export function validateNativeTarget(platform, architecture, host = process.platform) {
  if (platform !== "mac" && platform !== "windows") throw new Error("Native platform must be mac or windows");
  if (!['x64', 'arm64'].includes(architecture) || (platform === "windows" && architecture !== "x64")) throw new Error("Beta targets: Mac x64/arm64 and Windows x64");
  if (host !== (platform === "mac" ? "darwin" : "win32")) throw new Error("Build and validate this package on its native operating system");
}

export function assertNativeArchitecture(bytes, platform, architecture) {
  if (platform === "mac") {
    if (bytes.length < 8 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== (architecture === "arm64" ? 0x100000c : 0x1000007)) throw new Error("Mac executable architecture does not match its release name");
  } else {
    if (bytes.length < 64 || bytes.toString("ascii", 0, 2) !== "MZ") throw new Error("Windows executable is not PE");
    const offset = bytes.readUInt32LE(0x3c);
    if (offset > bytes.length - 6 || bytes.toString("ascii", offset, offset + 4) !== "PE\0\0" || bytes.readUInt16LE(offset + 4) !== 0x8664) throw new Error("Windows executable must be x64 PE");
  }
}

function run(command, args, allowFailure = false) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: desktop, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [], stderr = [];
    child.stdout.on("data", data => stdout.push(data)); child.stderr.on("data", data => stderr.push(data));
    child.once("error", reject);
    child.once("close", code => {
      const result = { code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
      if (code === 0 || allowFailure) resolveRun(result);
      else { process.stderr.write(result.stdout + result.stderr); reject(new Error(`${command} failed (${code})`)); }
    });
  });
}
async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function packageNative(platform, architecture = process.arch) {
  validateNativeTarget(platform, architecture);
  await verifyManualReleasePolicy();
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("Run this through npm run package:mac or package:windows:x64");
  const npm = (args, allowFailure = false) => run(process.execPath, [npmCli, ...args], allowFailure);
  const identity = JSON.parse(await readFile(join(desktop, "package.json"), "utf8"));
  const directory = join(desktop, "dist", `beta-${platform}-${architecture}`);
  await mkdir(directory, { recursive: true });
  await npm(["run", "build"]);
  await run(process.execPath, [require.resolve("electron-builder/cli.js"), platform === "mac" ? "--mac" : "--win", ...(platform === "mac" ? ["dmg", "zip"] : ["nsis", "zip"]), `--${architecture}`, "--publish", "never", `-c.directories.output=${directory}`]);
  const unpacked = platform === "mac" ? join(directory, architecture === "arm64" ? "mac-arm64" : "mac", "Leaflogue.app") : join(directory, "win-unpacked");
  const executable = platform === "mac" ? join(unpacked, "Contents/MacOS/Leaflogue") : join(unpacked, "Leaflogue.exe");
  assertNativeArchitecture(await readFile(executable), platform, architecture);
  if (platform === "mac") await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", unpacked]);
  const asar = platform === "mac" ? join(unpacked, "Contents/Resources/app.asar") : join(unpacked, "resources/app.asar");
  const members = listPackage(asar).map(member => member.replaceAll("\\", "/"));
  for (const file of ["out/main/index.js", "out/renderer/index.html", "node_modules/wordnet-db/dict/data.noun", "node_modules/wordnet-db/dict/index.noun"]) {
    if (!members.includes(`/${file}`)) throw new Error(`Packaged app is missing ${file}`);
  }
  const base = `${identity.build.productName}-${identity.version}-${platform}-${architecture}`;
  const artifacts = (platform === "mac" ? ["dmg", "zip"] : ["exe", "zip"]).map(extension => `${base}.${extension}`);
  const archiveTool = require("7zip-bin").path7za;
  if (process.platform !== "win32") await chmod(archiveTool, 0o755);
  await run(archiveTool, ["t", join(directory, `${base}.zip`)]);
  if (platform === "mac") await run("/usr/bin/hdiutil", ["verify", join(directory, `${base}.dmg`)]);
  const [sbom, audit] = await Promise.all([
    npm(["sbom", "--package-lock-only", "--omit=dev", "--sbom-format", "cyclonedx", "--sbom-type", "application"]),
    npm(["audit", "--omit=dev", "--audit-level=high", "--json"], true),
  ]);
  JSON.parse(sbom.stdout);
  const auditReport = JSON.parse(audit.stdout);
  if (!auditReport.metadata?.vulnerabilities || auditReport.metadata.vulnerabilities.high || auditReport.metadata.vulnerabilities.critical) throw new Error("Production dependency audit must have no high or critical findings");
  if (audit.code !== 0) throw new Error("Production audit did not complete successfully");
  const evidence = {
    version: identity.version, platform, architecture, commit: process.env.GITHUB_SHA ?? null,
    signing: platform === "mac" ? "ad-hoc; not notarized" : "unsigned beta",
    node: process.version, lockfileSha256: await digest(join(root, "package-lock.json")),
    desktopManifestSha256: await digest(join(desktop, "package.json")),
    executableSha256: await digest(executable), asarSha256: await digest(asar),
  };
  for (const [suffix, contents] of [["build-inputs.json", JSON.stringify(evidence, null, 2)], ["production-audit.json", audit.stdout], ["supply-chain.cdx.json", sbom.stdout]]) {
    const name = `${base}.${suffix}`; await writeFile(join(directory, name), `${contents.trim()}\n`); artifacts.push(name);
  }
  const sums = await Promise.all(artifacts.map(async name => `${await digest(join(directory, name))}  ${name}`));
  await writeFile(join(directory, `SHA256SUMS-${platform}-${architecture}.txt`), sums.join("\n") + "\n");
  process.stdout.write(`Validated ${platform}/${architecture} beta files in ${directory}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packageNative(process.argv[2], process.argv[3]).catch(error => { writeError(error.message); process.exitCode = 1; });
}
