import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { launchUpdateHelper, WINDOWS_UPDATE_HELPER, MAC_UPDATE_HELPER, nativeUpdateUnavailable } from "./update-native";

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
      for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt += 1) {
        if (child.exitCode !== null || child.signalCode !== null) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect(existsSync(ready), "PowerShell must execute the script, not merely create a process").toBe(true);
      expect(readFileSync(ready, "utf8")).toBe("initialized");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
    }
  }, 10_000);
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
      for (let i = 0; i < 100; i += 1) {
        let value: string | undefined;
        try { value = await readFile(state, "utf8"); }
        catch (error) {
          if (!(error instanceof Error) || !("code" in error) || !["ENOENT", "EBUSY"].includes(String(error.code))) throw error;
        }
        if (value?.trim() === expected) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error(`Windows helper did not reach ${expected}`);
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
  }, 15_000);
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
    execFileSync("/bin/sh", [script, "99999999", staged, target, backup, work]);
    expect(readFileSync(join(target, "version"), "utf8")).toBe("new");
    expect(existsSync(backup)).toBe(false);
    expect(existsSync(work)).toBe(false);
    mkdirSync(work);
    expect(() => execFileSync("/bin/sh", [script, "99999999", staged, target, backup, work], { stdio: "ignore" })).toThrow();
    expect(readFileSync(join(target, "version"), "utf8")).toBe("new");
    expect(existsSync(backup)).toBe(false);
  });
});
