import { error as writeError, log } from "node:console";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIRECTORY = resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_ARTIFACT_DIRECTORY = join(DESKTOP_DIRECTORY, "dist");
const SUPPORTED_ARCHITECTURES = new Set(["x64", "arm64"]);
const RELEASE_FORMATS = ["AppImage", "tar.gz"];
const RETIRED_RELEASE_FORMATS = ["rpm"];
const ARTIFACT_ARCHITECTURES = {
  x64: {
    AppImage: "x86_64",
    "tar.gz": "x64"
  },
  arm64: {
    AppImage: "arm64",
    "tar.gz": "arm64"
  }
};

const RETIRED_ARTIFACT_ARCHITECTURES = {
  x64: { rpm: "x86_64" },
  arm64: { rpm: "aarch64" }
};

function parseArguments(argumentsList) {
  let architecture = process.arch;
  let artifactDirectory = DEFAULT_ARTIFACT_DIRECTORY;
  let prepare = false;

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    const value = argumentsList[index + 1];

    if (argument === "--architecture") {
      if (!value) {
        throw new Error("--architecture requires x64 or arm64");
      }
      architecture = value;
      index += 1;
      continue;
    }

    if (argument === "--directory") {
      if (!value) {
        throw new Error("--directory requires a path");
      }
      artifactDirectory = resolve(value);
      index += 1;
      continue;
    }

    if (argument === "--prepare") {
      prepare = true;
      continue;
    }

    throw new Error(`Unknown release-artifact option: ${argument}`);
  }

  return { architecture, artifactDirectory, prepare };
}

async function readBuildIdentity() {
  const manifestPath = join(DESKTOP_DIRECTORY, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const build = manifest.build;

  if (typeof build?.productName !== "string" || typeof manifest.version !== "string") {
    throw new Error("Desktop package.json must define build.productName and version");
  }

  return { productName: build.productName, version: manifest.version };
}

function expectedArtifactNames({ productName, version, architecture }) {
  if (!SUPPORTED_ARCHITECTURES.has(architecture)) {
    throw new Error(`Unsupported Linux release architecture: ${architecture}`);
  }

  return RELEASE_FORMATS.map((format) => {
    const artifactArchitecture = ARTIFACT_ARCHITECTURES[architecture][format];
    return `${productName}-${version}-${artifactArchitecture}.${format}`;
  });
}

function retiredArtifactNames({ productName, version, architecture }) {
  if (!SUPPORTED_ARCHITECTURES.has(architecture)) {
    throw new Error(`Unsupported Linux release architecture: ${architecture}`);
  }

  return RETIRED_RELEASE_FORMATS.map((format) => {
    const artifactArchitecture = RETIRED_ARTIFACT_ARCHITECTURES[architecture][format];
    return `${productName}-${version}-${artifactArchitecture}.${format}`;
  });
}

export function releaseEvidenceNames({ productName, version, architecture }) {
  if (!SUPPORTED_ARCHITECTURES.has(architecture)) {
    throw new Error(`Unsupported Linux release architecture: ${architecture}`);
  }

  const baseName = `${productName}-${version}-${architecture}`;
  return [
    `${baseName}.build-inputs.json`,
    `${baseName}.production-audit.json`,
    `${baseName}.supply-chain.cdx.json`
  ];
}

async function sha256(filePath) {
  const contents = await readFile(filePath);
  return createHash("sha256").update(contents).digest("hex");
}

/**
 * Verify a complete, non-symlinked Linux release set and write its checksum
 * manifest in stable filename order. This deliberately accepts no partial set:
 * publishing one artifact alongside a checksum manifest is a release error.
 */
export async function verifyReleaseArtifacts({ artifactDirectory, architecture }) {
  const identity = await readBuildIdentity();
  const expectedNames = expectedArtifactNames({ ...identity, architecture });
  const availableNames = new Set(await readdir(artifactDirectory));
  const missing = expectedNames.filter((name) => !availableNames.has(name));

  if (missing.length > 0) {
    throw new Error(`Missing Linux release artifacts: ${missing.join(", ")}`);
  }

  const checksums = [];
  for (const name of expectedNames) {
    const artifactPath = join(artifactDirectory, name);
    const metadata = await lstat(artifactPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Release artifact must be a regular file: ${name}`);
    }

    checksums.push({ name, value: await sha256(artifactPath) });
  }

  const manifestPath = join(artifactDirectory, `SHA256SUMS-${architecture}.txt`);
  const manifest = checksums
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map(({ name, value }) => `${value}  ${name}`)
    .join("\n");
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${manifest}\n`, { encoding: "utf8", mode: 0o644 });

  return { manifestPath, checksums };
}

/**
 * Remove only the exact names that the next build is expected to create. This
 * prevents a same-version partial build from inheriting stale release files.
 */
export async function prepareReleaseArtifacts({ artifactDirectory, architecture }) {
  const identity = await readBuildIdentity();
  const artifactNames = expectedArtifactNames({ ...identity, architecture });
  const retiredNames = retiredArtifactNames({ ...identity, architecture });
  const manifestName = `SHA256SUMS-${architecture}.txt`;
  const evidenceNames = releaseEvidenceNames({ ...identity, architecture });

  await Promise.all(
    [...artifactNames, ...retiredNames, manifestName, ...evidenceNames].map((name) =>
      rm(join(artifactDirectory, name), { force: true })
    )
  );

  return { removedNames: [...artifactNames, ...retiredNames, manifestName, ...evidenceNames] };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.prepare) {
    const result = await prepareReleaseArtifacts(options);
    log(`Prepared ${options.architecture} Linux release output (${result.removedNames.length} paths)`);
    return;
  }

  const result = await verifyReleaseArtifacts(options);
  log(
    `Verified ${result.checksums.length} ${options.architecture} Linux release artifacts: ${basename(result.manifestPath)}`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    writeError(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
