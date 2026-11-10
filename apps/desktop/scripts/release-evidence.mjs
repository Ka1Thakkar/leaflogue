import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { verifyReleaseArtifacts } from "./release-artifacts.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIRECTORY = resolve(SCRIPT_DIRECTORY, "..");
const REPOSITORY_DIRECTORY = resolve(DESKTOP_DIRECTORY, "../..");
const DEFAULT_ARTIFACT_DIRECTORY = join(DESKTOP_DIRECTORY, "dist");
const SUPPORTED_ARCHITECTURES = new Set(["x64", "arm64"]);

function parseArguments(argumentsList) {
  let architecture = process.arch;
  let artifactDirectory = DEFAULT_ARTIFACT_DIRECTORY;

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    const value = argumentsList[index + 1];

    if (argument === "--architecture") {
      if (!value) throw new Error("--architecture requires x64 or arm64");
      architecture = value;
      index += 1;
      continue;
    }

    if (argument === "--directory") {
      if (!value) throw new Error("--directory requires a path");
      artifactDirectory = resolve(value);
      index += 1;
      continue;
    }

    throw new Error(`Unknown release-evidence option: ${argument}`);
  }

  if (!SUPPORTED_ARCHITECTURES.has(architecture)) {
    throw new Error(`Unsupported Linux release architecture: ${architecture}`);
  }

  return { architecture, artifactDirectory };
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function readPackageIdentity() {
  const desktopPackagePath = join(DESKTOP_DIRECTORY, "package.json");
  const desktopPackage = JSON.parse(await readFile(desktopPackagePath, "utf8"));
  if (typeof desktopPackage.build?.productName !== "string" || typeof desktopPackage.version !== "string") {
    throw new Error("Desktop package.json must define build.productName and version");
  }

  return {
    productName: desktopPackage.build.productName,
    version: desktopPackage.version,
    manifestSha256: sha256(await readFile(desktopPackagePath))
  };
}

async function run(command, argumentsList, { allowFailure = false, cwd, runner = spawn }) {
  return new Promise((resolvePromise, reject) => {
    const child = runner(command, argumentsList, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const output = [];
    const errors = [];

    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      const result = {
        code,
        stderr: Buffer.concat(errors).toString("utf8"),
        stdout: Buffer.concat(output).toString("utf8")
      };
      if (code === 0 || allowFailure) resolvePromise(result);
      else reject(new Error(`${command} ${argumentsList[0]} failed with exit code ${code}`));
    });
  });
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isAuditReport(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    value.metadata !== null &&
    typeof value.metadata === "object" &&
    value.metadata.vulnerabilities !== null &&
    typeof value.metadata.vulnerabilities === "object"
  );
}

function readSourceDateEpoch(value) {
  if (value === undefined) return null;
  if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error("SOURCE_DATE_EPOCH must be a non-negative safe integer");
  }

  return value;
}

/**
 * Release evidence deliberately contains dependency and build-input provenance,
 * never configuration values, credentials, library paths, or reading data.
 */
export async function generateReleaseEvidence(
  { artifactDirectory, architecture },
  { commandRunner = run } = {}
) {
  const { manifestPath } = await verifyReleaseArtifacts({ artifactDirectory, architecture });
  const identity = await readPackageIdentity();
  const lockfile = await readFile(join(REPOSITORY_DIRECTORY, "package-lock.json"));
  const manifest = await readFile(manifestPath);
  const baseName = `${identity.productName}-${identity.version}-${architecture}`;

  const [sbom, audit] = await Promise.all([
    commandRunner("npm", ["sbom", "--package-lock-only", "--sbom-format", "cyclonedx", "--sbom-type", "application"], {
      cwd: REPOSITORY_DIRECTORY
    }),
    commandRunner("npm", ["audit", "--omit=dev", "--audit-level=high", "--json"], {
      allowFailure: true,
      cwd: REPOSITORY_DIRECTORY
    })
  ]);

  let parsedSbom;
  let parsedAudit;
  try {
    parsedSbom = JSON.parse(sbom.stdout);
    parsedAudit = JSON.parse(audit.stdout);
  } catch {
    throw new Error("npm release evidence did not produce valid JSON");
  }
  if (!isAuditReport(parsedAudit)) {
    throw new Error("npm audit did not produce a dependency vulnerability report");
  }

  const evidence = {
    architecture,
    desktopManifestSha256: identity.manifestSha256,
    lockfileSha256: sha256(lockfile),
    productName: identity.productName,
    schemaVersion: 1,
    sha256ManifestSha256: sha256(manifest),
    sourceDateEpoch: readSourceDateEpoch(process.env.SOURCE_DATE_EPOCH),
    version: identity.version
  };
  const paths = {
    audit: join(artifactDirectory, `${baseName}.production-audit.json`),
    buildInputs: join(artifactDirectory, `${baseName}.build-inputs.json`),
    sbom: join(artifactDirectory, `${baseName}.supply-chain.cdx.json`)
  };

  await mkdir(artifactDirectory, { recursive: true });
  await Promise.all([
    writeFile(paths.audit, stableJson(parsedAudit), { encoding: "utf8", mode: 0o644 }),
    writeFile(paths.buildInputs, stableJson(evidence), { encoding: "utf8", mode: 0o644 }),
    writeFile(paths.sbom, stableJson(parsedSbom), { encoding: "utf8", mode: 0o644 })
  ]);

  if (audit.code !== undefined && audit.code !== 0) {
    throw new Error(
      `Production dependency audit found release-blocking vulnerabilities; see ${basename(paths.audit)}`
    );
  }

  return paths;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const paths = await generateReleaseEvidence(options);
  process.stdout.write(
    `Generated release evidence: ${Object.values(paths)
      .map((path) => basename(path))
      .join(", ")}\n`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
