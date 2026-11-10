import assert from "node:assert/strict";
import test from "node:test";
import { verifyReleaseVersion } from "./verify-release-version.mjs";

test("accepts a tag that exactly matches both desktop version records", () => {
  assert.equal(verifyReleaseVersion({
    tag: "v1.2.3",
    desktopVersion: "1.2.3",
    lockedDesktopVersion: "1.2.3",
  }), "1.2.3");
});

test("rejects a tag, package, or lockfile version mismatch", () => {
  assert.throws(() => verifyReleaseVersion({
    tag: "v1.2.4",
    desktopVersion: "1.2.3",
    lockedDesktopVersion: "1.2.3",
  }), /does not match desktop package/u);
  assert.throws(() => verifyReleaseVersion({
    tag: "v1.2.3",
    desktopVersion: "1.2.3",
    lockedDesktopVersion: "1.2.2",
  }), /does not match lockfile/u);
  assert.throws(() => verifyReleaseVersion({
    tag: "1.2.3",
    desktopVersion: "1.2.3",
    lockedDesktopVersion: "1.2.3",
  }), /Release tag/u);
});
