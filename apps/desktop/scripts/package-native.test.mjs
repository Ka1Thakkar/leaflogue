import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { assertNativeArchitecture, validateNativeTarget } from "./package-native.mjs";

describe("native beta package boundaries", () => {
  it("requires the right native host and supported beta architecture", () => {
    expect(() => validateNativeTarget("mac", "arm64", "darwin")).not.toThrow();
    expect(() => validateNativeTarget("windows", "x64", "win32")).not.toThrow();
    expect(() => validateNativeTarget("windows", "arm64", "win32")).toThrow();
    expect(() => validateNativeTarget("mac", "arm64", "linux")).toThrow();
  });
  it("rejects mislabeled or truncated Mach-O and PE executables", () => {
    const mac = Buffer.alloc(8); mac.writeUInt32LE(0xfeedfacf); mac.writeUInt32LE(0x100000c, 4);
    expect(() => assertNativeArchitecture(mac, "mac", "arm64")).not.toThrow();
    expect(() => assertNativeArchitecture(mac, "mac", "x64")).toThrow();
    const win = Buffer.alloc(96); win.write("MZ"); win.writeUInt32LE(80, 0x3c); win.write("PE\0\0", 80); win.writeUInt16LE(0x8664, 84);
    expect(() => assertNativeArchitecture(win, "windows", "x64")).not.toThrow();
    win.writeUInt16LE(0xaa64, 84);
    expect(() => assertNativeArchitecture(win, "windows", "x64")).toThrow();
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(4)]) {
      expect(() => assertNativeArchitecture(bytes, "mac", "arm64")).toThrow();
      expect(() => assertNativeArchitecture(bytes, "windows", "x64")).toThrow();
    }
  });
});
