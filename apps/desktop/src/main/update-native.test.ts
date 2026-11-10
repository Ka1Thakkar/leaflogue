import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAC_UPDATE_HELPER, nativeUpdateUnavailable } from "./update-native";

const folders: string[] = [];
function folder() { const path = mkdtempSync(join(tmpdir(), "leaflogue-update-native-")); folders.push(path); return path; }
afterEach(() => folders.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

describe("native update installation boundary", () => {
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
