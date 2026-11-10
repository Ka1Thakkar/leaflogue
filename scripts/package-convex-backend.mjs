import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONVEX_VERSION = "1.45.0";
// The web app's sign-in (convex/auth.ts).
const CONVEX_AUTH_VERSION = "0.0.95";
const AUTH_CORE_VERSION = "0.41.3";
const RUNTIME_PACKAGE_VERSION = "0.0.0";
const LOCKFILE = join(root, "scripts", "convex-backend.package-lock.json");

export function packageConvexBackend({ version, outputDirectory }) {
  requireVersion(version);
  const output = resolve(outputDirectory);
  mkdirSync(output, { recursive: true });
  const temporary = mkdtempSync(join(tmpdir(), "leaflogue-convex-package-"));
  const directoryName = `leaflogue-convex-${version}`;
  const staging = join(temporary, directoryName);
  const archiveName = `Leaflogue-Convex-${version}.tar.gz`;
  const manifestName = `Leaflogue-Convex-${version}.manifest.json`;
  const archive = join(output, archiveName);
  const manifestPath = join(output, manifestName);
  try {
    mkdirSync(staging, { recursive: true });
    copyBackendSources(staging);
    const contract = readContractVersions(join(root, "convex/setup.ts"));
    const manifest = {
      format: "leaflogue-convex-backend",
      version,
      schemaVersion: contract.schemaVersion,
      mutationContractVersion: contract.mutationContractVersion,
      node: ">=22.22.2",
      convex: CONVEX_VERSION,
    };
    writeJson(join(staging, "BACKEND_MANIFEST.json"), manifest);
    writeJson(manifestPath, manifest);
    writePackageFiles(staging, version);
    createDeterministicArchive(temporary, directoryName, archive);
    verifyArchive(archive, directoryName);
    writeChecksums(output, [archiveName, manifestName]);
    return { archive, manifest: manifestPath, checksum: join(output, "SHA256SUMS-convex.txt") };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function copyBackendSources(staging) {
  cpSync(join(root, "convex"), join(staging, "convex"), {
    recursive: true,
    filter: (source) => {
      const relative = source.slice(join(root, "convex").length).replaceAll("\\", "/");
      if (relative === "/_generated" || relative.includes("/_generated/")) return false;
      const status = lstatSync(source);
      if (status.isSymbolicLink()) return false;
      if (status.isDirectory()) return true;
      return (relative.endsWith(".ts") || relative === "/tsconfig.json") &&
        !relative.endsWith(".test.ts") && !relative.endsWith("/test.setup.ts");
    },
  });
  cpSync(join(root, "convex.json"), join(staging, "convex.json"));
  cpSync(join(root, "LICENSE"), join(staging, "LICENSE"));
  // Creates the web app's sign-in keys on the deployment (docs: Host the web app with Convex).
  cpSync(join(root, "scripts", "convex-sign-in-keys.mjs"), join(staging, "sign-in-keys.mjs"));
  chmodSync(join(staging, "sign-in-keys.mjs"), 0o755);
  copyLocalPackage("ai", staging);
  copyLocalPackage("catalog", staging);
  copyLocalPackage("contracts", staging);
  copyLocalPackage("domain", staging, { "@leaflogue/contracts": "file:../contracts" });
}

function copyLocalPackage(name, staging, dependencies) {
  const source = join(root, "packages", name);
  const target = join(staging, "packages", name);
  mkdirSync(target, { recursive: true });
  cpSync(join(source, "src"), join(target, "src"), {
    recursive: true,
    filter: (path) => {
      const status = lstatSync(path);
      return !status.isSymbolicLink() && (status.isDirectory() || (path.endsWith(".ts") && !path.endsWith(".test.ts")));
    },
  });
  const packageJson = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  delete packageJson.private;
  delete packageJson.scripts;
  delete packageJson.devDependencies;
  if (dependencies) packageJson.dependencies = dependencies;
  writeJson(join(target, "package.json"), packageJson);
}

function writePackageFiles(staging, version) {
  const packageJson = {
    name: "leaflogue-convex-backend",
    // The release version belongs to BACKEND_MANIFEST.json. Keeping this
    // private deployment package at a fixed version lets every release use the
    // same reviewed, integrity-bearing dependency lock.
    version: RUNTIME_PACKAGE_VERSION,
    private: true,
    type: "module",
    license: "AGPL-3.0-or-later",
    engines: { node: ">=22.22.2" },
    dependencies: {
      "@auth/core": AUTH_CORE_VERSION,
      "@convex-dev/auth": CONVEX_AUTH_VERSION,
      "@leaflogue/ai": "file:packages/ai",
      "@leaflogue/catalog": "file:packages/catalog",
      "@leaflogue/contracts": "file:packages/contracts",
      "@leaflogue/domain": "file:packages/domain",
      convex: CONVEX_VERSION,
    },
  };
  writeJson(join(staging, "package.json"), packageJson);
  copyVerifiedLockfile(staging, packageJson);
  const deploy = `#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if [ "\${1:-}" = "--help" ]; then
  cat <<'EOF'
Usage: ./deploy.sh [--production] [Convex CLI options]

With no mode flag, configure or select a personal development deployment and
push this release once. Use --production for the project's production
deployment; CONVEX_DEPLOYMENT or CONVEX_DEPLOY_KEY must identify that project.
EOF
  exit 0
fi
node -e 'const [major, minor, patch] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && (minor < 22 || (minor === 22 && patch < 2)))) { console.error("Leaflogue Convex deployment requires Node.js 22.22.2 or later."); process.exit(1); }'
npm ci --ignore-scripts --no-audit --no-fund
if [ "\${1:-}" = "--production" ]; then
  shift
  exec npx --no-install convex deploy "$@"
fi
exec npx --no-install convex dev --once "$@"
`;
  writeFileSync(join(staging, "deploy.sh"), deploy, "utf8");
  chmodSync(join(staging, "deploy.sh"), 0o755);
  writeFileSync(join(staging, "README.md"), `# Leaflogue Convex backend ${version}

This release-matched source bundle deploys Leaflogue's Convex functions without
a repository checkout. Verify the adjacent checksum manifest, extract this
archive, then run:

\`\`\`sh
./${directoryNameFor(version)}/deploy.sh
\`\`\`

The default command interactively creates or selects a personal development
deployment and pushes once. Use \`./${directoryNameFor(version)}/deploy.sh
--production\` for a project's production deployment after selecting that
project or setting \`CONVEX_DEPLOY_KEY\`. The command requires Node.js 22.22.2
or later, installs the lockfile-pinned Convex CLI locally, and never asks for
Leaflogue's desktop sync key. Configure or rotate that key separately after
deployment:

\`\`\`sh
# Development deployment
npx convex env set LEAFLOGUE_SYNC_KEY ...

# Production deployment
npx convex env set --prod LEAFLOGUE_SYNC_KEY ...
\`\`\`
`, "utf8");
}

function copyVerifiedLockfile(staging, packageJson) {
  const lock = JSON.parse(readFileSync(LOCKFILE, "utf8"));
  const rootPackage = lock.packages?.[""];
  if (lock.lockfileVersion !== 3 || rootPackage?.version !== RUNTIME_PACKAGE_VERSION ||
      JSON.stringify(rootPackage.dependencies) !== JSON.stringify(packageJson.dependencies) ||
      rootPackage.engines?.node !== packageJson.engines.node) {
    throw new Error("Convex backend dependency lock does not match its deployment package");
  }
  cpSync(LOCKFILE, join(staging, "package-lock.json"));
}

/**
 * Write a ustar archive directly so the bytes do not depend on which `tar` a
 * platform ships (GNU tar's `--sort` is missing from macOS's bsdtar). Entries
 * are sorted, owned by 0:0 with empty names, dated at the epoch, and limited
 * to 0755 directories/executables and 0644 files. The gzip header carries no
 * name or time and a fixed Unix OS byte, so identical inputs give identical
 * archives on every platform.
 */
function createDeterministicArchive(parent, directoryName, archive) {
  const blocks = [];
  const visit = (relative) => {
    const absolute = join(parent, relative);
    const status = lstatSync(absolute);
    if (status.isSymbolicLink()) throw new Error(`Convex backend bundle must not contain symlinks: ${relative}`);
    if (status.isDirectory()) {
      blocks.push(tarHeader(`${relative}/`, 0o755, 0, "5"));
      for (const name of readdirSync(absolute).sort()) visit(`${relative}/${name}`);
      return;
    }
    if (!status.isFile()) throw new Error(`Convex backend bundle contains an unsupported entry: ${relative}`);
    const content = readFileSync(absolute);
    blocks.push(tarHeader(relative, status.mode & 0o111 ? 0o755 : 0o644, content.length, "0"), content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding) blocks.push(Buffer.alloc(padding));
  };
  visit(directoryName);
  blocks.push(Buffer.alloc(1024));
  const compressed = gzipSync(Buffer.concat(blocks), { level: 9 });
  compressed[9] = 3;
  writeFileSync(archive, compressed);
}

function tarHeader(path, mode, size, type) {
  const header = Buffer.alloc(512);
  let name = path;
  let prefix = "";
  if (Buffer.byteLength(name) > 100) {
    const split = path.lastIndexOf("/", path.length - 2);
    prefix = path.slice(0, split);
    name = path.slice(split + 1);
    if (split < 0 || Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) {
      throw new Error(`Convex backend path is too long for a ustar archive: ${path}`);
    }
  }
  const field = (value, offset, length) => header.write(value, offset, length, "utf8");
  const octal = (value, offset, length) => field(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length);
  field(name, 0, 100);
  octal(mode, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(0, 136, 12);
  field("        ", 148, 8);
  field(type, 156, 1);
  field("ustar\0", 257, 6);
  field("00", 263, 2);
  field(prefix, 345, 155);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  field(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return header;
}

function verifyArchive(archive, directoryName) {
  const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
  const required = [
    `${directoryName}/BACKEND_MANIFEST.json`,
    `${directoryName}/convex.json`,
    `${directoryName}/convex/schema.ts`,
    `${directoryName}/convex/setup.ts`,
    `${directoryName}/deploy.sh`,
    `${directoryName}/sign-in-keys.mjs`,
    `${directoryName}/package-lock.json`,
    `${directoryName}/packages/contracts/src/index.ts`,
    `${directoryName}/packages/domain/src/index.ts`,
  ];
  if (required.some((entry) => !entries.includes(entry))) throw new Error("Convex backend archive is incomplete");
  const unintended = entries.find((entry) => entry.startsWith("/") || entry.split("/").includes("..") ||
    entry.includes("node_modules") || entry.endsWith(".test.ts") || entry.includes("/_generated/"));
  if (unintended) throw new Error(`Convex backend archive contains an unsafe or unintended path: ${unintended}`);
}

function writeChecksums(output, names) {
  const lines = names.sort().map((name) => {
    const digest = createHash("sha256").update(readFileSync(join(output, name))).digest("hex");
    return `${digest}  ${name}`;
  });
  writeFileSync(join(output, "SHA256SUMS-convex.txt"), `${lines.join("\n")}\n`, "utf8");
}

function readContractVersions(path) {
  const source = readFileSync(path, "utf8");
  const number = (name) => {
    const match = source.match(new RegExp(`${name}: (\\d+)`));
    if (!match) throw new Error(`Could not read ${name} from convex/setup.ts`);
    return Number(match[1]);
  };
  return { schemaVersion: number("schemaVersion"), mutationContractVersion: number("mutationContractVersion") };
}

function requireVersion(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u.test(value)) {
    throw new Error("Convex backend version must be a semantic version without a leading v");
  }
}

function directoryNameFor(version) {
  return `leaflogue-convex-${version}`;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--version" || argument === "--output") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      result[argument.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!result.version) throw new Error("--version is required");
  return { version: result.version, outputDirectory: result.output ?? join(root, "release", "convex") };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = packageConvexBackend(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${result.archive}\n${result.manifest}\n${result.checksum}\n`);
}
