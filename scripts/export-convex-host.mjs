#!/usr/bin/env node
/**
 * Copy Leaflogue's Convex backend into another Convex app (a "host"), so one
 * deployment serves both that app and Leaflogue's desktop sync.
 *
 *   node scripts/export-convex-host.mjs <host-project> [--packages <dir>] [--ui-only]
 *
 * Leaflogue's modules go into <host-project>/convex/ under their own names
 * (the desktop calls functions such as `syncRuntime:pull` by name), except
 * schema.ts and auth.config.ts, which belong to the host: its schema spreads
 * `leaflogueTables` from tables.ts, and its auth config is its own. The two
 * packages the modules import are copied to <host-project>/<dir> (default
 * vendor/leaflogue), for the host to depend on with `file:` paths.
 *
 * A manifest (convex/leaflogue-backend.json) lists what was copied, so a
 * later export replaces exactly those files, removes ones Leaflogue no longer
 * has, and never overwrites a host file that shares a Leaflogue module's name.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = "leaflogue-backend.json";
/** Files a host owns and Leaflogue must never write. */
const HOST_OWNED = new Set(["schema.ts", "auth.config.ts", "auth.ts", "http.ts", "crons.ts"]);
/**
 * Files Leaflogue supplies a default for that a host may replace with its own
 * (see hostIdentity.ts). A host's copy is kept; Leaflogue's is written only
 * where the host has none or still has the one Leaflogue wrote.
 */
const HOST_OVERRIDABLE = new Set(["hostIdentity.ts"]);

/** Refresh only the interface, without advancing the host's backend or schema. */
export function exportUiHost({ hostProject, packagesDirectory = "vendor/leaflogue" }) {
  const host = resolve(hostProject);
  if (!existsSync(join(host, "package.json"))) throw new Error(`${host} is not a project (no package.json)`);
  copyPackage("ui", join(host, packagesDirectory));
  copyPackage("appearance", join(host, packagesDirectory), { "@leaflogue/contracts": "file:../contracts" });
}

