import { execFile, spawn, type ChildProcess } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, lstat, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { compareVersions, type UpdateManifest } from "./update-manifest";

function run(command: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout) => error ? reject(new Error("Native update preparation failed", { cause: error })) : resolve({ stdout }));
  });
}

/**
 * Arguments are passed as argv, never interpolated into shell source.
 *
 * The previous bundle is kept as "$backup" until the new app reports a healthy
 * start by creating "$marker" (see markNativeUpdateHealthy). If the new app
 * stops without doing so, the previous bundle is put back and opened. If it is
 * still running but not yet healthy when the wait ends, the copy is left for
 * the app's own launch check (checkNativeUpdateStartup). An empty "$marker"
 * keeps the old behaviour: delete the previous bundle once open succeeds.
 */
export const MAC_UPDATE_HELPER = `#!/bin/sh
set -eu
parent="$1"
staged="$2"
target="$3"
backup="$4"
work="$5"
marker="$6"
shift 6
# Whether the new app's main process has gone. An unreadable process list
# counts as still running, so doubt never triggers a restore.
app_stopped() {
  processes=$(/bin/ps -axo comm= 2>/dev/null) || return 1
  if printf '%s\\n' "$processes" | /usr/bin/grep -F -x -q -- "$target/Contents/MacOS/Leaflogue"; then return 1; fi
  return 0
}
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
if [ -n "$marker" ]; then
  grace=25
  limit=600
  waited=0
  while [ ! -e "$marker" ] && [ -d "$backup" ]; do
    waited=$((waited + 1))
    if [ "$waited" -gt "$grace" ] && app_stopped; then
      # The new app quit or crashed before it reported a healthy start.
      rm -rf "$backup.failed"
      mv "$target" "$backup.failed" || exit 1
      if ! mv "$backup" "$target"; then
        mv "$backup.failed" "$target"
        exit 1
      fi
      /usr/bin/open "$target" --args "$@" || true
      rm -rf "$backup.failed"
      rm -rf "$work"
      exit 1
    fi
    # Still running, not yet healthy: its next launch decides.
    if [ "$waited" -gt "$limit" ]; then exit 0; fi
    sleep 0.2
  done
  rm -f "$marker"
fi
rm -rf "$backup"
rm -rf "$work"
`;

/**
 * Puts the kept previous bundle back after this app exits, then opens it. The
 * update record stays: the previous version reads it on start to check the
 * library (checkNativeUpdateStartup) and then removes it.
 */
export const MAC_ROLLBACK_HELPER = `#!/bin/sh
set -eu
parent="$1"
target="$2"
backup="$3"
shift 3
count=0
while kill -0 "$parent" 2>/dev/null; do
  count=$((count + 1))
  if [ "$count" -gt 300 ]; then exit 1; fi
  sleep 0.2
done
if [ ! -d "$backup" ] || [ -L "$backup" ]; then exit 1; fi
rm -rf "$backup.failed"
mv "$target" "$backup.failed" || exit 1
if ! mv "$backup" "$target"; then
  mv "$backup.failed" "$target"
  exit 1
fi
/usr/bin/open "$target" --args "$@" || true
rm -rf "$backup.failed"
`;

export const WINDOWS_UPDATE_HELPER = String.raw`param([string]$ConfigPath)
$ErrorActionPreference = 'Stop'
$cfg = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
function Quote-Argument([string]$value) {
  $escaped = [regex]::Replace($value, '(\\*)"', '$1$1\"')
  $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
  return '"' + $escaped + '"'
}
function Write-State([string]$phase) {
  Set-Content -LiteralPath (Join-Path $cfg.work 'state.txt') -Value $phase -Encoding UTF8
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
  # Capture the process identity before telling the app it may quit.
  $parentProcess = Get-Process -Id $cfg.parent -ErrorAction SilentlyContinue
  if ($parentProcess) { $null = $parentProcess.Handle }
  Write-State 'waiting-for-app-exit'
  if ($parentProcess -and -not $parentProcess.WaitForExit(60000)) {
    throw 'The application did not exit within 60 seconds'
  }
  # NSIS /D consumes everything after it, including spaces, without quotes.
  Write-State 'installing'
  $install = Start-Process -FilePath $cfg.installer -ArgumentList ('/S /currentuser --updated /D=' + $cfg.directory) -PassThru -WindowStyle Hidden
  # -Wait waits for the entire descendant tree. Wait for the installer itself,
  # not unrelated long-lived processes started by Windows shell integration.
  $null = $install.Handle
  $install.WaitForExit()
  if ($install.ExitCode -ne 0) { throw 'Leaflogue upgrade failed' }
  Write-State 'restarting'
  Restart-Leaflogue
  Write-State 'complete'
  Remove-Item -LiteralPath $cfg.work -Recurse -Force -ErrorAction SilentlyContinue
} catch {
  $_.Exception.Message | Set-Content -LiteralPath (Join-Path $cfg.work 'failure.txt') -Encoding UTF8
  if (Test-Path -LiteralPath $cfg.executable) { Restart-Leaflogue }
  exit 1
}
`;

