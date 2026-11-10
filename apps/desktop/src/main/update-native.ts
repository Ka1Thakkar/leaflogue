import { execFile, spawn } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, lstat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { UpdateManifest } from "./update-manifest";

function run(command: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout) => error ? reject(new Error("Native update preparation failed", { cause: error })) : resolve({ stdout }));
  });
}

/** Arguments are passed as argv, never interpolated into shell source. */
export const MAC_UPDATE_HELPER = `#!/bin/sh
set -eu
parent="$1"
staged="$2"
target="$3"
backup="$4"
work="$5"
shift 5
count=0
while kill -0 "$parent" 2>/dev/null; do
  count=$((count + 1))
  if [ "$count" -gt 300 ]; then exit 1; fi
  sleep 0.2
done
if [ -e "$backup" ] || [ -L "$backup" ]; then exit 1; fi
mv "$target" "$backup" || exit 1
if ! mv "$staged" "$target"; then
  mv "$backup" "$target"
  /usr/bin/open "$target" --args "$@"
  exit 1
fi
if ! /usr/bin/open "$target" --args "$@"; then
  mv "$target" "$staged"
  mv "$backup" "$target"
  /usr/bin/open "$target" --args "$@"
  exit 1
fi
rm -rf "$backup"
rm -rf "$work"
`;

export const WINDOWS_UPDATE_HELPER = String.raw`param([string]$ConfigPath)
$ErrorActionPreference = 'Stop'
$cfg = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
function Quote-Argument([string]$value) {
  $escaped = [regex]::Replace($value, '(\\*)"', '$1$1\"')
  $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
  return '"' + $escaped + '"'
}
function Restart-Leaflogue {
  if (@($cfg.args).Count -gt 0) {
    $arguments = (@($cfg.args) | ForEach-Object { Quote-Argument $_ }) -join ' '
    Start-Process -FilePath $cfg.executable -ArgumentList $arguments
  } else {
    Start-Process -FilePath $cfg.executable
  }
}
try {
  Wait-Process -Id $cfg.parent -Timeout 60 -ErrorAction SilentlyContinue
  if (Get-Process -Id $cfg.parent -ErrorAction SilentlyContinue) { exit 1 }
  # NSIS /D consumes everything after it, including spaces, without quotes.
  $install = Start-Process -FilePath $cfg.installer -ArgumentList ('/S --updated /D=' + $cfg.directory) -PassThru -Wait -WindowStyle Hidden
  if ($install.ExitCode -ne 0) { throw 'Leaflogue upgrade failed' }
  Restart-Leaflogue
  Remove-Item -LiteralPath $cfg.work -Recurse -Force -ErrorAction SilentlyContinue
} catch {
  'The update could not be installed; restart the existing copy.' | Set-Content -LiteralPath (Join-Path $cfg.work 'failure.txt')
  if (Test-Path -LiteralPath $cfg.executable) { Restart-Leaflogue }
  exit 1
}
`;

function detached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

export interface NativeUpdateOptions {
  readonly platform: NodeJS.Platform;
  readonly executable: string;
  readonly quit: () => void;
  readonly args?: readonly string[];
  readonly pid?: number;
}

/** The native installation must be a writable app bundle or a per-user NSIS install. */
export function nativeUpdateUnavailable(options: NativeUpdateOptions): "unsupported-installation" | undefined {
  if (options.platform === "darwin") {
    const app = dirname(dirname(dirname(options.executable)));
    if (!app.endsWith(".app") || app.startsWith("/Volumes/") || app.includes("/AppTranslocation/")) return "unsupported-installation";
  } else if (options.platform === "win32") {
    if (!existsSync(join(dirname(options.executable), "Uninstall Leaflogue.exe"))) return "unsupported-installation";
  } else return "unsupported-installation";
  return undefined;
}

/** Called only after the download's exact bytes pass the signed size and hash checks. */
export async function installNativeUpdate(download: string, manifest: UpdateManifest, options: NativeUpdateOptions): Promise<void> {
  if (nativeUpdateUnavailable(options)) throw new Error("Install Leaflogue in Applications or with the Windows installer before using in-app updates");
  if (options.platform === "win32" && manifest.platform === "windows") {
    // NSIS waits for the old process, performs the per-user upgrade without a
    // wizard, and restarts. /D must be the final argument for NSIS parsing.
    const work = dirname(download);
    const helper = join(work, "install.ps1");
    const config = join(work, "install.json");
    await access(dirname(options.executable), constants.W_OK);
    await writeFile(helper, WINDOWS_UPDATE_HELPER, { mode: 0o600, flag: "wx" });
    await writeFile(config, JSON.stringify({ parent: options.pid ?? process.pid, installer: download, executable: options.executable, directory: dirname(options.executable), args: options.args ?? [], work }), { mode: 0o600, flag: "wx" });
    const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    await detached(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, config]);
    options.quit();
    return;
  }
  if (options.platform !== "darwin" || manifest.platform !== "mac") throw new Error("Update platform differs from this installation");
  const target = dirname(dirname(dirname(options.executable)));
  const installed = await lstat(target);
  if (!installed.isDirectory() || installed.isSymbolicLink()) throw new Error("Installed app is not a regular bundle");
  await access(dirname(target), constants.W_OK);
  const work = dirname(download);
  const staged = join(work, "Leaflogue.app");
  await run("/usr/bin/ditto", ["-x", "-k", download, work]);
  const info = await lstat(staged);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Update contains no regular app bundle");
  const plist = join(staged, "Contents", "Info.plist");
  const [identifier, version] = await Promise.all([
    run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plist]),
    run("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist]),
  ]);
  if (identifier.stdout.trim() !== "dev.leaflogue.desktop" || version.stdout.trim() !== manifest.version) throw new Error("Update bundle identity or version differs from its signed manifest");
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", staged]);
  await run("/usr/bin/lipo", ["-verify_arch", manifest.architecture === "x64" ? "x86_64" : "arm64", join(staged, "Contents", "MacOS", "Leaflogue")]);
  // Move onto the same filesystem first so the post-exit swap is atomic even
  // when the user's temporary folder and Applications are on different disks.
  const sibling = join(dirname(target), `.${basename(work)}.app`);
  await run("/usr/bin/ditto", [staged, sibling]);
  const helper = join(work, "install.sh");
  await writeFile(helper, MAC_UPDATE_HELPER, { mode: 0o700, flag: "wx" });
  try {
    await detached("/bin/sh", [helper, String(options.pid ?? process.pid), sibling, target, `${sibling}.previous`, work, ...(options.args ?? [])]);
  } catch (error) {
    // Only the random sibling copy is disposable; the running app is untouched.
    const { rm } = await import("node:fs/promises");
    await rm(sibling, { recursive: true, force: true });
    throw error;
  }
  options.quit();
}
