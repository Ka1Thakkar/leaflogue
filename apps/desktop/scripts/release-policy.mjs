import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIRECTORY = resolve(SCRIPT_DIRECTORY, "..");

function containsPublishConfiguration(value) {
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => key === "publish" || containsPublishConfiguration(child));
}

export function assertManualReleasePolicy(manifest, packageLock, mainProcessSources) {
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies
  };

  const lockPackages = JSON.parse(packageLock).packages ?? {};
  if ("electron-updater" in dependencies || Object.keys(lockPackages).some((key) => key === "node_modules/electron-updater" || key.endsWith("/node_modules/electron-updater"))) {
    throw new Error("Automatic update dependency electron-updater is prohibited by the release policy");
  }
  if (containsPublishConfiguration(manifest.build)) {
    throw new Error("electron-builder publish configuration is prohibited by the release policy");
  }
  if (manifest.build?.extends !== undefined) throw new Error("electron-builder extends configuration is prohibited by the release policy");
  if (mainProcessSources.some((source) => /\bautoUpdater\b/.test(source))) {
    throw new Error("Electron autoUpdater usage is prohibited by the release policy");
  }
}

export async function verifyManualReleasePolicy() {
  const mainDirectory = join(DESKTOP_DIRECTORY, "src/main");
  const [mainEntries, desktopEntries] = await Promise.all([
    readdir(mainDirectory, { recursive: true }),
    readdir(DESKTOP_DIRECTORY)
  ]);
  if (desktopEntries.some((entry) => /^electron-builder\.(c?js|json5?|toml|ts|ya?ml)$/.test(entry))) {
    throw new Error("External electron-builder configuration is prohibited by the release policy");
  }
  const [manifestContents, packageLock, ...mainProcessSources] = await Promise.all([
    readFile(join(DESKTOP_DIRECTORY, "package.json"), "utf8"),
    readFile(join(DESKTOP_DIRECTORY, "../../package-lock.json"), "utf8"),
    ...mainEntries.filter((entry) => entry.endsWith(".ts")).map((entry) => readFile(join(mainDirectory, entry), "utf8"))
  ]);
  assertManualReleasePolicy(JSON.parse(manifestContents), packageLock, mainProcessSources);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  verifyManualReleasePolicy()
    .then(() => process.stdout.write("Verified explicit-install release policy\n"))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
      process.exitCode = 1;
    });
}