export async function launchUpdateHelper(command: string, args: string[], logFile?: string): Promise<ChildProcess> {
  const log = logFile ? await open(logFile, "wx", 0o600) : undefined;
  try {
    return await new Promise<ChildProcess>((resolve, reject) => {
      // Windows PowerShell can exit successfully without executing -File under
      // DETACHED_PROCESS. unref + independent stdio allow it to outlive the app.
      const child = spawn(command, args, { detached: process.platform !== "win32", stdio: ["ignore", log?.fd ?? "ignore", log?.fd ?? "ignore"], windowsHide: true });
      child.once("error", reject);
      child.once("spawn", () => { child.unref(); resolve(child); });
    });
  } finally { await log?.close(); }
}

export interface NativeUpdateOptions {
  readonly platform: NodeJS.Platform;
  readonly executable: string;
  readonly quit: () => void;
  readonly args?: readonly string[];
  readonly pid?: number;
  /**
   * Where a Mac update records the kept previous bundle until the new version
   * reports a healthy start. Without it the previous bundle is deleted as soon
   * as the new one opens.
   */
  readonly healthDirectory?: string;
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
    // The installer overwrites the installation in place by design, so there is
    // no previous copy to keep for rollback as on macOS. A failed start is
    // recovered by installing the previous release; library data stays safe
    // through the pre-migration snapshot.
    const work = dirname(download);
    const helper = join(work, "install.ps1");
    const config = join(work, "install.json");
    await access(dirname(options.executable), constants.W_OK);
    await writeFile(helper, WINDOWS_UPDATE_HELPER, { mode: 0o600, flag: "wx" });
    await writeFile(config, JSON.stringify({ parent: options.pid ?? process.pid, installer: download, executable: options.executable, directory: dirname(options.executable), args: options.args ?? [], work }), { mode: 0o600, flag: "wx" });
    const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const helperProcess = await launchUpdateHelper(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, config], join(work, "helper.log"));
    // Creating a process does not establish that its script initialized.
    // Keep the app open unless the helper confirms it is ready for app exit.
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = await readFile(join(work, "state.txt"), "utf8").catch(() => "");
      if (state.trim() === "waiting-for-app-exit") { ready = true; break; }
      if (helperProcess.exitCode !== null || helperProcess.signalCode !== null) break;
      await delay(100);
    }
    if (!ready) { helperProcess.kill(); throw new Error("The Windows update helper did not initialize; Leaflogue will stay open"); }
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
  // -verify_arch takes a variable number of architectures; older Xcode
  // versions require the input file before that option.
  await run("/usr/bin/lipo", [join(staged, "Contents", "MacOS", "Leaflogue"), "-verify_arch", manifest.architecture === "x64" ? "x86_64" : "arm64"]);
  // Move onto the same filesystem first so the post-exit swap is atomic even
  // when the user's temporary folder and Applications are on different disks.
  const sibling = join(dirname(target), `.${basename(work)}.app`);
  await run("/usr/bin/ditto", [staged, sibling]);
  const helper = join(work, "install.sh");
  await writeFile(helper, MAC_UPDATE_HELPER, { mode: 0o700, flag: "wx" });
  const backup = `${sibling}.previous`;
  const health = options.healthDirectory;
  if (health) {
    await mkdir(health, { recursive: true, mode: 0o700 });
    await rm(join(health, HEALTH_MARKER), { force: true });
    const record: PendingNativeUpdate = { version: manifest.version, target, backup, installedAt: Date.now(), launches: 0 };
    await writeFile(join(health, PENDING_RECORD), JSON.stringify(record), { mode: 0o600 });
  }
  try {
    await launchUpdateHelper("/bin/sh", [helper, String(options.pid ?? process.pid), sibling, target, backup, work, health ? join(health, HEALTH_MARKER) : "", ...(options.args ?? [])]);
  } catch (error) {
    // Only the random sibling copy is disposable; the running app is untouched.
    await rm(sibling, { recursive: true, force: true });
    if (health) await rm(join(health, PENDING_RECORD), { force: true });
    throw error;
  }
  options.quit();
}

/** The previous Mac bundle kept until the new version starts healthily. */
export interface PendingNativeUpdate {
  readonly version: string;
  readonly target: string;
  readonly backup: string;
  readonly installedAt: number;
  /** Starts of this version that have not yet reported healthy. */
  readonly launches: number;
}

