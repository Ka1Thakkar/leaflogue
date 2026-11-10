import { describe, expect, it } from "vitest";
import { assertManualReleasePolicy, verifyManualReleasePolicy } from "./release-policy.mjs";

describe("manual release policy", () => {
  it("accepts the current manual-distribution configuration", async () => {
    await expect(verifyManualReleasePolicy()).resolves.toBeUndefined();
  });

  it("rejects automatic updater dependencies, publishing, and runtime updater use", () => {
    expect(() => assertManualReleasePolicy({ dependencies: { "electron-updater": "1.0.0" } }, "{}", [])).toThrow(
      "Automatic update dependency"
    );
    expect(() => assertManualReleasePolicy({ build: { linux: { publish: "github" } } }, "{}", [])).toThrow(
      "publish configuration"
    );
    expect(() => assertManualReleasePolicy({ build: { extends: "release.yml" } }, "{}", [])).toThrow("extends configuration");
    expect(() => assertManualReleasePolicy({}, '{"packages":{"node_modules/electron-updater":{}}}', [])).toThrow("Automatic update dependency");
    expect(() => assertManualReleasePolicy({}, "{}", ["autoUpdater.checkForUpdates()"]))
      .toThrow("autoUpdater usage");
  });
});
