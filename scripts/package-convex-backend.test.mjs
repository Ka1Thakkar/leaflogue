import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { packageConvexBackend } from "./package-convex-backend.mjs";

test("builds a deterministic, self-contained Convex deployment bundle", () => {
  const directory = mkdtempSync(join(tmpdir(), "leaflogue-convex-test-"));
  try {
    const first = packageConvexBackend({ version: "1.2.3-test.1", outputDirectory: join(directory, "first") });
    const second = packageConvexBackend({ version: "1.2.3-test.1", outputDirectory: join(directory, "second") });
    assert.deepEqual(readFileSync(first.archive), readFileSync(second.archive));
    assert.deepEqual(readFileSync(first.manifest), readFileSync(second.manifest));

    const extracted = join(directory, "extracted");
    execFileSync("tar", ["-xzf", first.archive, "-C", directory]);
    const bundle = join(directory, "leaflogue-convex-1.2.3-test.1");
    const manifest = JSON.parse(readFileSync(join(bundle, "BACKEND_MANIFEST.json"), "utf8"));
    assert.deepEqual(manifest, {
      format: "leaflogue-convex-backend",
      version: "1.2.3-test.1",
      schemaVersion: 17,
      mutationContractVersion: 23,
      node: ">=22.22.2",
      convex: "1.45.0",
    });
    assert.equal(statSync(join(bundle, "deploy.sh")).mode & 0o111, 0o111);
    const packageJson = JSON.parse(readFileSync(join(bundle, "package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(join(bundle, "package-lock.json"), "utf8"));
    assert.equal(packageJson.version, "0.0.0");
    assert.deepEqual(lock.packages[""].dependencies, packageJson.dependencies);
    assert.equal(lock.packages["node_modules/convex"].version, "1.45.0");
    assert.match(lock.packages["node_modules/convex"].integrity, /^sha512-/u);
    assert.match(readFileSync(join(bundle, "deploy.sh"), "utf8"), /npm ci/u);
    assert.match(readFileSync(join(bundle, "README.md"), "utf8"), /env set --prod/u);
    const entries = execFileSync("tar", ["-tzf", first.archive], { encoding: "utf8" });
    assert.doesNotMatch(entries, /node_modules|\.test\.ts|_generated/u);
    assert.match(readFileSync(first.checksum, "utf8"), /Leaflogue-Convex-1\.2\.3-test\.1\.tar\.gz/u);
    assert.equal(extracted.length > 0, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("refuses unsafe or ambiguous release versions", () => {
  for (const version of ["v1.2.3", "1.2", "../1.2.3", "1.2.3 bad"]) {
    assert.throws(() => packageConvexBackend({ version, outputDirectory: "/tmp/unused-leaflogue-test" }), /semantic version/u);
  }
});
