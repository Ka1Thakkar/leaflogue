import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIRECTORY = resolve(SCRIPT_DIRECTORY, "..");
const REPOSITORY_DIRECTORY = resolve(DESKTOP_DIRECTORY, "../..");
export const NOTICES_PATH = join(DESKTOP_DIRECTORY, "out", "legal", "THIRD_PARTY_NOTICES.md");

/**
 * Licences whose terms are compatible with distributing Leaflogue under
 * AGPL-3.0-or-later. Anything else stops the build for an explicit review.
 */
export const ALLOWED_LICENSES = new Set([
  "0BSD", "Apache-2.0", "BlueOak-1.0.0", "BSD-2-Clause", "BSD-3-Clause", "CC0-1.0", "ISC", "MIT", "OFL-1.1",
]);
const PROJECT_LICENSE = "AGPL-3.0-or-later";
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.[a-z]+)?$/iu;

/** Flatten an `npm ls --json --long` tree into unique installed packages. */
export function collectPackages(tree) {
  const packages = new Map();
  const visit = (node) => {
    for (const [name, dependency] of Object.entries(node.dependencies ?? {})) {
      // Uninstalled optional or peer dependencies are not shipped.
      if (!dependency.version || dependency.missing || !dependency.path) continue;
      const key = `${name}@${dependency.version}`;
      if (packages.has(key)) continue;
      packages.set(key, { name, version: dependency.version, license: dependency.license, path: dependency.path, repository: dependency.repository });
      visit(dependency);
    }
  };
  visit(tree);
  return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** Leaflogue's own workspace packages carry the project licence. */
export function isProjectPackage(entry) {
  return entry.name.startsWith("@leaflogue/");
}

export function assertAllowedLicenses(packages) {
  const problems = packages
    .filter((entry) => !isProjectPackage(entry))
    .filter((entry) => typeof entry.license !== "string" || !ALLOWED_LICENSES.has(entry.license))
    .map((entry) => `${entry.name}@${entry.version} (${typeof entry.license === "string" ? entry.license : "no licence declared"})`);
  if (problems.length > 0) {
    throw new Error(`Dependencies need a licence review before distribution: ${problems.join(", ")}`);
  }
}

function repositoryUrl(repository) {
  const value = typeof repository === "string" ? repository : repository?.url;
  return typeof value === "string" ? value.replace(/^git\+/u, "").replace(/\.git$/u, "") : undefined;
}

export function renderNotices(entries) {
  const lines = [
    "# Third-party notices",
    "",
    `Leaflogue is licensed under ${PROJECT_LICENSE}; see LICENSE. It includes the`,
    "third-party software below. Electron's own licence and Chromium's notices are",
    "distributed beside the application by Electron.",
    "",
  ];
  for (const entry of entries) {
    lines.push(`## ${entry.name} ${entry.version}`, "", `Licence: ${entry.license}`);
    const url = repositoryUrl(entry.repository);
    if (url) lines.push(`Source: ${url}`);
    lines.push("");
    if (entry.text) {
      lines.push("```text", entry.text.trimEnd().replace(/```/gu, "'''"), "```", "");
    } else {
      lines.push(`This package does not include a separate licence file; it is distributed under ${entry.license}.`, "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

async function readLicenseText(path) {
  const files = (await readdir(path)).filter((name) => LICENSE_FILE.test(name)).sort();
  if (files.length === 0) return undefined;
  const texts = await Promise.all(files.map((name) => readFile(join(path, name), "utf8")));
  return texts.map((text) => text.replace(/[ \t]+$/gmu, "")).join("\n\n");
}

export async function generateNotices({ output = NOTICES_PATH } = {}) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("Generate notices through npm run build so the pinned npm CLI is available");
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [npmCli, "ls", "--omit=dev", "--all", "--json", "--long", "--workspace", "@leaflogue/desktop"],
    { cwd: REPOSITORY_DIRECTORY, maxBuffer: 64 * 1024 * 1024 },
  );
  const packages = collectPackages(JSON.parse(stdout));
  assertAllowedLicenses(packages);
  const thirdParty = await Promise.all(packages
    .filter((entry) => !isProjectPackage(entry))
    .map(async (entry) => ({ ...entry, text: await readLicenseText(entry.path) })));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, renderNotices(thirdParty), { mode: 0o644 });
  return { packages: thirdParty.length, output };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateNotices().then(({ packages, output }) => {
    process.stdout.write(`Wrote notices for ${packages} third-party packages to ${output}\n`);
  }, (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
