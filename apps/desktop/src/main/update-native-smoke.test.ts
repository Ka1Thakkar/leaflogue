import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { installNativeUpdate } from "./update-native";
import type { UpdateManifest } from "./update-manifest";

const archive = process.env.LEAFLOGUE_NATIVE_UPDATE_TEST_ARCHIVE;
const packaged = process.env.LEAFLOGUE_PACKAGED_EXECUTABLE;
async function run(command: string, args: string[], timeout = 60_000) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true, timeout, killSignal: "SIGKILL" });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Native upgrade command failed: ${command} (${code})`)));
  });
}
async function waitFor(predicate: () => Promise<boolean>) {
  for (let i = 0; i < 600; i += 1) { if (await predicate()) return; await delay(200); }
  throw new Error("Native upgrade helper did not complete");
}

describe.skipIf(!archive || !packaged || !["darwin", "win32"].includes(process.platform))("actual native installer upgrade", () => {
  it("replaces an isolated old installation with the verified package and preserves the separate library", async () => {
    const root = await mkdtemp(join(tmpdir(), "leaflogue-native-upgrade-"));
    const work = join(root, "download");
    const profile = join(root, "isolated-profile");
    await mkdir(work); await mkdir(profile);
    const library = join(profile, "library-sentinel");
    await writeFile(library, "reader data stays outside the application");
    let executable = "";
    let parent: ChildProcess | undefined;
    let cleanupError: unknown;
    try {
      const identity = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
      const platform = process.platform === "darwin" ? "mac" : "windows";
      const version = identity.version;
      const manifest: UpdateManifest = { format: 2, product: "leaflogue", platform, channel: "beta", version, architecture: process.arch as "x64" | "arm64", releasedAt: new Date().toISOString(), artifact: { name: "already-verified-native-fixture", size: 1, sha512: "not-used-by-native-installer" } };
      const download = join(work, process.platform === "darwin" ? "update.zip" : "update.exe");
      const { copyFile } = await import("node:fs/promises");
      await copyFile(archive!, download);
      let asar: string;
      if (process.platform === "darwin") {
        await run("/usr/bin/ditto", ["-x", "-k", archive!, root]);
        executable = join(root, "Leaflogue.app", "Contents", "MacOS", "Leaflogue");
        asar = join(root, "Leaflogue.app", "Contents", "Resources", "app.asar");
      } else {
        const target = join(root, "installed app");
        await run(archive!, ["/S", "/currentuser", `/D=${target}`]);
        executable = join(target, "Leaflogue.exe");
        asar = join(target, "resources", "app.asar");
      }
      const expected = createHash("sha256").update(await readFile(asar)).digest("hex");
      // Emulate an older build without running it. Updating must restore the
      // real packaged ASAR while preserving the separate user-data folder.
      await writeFile(asar, "old isolated app fixture");
      parent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
      if (!parent.pid) throw new Error("Could not create isolated parent process");
      await installNativeUpdate(download, manifest, { platform: process.platform, executable, args: ["--mcp", `--user-data-dir=${profile}`], pid: parent.pid, quit: () => { parent?.kill(); } });
      await waitFor(async () => {
        const failure = await readFile(join(work, "failure.txt")).catch(() => undefined);
        if (failure) throw new Error(`Native update helper reported: ${failure.toString("utf8").trim()}`);
        const state = await readFile(join(work, "state.txt"), "utf8").catch(() => "");
        if (state.trim() === "complete") return true;
        try { await access(work); return false; } catch { return true; }
      });
      expect(createHash("sha256").update(await readFile(asar)).digest("hex")).toBe(expected);
      expect(await readFile(library, "utf8")).toBe("reader data stays outside the application");
    } catch (error) {
      const state = await readFile(join(work, "state.txt"), "utf8").catch(() => "not started");
      const log = await readFile(join(work, "helper.log"), "utf8").catch(() => "no helper output");
      throw new Error(`Native upgrade failed at ${state.trim()}: ${log.slice(-8000)}`, { cause: error });
    } finally {
      parent?.kill();
      // Only terminate a process whose executable is inside this test's random
      // folder; never use an application-name kill against a real installation.
      if (executable && process.platform === "win32") {
        execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Where-Object { ($_.ExecutablePath -and $_.ExecutablePath.Contains($env:LEAFLOGUE_UPGRADE_TEST_TOKEN)) -or ($_.CommandLine -and $_.CommandLine.Contains($env:LEAFLOGUE_UPGRADE_TEST_TOKEN)) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"], { env: { ...process.env, LEAFLOGUE_UPGRADE_TEST_TOKEN: basename(root) }, stdio: "ignore" });
        const uninstaller = join(dirname(executable), "Uninstall Leaflogue.exe");
        try { await run(uninstaller, ["/S", "/currentuser", "--updated", `_?=${dirname(executable)}`], 15_000); } catch { /* fixture may not have installed */ }
      } else if (executable && process.platform === "darwin") {
        const processes = execFileSync("/bin/ps", ["-axo", "pid=,comm="], { encoding: "utf8" });
        for (const line of processes.split("\n")) {
          const match = /^\s*(\d+)\s+(.+)$/.exec(line);
          if (match?.[2] === executable) { try { process.kill(Number(match[1])); } catch { /* process already exited */ } }
        }
      }
      try { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
      catch (error) { cleanupError = error; }
    }
    if (cleanupError) throw new Error("Could not remove the isolated upgrade fixture", { cause: cleanupError });
  }, 180_000);
});