export function exportConvexHost({ hostProject, packagesDirectory = "vendor/leaflogue" }) {
  const host = resolve(hostProject);
  if (!existsSync(join(host, "package.json"))) throw new Error(`${host} is not a project (no package.json)`);
  const hostConvex = join(host, "convex");
  mkdirSync(hostConvex, { recursive: true });

  const previous = readPreviousManifest(join(hostConvex, MANIFEST));
  const modules = readdirSync(join(root, "convex")).filter((name) => {
    const path = join(root, "convex", name);
    return lstatSync(path).isFile() && name.endsWith(".ts") && !name.endsWith(".test.ts") &&
      name !== "test.setup.ts" && !HOST_OWNED.has(name);
  }).sort();

  const hostOverrides = modules.filter((name) => HOST_OVERRIDABLE.has(name) &&
    existsSync(join(hostConvex, name)) && !previous.files.includes(name));
  const copied = modules.filter((name) => !hostOverrides.includes(name));

  // Refuse before writing anything if a host module would be overwritten.
  const clashes = copied.filter((name) => existsSync(join(hostConvex, name)) && !previous.files.includes(name));
  if (clashes.length) {
    throw new Error(`The host already has its own ${clashes.join(", ")} in convex/. Rename or move them first: Leaflogue's modules must keep their names.`);
  }

  for (const name of previous.files) {
    if (!copied.includes(name)) rmSync(join(hostConvex, name), { force: true });
  }
  for (const name of copied) cpSync(join(root, "convex", name), join(hostConvex, name));

  const packages = join(host, packagesDirectory);
  copyPackage("ai", packages);
  copyPackage("appearance", packages, { "@leaflogue/contracts": "file:../contracts" });
  copyPackage("catalog", packages);
  copyPackage("contracts", packages);
  copyPackage("domain", packages, { "@leaflogue/contracts": "file:../contracts" });
  // Not used by the Convex modules: a host's browser import parses files with it.
  copyPackage("importers", packages, { "@leaflogue/contracts": "file:../contracts", "@leaflogue/domain": "file:../domain" });
  // The shared interface: a web host draws the same header, rail, panels, and charts as the desktop.
  copyPackage("ui", packages);

  const versions = readContractVersions(join(root, "convex/setup.ts"));
  const manifest = {
    format: "leaflogue-convex-host",
    version: JSON.parse(readFileSync(join(root, "apps/desktop/package.json"), "utf8")).version,
    schemaVersion: versions.schemaVersion,
    mutationContractVersion: versions.mutationContractVersion,
    files: copied,
    hostOverrides,
    packages: {
      "@leaflogue/ai": `file:${relative(host, join(packages, "ai"))}`,
      "@leaflogue/appearance": `file:${relative(host, join(packages, "appearance"))}`,
      "@leaflogue/catalog": `file:${relative(host, join(packages, "catalog"))}`,
      "@leaflogue/contracts": `file:${relative(host, join(packages, "contracts"))}`,
      "@leaflogue/domain": `file:${relative(host, join(packages, "domain"))}`,
      "@leaflogue/importers": `file:${relative(host, join(packages, "importers"))}`,
      "@leaflogue/ui": `file:${relative(host, join(packages, "ui"))}`,
    },
  };
  writeFileSync(join(hostConvex, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function readPreviousManifest(path) {
  if (!existsSync(path)) return { files: [] };
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (parsed.format !== "leaflogue-convex-host" || !Array.isArray(parsed.files)) {
    throw new Error(`${path} is not a Leaflogue export manifest`);
  }
  return { files: parsed.files.filter((name) => typeof name === "string" && /^[A-Za-z0-9.]+\.ts$/u.test(name)) };
}

function copyPackage(name, packages, dependencies) {
  const source = join(root, "packages", name);
  const target = join(packages, name);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(join(source, "src"), join(target, "src"), {
    recursive: true,
    filter: (path) => {
      const status = lstatSync(path);
      return !status.isSymbolicLink() && (status.isDirectory() || (/\.(ts|tsx|css)$/u.test(path) && !/\.test\.tsx?$/u.test(path)));
    },
  });
  const packageJson = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  delete packageJson.private;
  delete packageJson.scripts;
  delete packageJson.devDependencies;
  if (dependencies) packageJson.dependencies = dependencies;
  writeFileSync(join(target, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
}

function readContractVersions(path) {
  const source = readFileSync(path, "utf8");
  const schemaVersion = Number(/schemaVersion: (\d+)/u.exec(source)?.[1]);
  const mutationContractVersion = Number(/mutationContractVersion: (\d+)/u.exec(source)?.[1]);
  if (!Number.isSafeInteger(schemaVersion) || !Number.isSafeInteger(mutationContractVersion)) {
    throw new Error("Could not read the backend's schema and mutation contract versions from convex/setup.ts");
  }
  return { schemaVersion, mutationContractVersion };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const hostProject = args.find((arg) => !arg.startsWith("--"));
  const packagesIndex = args.indexOf("--packages");
  if (!hostProject) {
    console.error("Usage: node scripts/export-convex-host.mjs <host-project> [--packages <dir>] [--ui-only]");
    process.exit(2);
  }
  try {
    if (args.includes("--ui-only")) {
      exportUiHost({ hostProject, ...(packagesIndex >= 0 && args[packagesIndex + 1] ? { packagesDirectory: args[packagesIndex + 1] } : {}) });
      console.log("Updated shared UI and appearance. Backend modules and schema were left unchanged.");
      process.exit(0);
    }
    const manifest = exportConvexHost({
      hostProject,
      ...(packagesIndex >= 0 && args[packagesIndex + 1] ? { packagesDirectory: args[packagesIndex + 1] } : {}),
    });
    console.log(`Copied ${manifest.files.length} Leaflogue modules (schema ${manifest.schemaVersion}, contract ${manifest.mutationContractVersion}).`);
    console.log("Add these to the host's package.json dependencies:");
    for (const [name, path] of Object.entries(manifest.packages)) console.log(`  "${name}": "${path}"`);
    console.log('Then spread `leaflogueTables` from "./tables" into the host\'s defineSchema.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
