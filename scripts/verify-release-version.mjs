import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;

export function verifyReleaseVersion({ tag, desktopVersion, lockedDesktopVersion }) {
  if (typeof tag !== "string" || !tag.startsWith("v") || !SEMVER.test(tag.slice(1))) {
    throw new Error("Release tag must be v followed by a semantic version");
  }
  if (desktopVersion !== lockedDesktopVersion) {
    throw new Error(`Desktop package version ${desktopVersion} does not match lockfile version ${lockedDesktopVersion}`);
  }
  if (tag !== `v${desktopVersion}`) {
    throw new Error(`Release tag ${tag} does not match desktop package version ${desktopVersion}`);
  }
  return desktopVersion;
}

function verifyRepository(tag) {
  const desktop = JSON.parse(readFileSync(resolve(root, "apps/desktop/package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));
  return verifyReleaseVersion({
    tag,
    desktopVersion: desktop.version,
    lockedDesktopVersion: lock.packages?.["apps/desktop"]?.version,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2];
  const version = verifyRepository(tag);
  process.stdout.write(`${version}\n`);
}
