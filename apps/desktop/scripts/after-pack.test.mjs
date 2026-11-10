import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { packagedExecutable } from "./after-pack.mjs";

describe("after-pack fuse target", () => {
  const packager = { executableName: "leaflogue", appInfo: { productFilename: "Leaflogue" } };

  it("finds the packaged executable on every desktop platform", () => {
    expect(packagedExecutable({ electronPlatformName: "linux", appOutDir: "/out", packager })).toBe(join("/out", "leaflogue"));
    expect(packagedExecutable({ electronPlatformName: "darwin", appOutDir: "/out", packager })).toBe(join("/out", "Leaflogue.app"));
    expect(packagedExecutable({ electronPlatformName: "win32", appOutDir: "/out", packager })).toBe(join("/out", "Leaflogue.exe"));
  });
});