const PENDING_RECORD = "native-update.json";
const HEALTH_MARKER = "native-update.healthy";
const ROLLBACK_HELPER = "native-update-rollback.sh";
const ROLLBACK_NOTICE = "native-update-notice.json";
/** Two starts that never became healthy are enough; the third goes back. */
export const MAX_UNHEALTHY_LAUNCHES = 2;

export interface UpdateHealthFiles {
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string, mode: number): Promise<void>;
  remove(path: string): Promise<void>;
  isDirectory(path: string): Promise<boolean>;
}

const realFiles: UpdateHealthFiles = {
  readFile: (path) => readFile(path, "utf8"),
  writeFile: (path, data, mode) => writeFile(path, data, { mode }),
  remove: (path) => rm(path, { recursive: true, force: true }),
  isDirectory: async (path) => {
    try { const info = await lstat(path); return info.isDirectory() && !info.isSymbolicLink(); }
    catch { return false; }
  },
};

export interface UpdateHealthEnvironment {
  readonly platform: NodeJS.Platform;
  readonly directory: string;
  readonly version: string;
  readonly executable: string;
  readonly files?: UpdateHealthFiles;
}

/** Mirrors LibraryRollbackRecovery from @leaflogue/storage. */
export type LibraryRollbackOutcome =
  | { readonly outcome: "not-needed" }
  | { readonly outcome: "restored"; readonly setAsidePath: string }
  | { readonly outcome: "kept-newer" };

export interface UpdateStartupEnvironment extends UpdateHealthEnvironment {
  readonly pid: number;
  readonly args: readonly string[];
  readonly quit: () => void;
  readonly launchHelper?: (command: string, args: string[]) => Promise<unknown>;
  /**
   * Runs before the library opens when this older version is running again
   * after an update was undone. The newer version may already have migrated
   * the library; this puts back the copy saved just before that migration
   * when one written after `snapshotNotBefore` exists. If it throws, the record
   * is kept and the next start tries again.
   */
  readonly recoverLibrary?: (snapshotNotBefore: number) => LibraryRollbackOutcome | Promise<LibraryRollbackOutcome>;
}

/** Shown once on the next window after an update was undone. */
export interface NativeUpdateRollbackNotice {
  readonly from: string;
  readonly to: string;
  readonly library: LibraryRollbackOutcome["outcome"];
  readonly setAsidePath?: string;
}

function bundleOf(executable: string): string {
  return dirname(dirname(dirname(executable)));
}

async function readPending(files: UpdateHealthFiles, directory: string): Promise<PendingNativeUpdate | undefined> {
  let raw: string;
  try { raw = await files.readFile(join(directory, PENDING_RECORD)); }
  catch { return undefined; }
  try {
    const value = JSON.parse(raw) as Partial<PendingNativeUpdate>;
    if (typeof value.version === "string" && typeof value.target === "string" && typeof value.backup === "string" &&
        typeof value.installedAt === "number" && typeof value.launches === "number" &&
        // Only ever a hidden sibling of the installed app, as installNativeUpdate names it.
        value.backup.startsWith(`${dirname(value.target)}/.`) && value.backup.endsWith(".app.previous") &&
        !value.backup.slice(dirname(value.target).length + 1).includes("/") && !value.backup.includes("..")) {
      return value as PendingNativeUpdate;
    }
  } catch { /* fall through: an unreadable record is discarded */ }
  await files.remove(join(directory, PENDING_RECORD));
  return undefined;
}

/**
 * Runs once at startup, before the library opens. Only an installed Mac app
 * that matches the recorded update takes part; development runs and other
 * copies leave the record alone.
 *
 * - "none": no update is waiting on this app.
 * - "pending": this version has not reported healthy yet; this start is counted.
 * - "cleaned": the update either finished earlier or never took; leftovers removed.
 *   When this is the older version running again, the library is checked first
 *   (recoverLibrary) and a one-time notice is left for the window.
 * - "rolling-back": too many unhealthy starts; the previous version is being
 *   restored and this app has been asked to quit.
 */
