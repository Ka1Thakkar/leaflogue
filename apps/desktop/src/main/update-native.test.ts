import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { LocalLibrary, latestSchemaVersion, recoverLibraryAfterRollback } from "@leaflogue/storage";
import { checkNativeUpdateStartup, clearNativeUpdateNotice, launchUpdateHelper, markNativeUpdateHealthy, MAC_ROLLBACK_HELPER, MAX_UNHEALTHY_LAUNCHES, WINDOWS_UPDATE_HELPER, MAC_UPDATE_HELPER, nativeUpdateNoticeText, nativeUpdateUnavailable, readNativeUpdateNotice, type UpdateHealthFiles } from "./update-native";

// Hosted Windows runners can spend several seconds starting PowerShell. Wait
// for the actual readiness marker and include helper output on failure.
const HELPER_START_ATTEMPTS = 400;
function helperDiagnostics(path: string) {
  try { return readFileSync(join(path, "helper.log"), "utf8").slice(-8000); }
  catch { return "No helper log was written."; }
}
const folders: string[] = [];
function folder() { const path = mkdtempSync(join(tmpdir(), "leaflogue-update-native-")); folders.push(path); return path; }
afterEach(() => folders.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

describe("native update installation boundary", () => {
  it.skipIf(process.platform !== "win32")("runs a background PowerShell file before the app exits", async () => {
    const path = folder();
    const script = join(path, "helper with spaces.ps1"), ready = join(path, "ready marker.txt");
    writeFileSync(script, 'param([string]$ReadyPath)\n[IO.File]::WriteAllText($ReadyPath, "initialized")\n');
    const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const child = await launchUpdateHelper(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ready], join(path, "helper.log"));
    try {
      for (let attempt = 0; attempt < HELPER_START_ATTEMPTS && !existsSync(ready); attempt += 1) {
        if (child.exitCode !== null || child.signalCode !== null) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect(existsSync(ready), `PowerShell must execute the script, not merely create a process. Exit: ${child.exitCode}; ${helperDiagnostics(path)}`).toBe(true);
      expect(readFileSync(ready, "utf8")).toBe("initialized");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
    }
  }, 30_000);
  it.skipIf(process.platform !== "win32")("continues when the captured parent process exits", async () => {
    const path = folder(), script = join(path, "wait.ps1"), config = join(path, "config.json"), state = join(path, "state.txt");
    const parent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    const parentExited = once(parent, "exit");
    const prefix = WINDOWS_UPDATE_HELPER.split("  # NSIS")[0];
    writeFileSync(script, prefix + "  Write-State 'parent-exited'\n} catch { Write-Error $_; exit 1 }\n");
    writeFileSync(config, JSON.stringify({ parent: parent.pid, work: path }));
    const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const helper = await launchUpdateHelper(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, config], join(path, "helper.log"));
    const waitState = async (expected: string) => {
      for (let i = 0; i < HELPER_START_ATTEMPTS; i += 1) {
        let value: string | undefined;
        try { value = await readFile(state, "utf8"); }
        catch (error) {
          if (!(error instanceof Error) || !("code" in error) || !["ENOENT", "EBUSY"].includes(String(error.code))) throw error;
        }
        if (value?.trim() === expected) return;
        if (helper.exitCode !== null || helper.signalCode !== null) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error(`Windows helper did not reach ${expected}. Exit: ${helper.exitCode}; ${helperDiagnostics(path)}`);
    };
    try {
      await waitState("waiting-for-app-exit");
      parent.kill();
      await parentExited;
      await waitState("parent-exited");
    } finally {
      parent.kill();
      if (helper.exitCode === null && helper.signalCode === null) {
        const exited = once(helper, "exit"); helper.kill(); await exited;
      }
    }
  }, 50_000);
  it("requires a real Windows installer installation", () => {
    const path = folder();
    const options = { platform: "win32" as const, executable: join(path, "Leaflogue.exe"), quit: () => undefined };
    expect(nativeUpdateUnavailable(options)).toBe("unsupported-installation");
    writeFileSync(join(path, "Uninstall Leaflogue.exe"), "fixture");
    expect(nativeUpdateUnavailable(options)).toBeUndefined();
  });
  it("refuses a Mac disk image or translocated app", () => {
    for (const executable of ["/Volumes/Leaflogue/Leaflogue.app/Contents/MacOS/Leaflogue", "/private/AppTranslocation/random/Leaflogue.app/Contents/MacOS/Leaflogue", "/tmp/Leaflogue"]) {
      expect(nativeUpdateUnavailable({ platform: "darwin", executable, quit: () => undefined })).toBe("unsupported-installation");
    }
  });
  it.skipIf(process.platform === "win32")("swaps a Mac bundle only after exit, handles spaces and quotes, and rolls back a failed swap", () => {
    const path = folder();
    const target = join(path, "Reader's Leaflogue.app"), staged = join(path, "new app"), backup = join(path, "previous app"), work = join(path, "work");
    mkdirSync(target); writeFileSync(join(target, "version"), "old");
    mkdirSync(staged); writeFileSync(join(staged, "version"), "new");
    mkdirSync(work);
    const script = join(path, "helper.sh");
    // Run the production swap with a no-op launcher, so this filesystem test
    // opens no application and never touches a real installation or library.
    writeFileSync(script, MAC_UPDATE_HELPER.replaceAll("/usr/bin/open", "/usr/bin/true"));
    execFileSync("/bin/sh", [script, "99999999", staged, target, backup, work, ""]);
    expect(readFileSync(join(target, "version"), "utf8")).toBe("new");
    expect(existsSync(backup)).toBe(false);
    expect(existsSync(work)).toBe(false);
    mkdirSync(work);
    expect(() => execFileSync("/bin/sh", [script, "99999999", staged, target, backup, work, ""], { stdio: "ignore" })).toThrow();
    expect(readFileSync(join(target, "version"), "utf8")).toBe("new");
    expect(existsSync(backup)).toBe(false);
  });
});

/**
 * Runs the production Mac scripts against folders in a temporary directory.
 * `open` and `ps` are replaced by stubs, so no application is ever started,
 * and the waits are shortened.
 */
describe.skipIf(process.platform === "win32")("Mac update keeps the previous app until the new one starts healthily", () => {
  function fixture() {
    const path = folder();
    const target = join(path, "Leaflogue.app"), staged = join(path, ".update.app"), backup = join(path, ".update.app.previous"), work = join(path, "work");
    const marker = join(path, "state", "native-update.healthy"), opened = join(path, "opened.txt");
    mkdirSync(join(path, "state"));
    mkdirSync(target); writeFileSync(join(target, "version"), "old");
    mkdirSync(staged); writeFileSync(join(staged, "version"), "new");
    mkdirSync(work);
    const open = join(path, "open-stub.sh");
    writeFileSync(open, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${opened}"\n`);
    chmodSync(open, 0o755);
    const processes = (running: boolean) => {
      const stub = join(path, `ps-${running}.sh`);
      writeFileSync(stub, running ? `#!/bin/sh\nprintf '%s\\n' "${target}/Contents/MacOS/Leaflogue"\n` : "#!/bin/sh\nprintf '/usr/bin/login\\n'\n");
      chmodSync(stub, 0o755);
      return stub;
    };
    const script = (source: string, running: boolean) => {
      const file = join(path, `helper-${running}.sh`);
      const text = source.replaceAll("/usr/bin/open", open).replaceAll("/bin/ps", processes(running)).replace("grace=25", "grace=1").replace("limit=600", "limit=3");
      expect(text).not.toContain("/usr/bin/open");
      expect(text).not.toContain("/bin/ps ");
      writeFileSync(file, text);
      return file;
    };
    const version = () => readFileSync(join(target, "version"), "utf8");
    return { path, target, staged, backup, work, marker, opened, script, version };
  }

  it("deletes the previous app only after the new one reports a healthy start", () => {
    const f = fixture();
    writeFileSync(f.marker, "healthy");
    execFileSync("/bin/sh", [f.script(MAC_UPDATE_HELPER, true), "99999999", f.staged, f.target, f.backup, f.work, f.marker, "--flag"]);
    expect(f.version()).toBe("new");
    expect(existsSync(f.backup)).toBe(false);
    expect(existsSync(f.work)).toBe(false);
    expect(existsSync(f.marker)).toBe(false);
    expect(readFileSync(f.opened, "utf8").trim()).toBe(`${f.target} --args --flag`);
  });

  it("puts the previous app back and opens it when the new one stops before reporting healthy", () => {
    const f = fixture();
    expect(() => execFileSync("/bin/sh", [f.script(MAC_UPDATE_HELPER, false), "99999999", f.staged, f.target, f.backup, f.work, f.marker, "--flag"], { stdio: "ignore" })).toThrow();
    expect(f.version()).toBe("old");
    expect(existsSync(f.backup)).toBe(false);
    expect(existsSync(`${f.backup}.failed`)).toBe(false);
    // Opened twice: the new version, then the restored previous one.
    expect(readFileSync(f.opened, "utf8").trim().split("\n")).toEqual([`${f.target} --args --flag`, `${f.target} --args --flag`]);
  });

  it("keeps the previous app for the next launch while the new one is running but not yet healthy", () => {
    const f = fixture();
    execFileSync("/bin/sh", [f.script(MAC_UPDATE_HELPER, true), "99999999", f.staged, f.target, f.backup, f.work, f.marker]);
    expect(f.version()).toBe("new");
    expect(readFileSync(join(f.backup, "version"), "utf8")).toBe("old");
  });

  it("restores the kept previous app after the current one exits", () => {
    const f = fixture();
    execFileSync("/bin/sh", [f.script(MAC_UPDATE_HELPER, true), "99999999", f.staged, f.target, f.backup, f.work, f.marker]);
    const record = join(f.path, "state", "native-update.json");
    writeFileSync(record, "{}");
    execFileSync("/bin/sh", [f.script(MAC_ROLLBACK_HELPER, true), "99999999", f.target, f.backup, "--flag"]);
    expect(f.version()).toBe("old");
    expect(existsSync(f.backup)).toBe(false);
    expect(existsSync(`${f.backup}.failed`)).toBe(false);
    // The restored version reads the record to check the library, then removes it.
    expect(existsSync(record)).toBe(true);
    expect(readFileSync(f.opened, "utf8").trim().split("\n").at(-1)).toBe(`${f.target} --args --flag`);
  });
});

describe("startup health of a Mac update", () => {
  const directory = "/state";
  const target = "/Applications/Leaflogue.app";
  const backup = "/Applications/.leaflogue-update-1.app.previous";
  const executable = `${target}/Contents/MacOS/Leaflogue`;
  function memory(initial: Record<string, string>, directories: string[] = [backup]) {
    const files = new Map(Object.entries(initial));
    const folders = new Set(directories);
    const api: UpdateHealthFiles = {
      readFile: async (path) => { const value = files.get(path); if (value === undefined) throw new Error("ENOENT"); return value; },
      writeFile: async (path, data) => { files.set(path, data); },
      remove: async (path) => { files.delete(path); folders.delete(path); },
      isDirectory: async (path) => folders.has(path),
    };
    return { files, folders, api };
  }
  const pending = (launches = 0, version = "0.2.0") => JSON.stringify({ version, target, backup, installedAt: 1, launches });
  const start = (api: UpdateHealthFiles, overrides: Partial<Parameters<typeof checkNativeUpdateStartup>[0]> = {}) => {
    const launchHelper = vi.fn().mockResolvedValue(undefined);
    const quit = vi.fn();
    const result = checkNativeUpdateStartup({ platform: "darwin", directory, version: "0.2.0", executable, pid: 42, args: ["--x"], quit, launchHelper, files: api, ...overrides });
    return { result, launchHelper, quit };
  };

  it("counts each start that has not reported healthy, then goes back to the previous version", async () => {
    const { files, api } = memory({ "/state/native-update.json": pending() });
    for (let launch = 1; launch <= MAX_UNHEALTHY_LAUNCHES; launch += 1) {
      const { result, launchHelper } = start(api);
      expect(await result).toBe("pending");
      expect(launchHelper).not.toHaveBeenCalled();
      expect((JSON.parse(files.get("/state/native-update.json")!) as { launches: number }).launches).toBe(launch);
    }
    const { result, launchHelper, quit } = start(api);
    expect(await result).toBe("rolling-back");
    expect(files.get("/state/native-update-rollback.sh")).toBe(MAC_ROLLBACK_HELPER);
    expect(launchHelper).toHaveBeenCalledWith("/bin/sh", ["/state/native-update-rollback.sh", "42", target, backup, "--x"]);
    expect(quit).toHaveBeenCalledOnce();
  });

  it("lets go of the previous version once this one reports healthy", async () => {
    const { files, folders, api } = memory({ "/state/native-update.json": pending(1) });
    expect(await markNativeUpdateHealthy({ platform: "darwin", directory, version: "0.2.0", executable, files: api })).toBe(true);
    expect(files.has("/state/native-update.healthy")).toBe(true);
    expect(files.has("/state/native-update.json")).toBe(false);
    expect(folders.has(backup)).toBe(false);
    expect(await start(api).result).toBe("none");
  });

  it("finishes the clean-up when a healthy report was interrupted", async () => {
    const { files, folders, api } = memory({ "/state/native-update.json": pending(1), "/state/native-update.healthy": "1" });
    expect(await start(api).result).toBe("cleaned");
    expect(files.has("/state/native-update.json")).toBe(false);
    expect(folders.has(backup)).toBe(false);
  });

  it("cleans up when the previous version is the one running again", async () => {
    const { files, api } = memory({ "/state/native-update.json": pending(2) }, []);
    expect(await start(api, { version: "0.1.0" }).result).toBe("cleaned");
    expect(files.has("/state/native-update.json")).toBe(false);
  });

  it("checks the library before the previous version opens it again, and leaves a notice", async () => {
    const { files, api } = memory({ "/state/native-update.json": pending(3) }, []);
    const recoverLibrary = vi.fn().mockReturnValue({ outcome: "restored", setAsidePath: "/data/library.newer-schema-21.5.sqlite" });
    expect(await start(api, { version: "0.1.0", recoverLibrary }).result).toBe("cleaned");
    expect(recoverLibrary).toHaveBeenCalledWith(1);
    expect(files.has("/state/native-update.json")).toBe(false);
    const notice = await readNativeUpdateNotice({ platform: "darwin", directory, files: api });
    expect(notice).toEqual({ from: "0.2.0", to: "0.1.0", library: "restored", setAsidePath: "/data/library.newer-schema-21.5.sqlite" });
    expect(nativeUpdateNoticeText(notice!).detail).toContain("/data/library.newer-schema-21.5.sqlite");
    await clearNativeUpdateNotice({ directory, files: api });
    expect(await readNativeUpdateNotice({ platform: "darwin", directory, files: api })).toBeUndefined();
  });

  it("says the library was not affected when the newer version never migrated it", async () => {
    const { api } = memory({ "/state/native-update.json": pending(3) }, []);
    const recoverLibrary = vi.fn().mockReturnValue({ outcome: "not-needed" });
    await start(api, { version: "0.1.0", recoverLibrary }).result;
    const notice = await readNativeUpdateNotice({ platform: "darwin", directory, files: api });
    expect(notice).toEqual({ from: "0.2.0", to: "0.1.0", library: "not-needed" });
    expect(nativeUpdateNoticeText(notice!).detail).toBe("Your library was not affected.");
  });

  it("keeps the record to try again when the library check fails", async () => {
    const { files, api } = memory({ "/state/native-update.json": pending(3) }, []);
    const recoverLibrary = vi.fn().mockImplementation(() => { throw new Error("disk full"); });
    await expect(start(api, { version: "0.1.0", recoverLibrary }).result).rejects.toThrow("disk full");
    expect(files.has("/state/native-update.json")).toBe(true);
    expect(files.has("/state/native-update-notice.json")).toBe(false);
  });

  it("does not treat a newer version installed by hand as a rollback", async () => {
    const { files, api } = memory({ "/state/native-update.json": pending(1) }, []);
    const recoverLibrary = vi.fn();
    expect(await start(api, { version: "0.3.0", recoverLibrary }).result).toBe("cleaned");
    expect(recoverLibrary).not.toHaveBeenCalled();
    expect(files.has("/state/native-update-notice.json")).toBe(false);
  });

  it("leaves records alone for other copies, development runs and Windows", async () => {
    const { files, folders, api } = memory({ "/state/native-update.json": pending(5) });
    expect(await start(api, { executable: "/Users/me/leaflogue/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" }).result).toBe("none");
    expect(await start(api, { platform: "win32" }).result).toBe("none");
    expect(await markNativeUpdateHealthy({ platform: "darwin", directory, version: "0.2.0", executable: "/tmp/Other.app/Contents/MacOS/Leaflogue", files: api })).toBe(false);
    expect(files.get("/state/native-update.json")).toBe(pending(5));
    expect(folders.has(backup)).toBe(true);
  });

  it("discards a record that points anywhere but a hidden sibling of the app", async () => {
    const { files, api } = memory({ "/state/native-update.json": JSON.stringify({ version: "0.2.0", target, backup: "/Users/me/Documents", installedAt: 1, launches: 9 }) }, ["/Users/me/Documents"]);
    const { result, launchHelper } = start(api);
    expect(await result).toBe("none");
    expect(launchHelper).not.toHaveBeenCalled();
    expect(files.has("/state/native-update.json")).toBe(false);
  });
});

/** Real files in a temporary folder and the real storage recovery; no app is launched. */
describe.skipIf(process.platform === "win32")("previous version running again after an update migrated the library", () => {
  function setup() {
    const root = folder();
    const state = join(root, "state"), data = join(root, "data");
    mkdirSync(state); mkdirSync(data);
    const target = join(root, "Applications", "Leaflogue.app");
    const backup = join(root, "Applications", ".leaflogue-update-1.app.previous");
    const library = join(data, "library.sqlite");
    const environment = { platform: "darwin" as const, directory: state, version: "0.1.0", executable: join(target, "Contents", "MacOS", "Leaflogue"), pid: 42, args: [], quit: vi.fn(), launchHelper: vi.fn(),
      recoverLibrary: (snapshotNotBefore: number) => recoverLibraryAfterRollback(library, { snapshotNotBefore }) };
    const record = (installedAt: number) => writeFileSync(join(state, "native-update.json"), JSON.stringify({ version: "0.2.0", target, backup, installedAt, launches: 3 }));
    return { state, data, library, environment, record };
  }
  function titles(path: string) {
    const database = new DatabaseSync(path, { readOnly: true });
    try { return database.prepare("SELECT title FROM books ORDER BY title").all().map((row) => row.title); } finally { database.close(); }
  }

  it("puts back the pre-update copy and keeps the updated library beside it", async () => {
    const { data, library, environment, record } = setup();
    const before = new LocalLibrary(library);
    before.createBook({ title: "Before the update", authors: [] });
    before.close();
    const installedAt = Date.now() - 1000;
    record(installedAt);
    // What the newer version does: save a copy, migrate, then keep working.
    const live = new DatabaseSync(library);
    live.prepare("VACUUM INTO ?").run(join(data, `library.before-upgrade.schema-${latestSchemaVersion}.sqlite`));
    live.exec(`INSERT INTO books (id, title, authors_json, created_at, updated_at) VALUES ('20000000-0000-4000-8000-000000000000', 'After the update', '[]', 2, 2);
      CREATE INDEX books_from_the_future ON books(title); PRAGMA user_version = ${latestSchemaVersion + 1};`);
    live.close();
    expect(() => new LocalLibrary(library)).toThrow(/newer than this Leaflogue build/);

    expect(await checkNativeUpdateStartup(environment)).toBe("cleaned");
    const reopened = new LocalLibrary(library);
    expect(reopened.listBooks().map((book) => book.title)).toEqual(["Before the update"]);
    expect(reopened.getSyncState().snapshotRequired).toBe(true);
    reopened.close();
    const notice = await readNativeUpdateNotice({ platform: "darwin", directory: environment.directory });
    expect(notice?.library).toBe("restored");
    expect(titles(notice!.setAsidePath!)).toEqual(["After the update", "Before the update"]);
  });

  it("leaves a library the newer version never migrated alone", async () => {
    const { library, environment, record } = setup();
    const current = new LocalLibrary(library);
    current.createBook({ title: "Untouched", authors: [] });
    current.close();
    record(Date.now() - 1000);
    expect(await checkNativeUpdateStartup(environment)).toBe("cleaned");
    expect(titles(library)).toEqual(["Untouched"]);
    expect((await readNativeUpdateNotice({ platform: "darwin", directory: environment.directory }))?.library).toBe("not-needed");
  });
});