export async function checkNativeUpdateStartup(environment: UpdateStartupEnvironment): Promise<"none" | "pending" | "cleaned" | "rolling-back"> {
  if (environment.platform !== "darwin") return "none";
  const files = environment.files ?? realFiles;
  const record = await readPending(files, environment.directory);
  if (!record || record.target !== bundleOf(environment.executable)) return "none";
  const recordPath = join(environment.directory, PENDING_RECORD);
  const markerPath = join(environment.directory, HEALTH_MARKER);
  if (record.version !== environment.version) {
    // The swap never happened or was already undone. This app runs from the
    // installed location, so a kept copy is no longer needed. A newer version
    // installed by hand since then is not a rollback.
    if (environment.recoverLibrary && compareVersions(environment.version, record.version) < 0) {
      const library = await environment.recoverLibrary(record.installedAt);
      const notice: NativeUpdateRollbackNotice = {
        from: record.version, to: environment.version, library: library.outcome,
        ...(library.outcome === "restored" ? { setAsidePath: library.setAsidePath } : {}),
      };
      await files.writeFile(join(environment.directory, ROLLBACK_NOTICE), JSON.stringify(notice), 0o600);
    }
    await files.remove(record.backup);
    await files.remove(recordPath);
    await files.remove(markerPath);
    return "cleaned";
  }
  if (await files.readFile(markerPath).then(() => true, () => false)) {
    await files.remove(record.backup);
    await files.remove(recordPath);
    return "cleaned";
  }
  if (!await files.isDirectory(record.backup)) {
    await files.remove(recordPath);
    return "none";
  }
  const launches = record.launches + 1;
  if (launches <= MAX_UNHEALTHY_LAUNCHES) {
    await files.writeFile(recordPath, JSON.stringify({ ...record, launches }), 0o600);
    return "pending";
  }
  const helper = join(environment.directory, ROLLBACK_HELPER);
  await files.writeFile(helper, MAC_ROLLBACK_HELPER, 0o700);
  const launch = environment.launchHelper ?? launchUpdateHelper;
  await launch("/bin/sh", [helper, String(environment.pid), record.target, record.backup, ...environment.args]);
  environment.quit();
  return "rolling-back";
}

/**
 * Called once the window has loaded and the library opened. Tells a waiting
 * update helper that this version started healthily, then drops the kept
 * previous bundle.
 */
export async function markNativeUpdateHealthy(environment: UpdateHealthEnvironment): Promise<boolean> {
  if (environment.platform !== "darwin") return false;
  const files = environment.files ?? realFiles;
  const record = await readPending(files, environment.directory);
  if (!record || record.target !== bundleOf(environment.executable) || record.version !== environment.version) return false;
  await files.writeFile(join(environment.directory, HEALTH_MARKER), String(Date.now()), 0o600);
  await files.remove(join(environment.directory, PENDING_RECORD));
  await files.remove(record.backup);
  return true;
}

/** The notice left by an undone update, if any. Remove it with clearNativeUpdateNotice once shown. */
export async function readNativeUpdateNotice(environment: Pick<UpdateHealthEnvironment, "platform" | "directory" | "files">): Promise<NativeUpdateRollbackNotice | undefined> {
  if (environment.platform !== "darwin") return undefined;
  const files = environment.files ?? realFiles;
  let raw: string;
  try { raw = await files.readFile(join(environment.directory, ROLLBACK_NOTICE)); }
  catch { return undefined; }
  try {
    const value = JSON.parse(raw) as Partial<NativeUpdateRollbackNotice>;
    if (typeof value.from === "string" && typeof value.to === "string" &&
        (value.library === "not-needed" || value.library === "restored" || value.library === "kept-newer") &&
        (value.setAsidePath === undefined || typeof value.setAsidePath === "string")) {
      return { from: value.from, to: value.to, library: value.library, ...(value.setAsidePath ? { setAsidePath: value.setAsidePath } : {}) };
    }
  } catch { /* fall through */ }
  await files.remove(join(environment.directory, ROLLBACK_NOTICE));
  return undefined;
}

export async function clearNativeUpdateNotice(environment: Pick<UpdateHealthEnvironment, "directory" | "files">): Promise<void> {
  await (environment.files ?? realFiles).remove(join(environment.directory, ROLLBACK_NOTICE));
}

/** Plain wording for the one-time dialog after an undone update. */
export function nativeUpdateNoticeText(notice: NativeUpdateRollbackNotice): { readonly message: string; readonly detail: string } {
  const message = `Leaflogue ${notice.from} didn't start properly, so Leaflogue went back to version ${notice.to}.`;
  if (notice.library === "restored") {
    return {
      message,
      detail: `Leaflogue ${notice.from} had already updated your library, which this version can't open, so Leaflogue put back the copy it saved just before the update. ` +
        `Anything changed after the update isn't in this copy. Nothing was deleted: the updated library is kept at ${notice.setAsidePath ?? "Leaflogue's data folder"}.`,
    };
  }
  if (notice.library === "kept-newer") {
    return {
      message,
      detail: `Leaflogue ${notice.from} had already updated your library, and no copy from before the update was found, so this version can't open it. ` +
        `Your library was not changed. Install Leaflogue ${notice.from} or later to open it again.`,
    };
  }
  return { message, detail: "Your library was not affected." };
}
