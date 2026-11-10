import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareReleaseArtifacts, verifyReleaseArtifacts } from "./release-artifacts.mjs";

const PRODUCT_NAME = "Leaflogue";
// The scripts name artifacts after the desktop version, so the tests follow it.
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const temporaryDirectories = [];

async function createReleaseDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "leaflogue-release-artifacts-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeReleaseSet(directory, architecture = "x64") {
  for (const extension of ["AppImage", "tar.gz"]) {
    const artifactArchitecture = {
      AppImage: architecture === "x64" ? "x86_64" : "arm64",
      "tar.gz": architecture
    }[extension];
    const name = `${PRODUCT_NAME}-${VERSION}-${artifactArchitecture}.${extension}`;
    await writeFile(join(directory, name), `${architecture}:${extension}`);
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("verifyReleaseArtifacts", () => {
  it("writes deterministic checksums for a complete release set", async () => {
    const directory = await createReleaseDirectory();
    await writeReleaseSet(directory);

    const result = await verifyReleaseArtifacts({ artifactDirectory: directory, architecture: "x64" });

    expect(result.checksums).toHaveLength(2);
    const hash = (contents) => createHash("sha256").update(contents).digest("hex");
    const manifest = await readFile(join(directory, "SHA256SUMS-x64.txt"), "utf8");
    expect(manifest).toBe(
      [
        `${hash("x64:tar.gz")}  Leaflogue-${VERSION}-x64.tar.gz`,
        `${hash("x64:AppImage")}  Leaflogue-${VERSION}-x86_64.AppImage`,
        ""
      ].join("\n")
    );
  });

  it("rejects partial release sets", async () => {
    const directory = await createReleaseDirectory();
    await writeFile(join(directory, `Leaflogue-${VERSION}-x86_64.AppImage`), "artifact");

    await expect(
      verifyReleaseArtifacts({ artifactDirectory: directory, architecture: "x64" })
    ).rejects.toThrow("Missing Linux release artifacts");
  });

  it("rejects symlinked artifacts", async () => {
    const directory = await createReleaseDirectory();
    await writeReleaseSet(directory);
    const appImage = join(directory, `Leaflogue-${VERSION}-x86_64.AppImage`);
    await rm(appImage);
    await symlink(join(directory, `Leaflogue-${VERSION}-x64.tar.gz`), appImage);

    await expect(
      verifyReleaseArtifacts({ artifactDirectory: directory, architecture: "x64" })
    ).rejects.toThrow("Release artifact must be a regular file");
  });

  it("clears only the selected architecture before a release build", async () => {
    const directory = await createReleaseDirectory();
    await writeReleaseSet(directory, "x64");
    await writeReleaseSet(directory, "arm64");
    await writeFile(join(directory, `Leaflogue-${VERSION}-x86_64.rpm`), "retired x64 package");
    await writeFile(join(directory, `Leaflogue-${VERSION}-aarch64.rpm`), "retired arm64 package");
    await writeFile(join(directory, "SHA256SUMS-x64.txt"), "stale x64 manifest");
    await writeFile(join(directory, `Leaflogue-${VERSION}-x64.build-inputs.json`), "stale x64 evidence");
    await writeFile(join(directory, `Leaflogue-${VERSION}-arm64.build-inputs.json`), "current arm64 evidence");

    await prepareReleaseArtifacts({ artifactDirectory: directory, architecture: "x64" });

    await expect(
      verifyReleaseArtifacts({ artifactDirectory: directory, architecture: "x64" })
    ).rejects.toThrow("Missing Linux release artifacts");
    await expect(readFile(join(directory, `Leaflogue-${VERSION}-x64.build-inputs.json`), "utf8")).rejects.toThrow();
    await expect(readFile(join(directory, `Leaflogue-${VERSION}-x86_64.rpm`), "utf8")).rejects.toThrow();
    await expect(readFile(join(directory, `Leaflogue-${VERSION}-aarch64.rpm`), "utf8")).resolves.toBe(
      "retired arm64 package"
    );
    await expect(readFile(join(directory, `Leaflogue-${VERSION}-arm64.build-inputs.json`), "utf8")).resolves.toBe(
      "current arm64 evidence"
    );
    await expect(
      verifyReleaseArtifacts({ artifactDirectory: directory, architecture: "arm64" })
    ).resolves.toMatchObject({
      checksums: expect.arrayContaining([
        expect.objectContaining({ name: `Leaflogue-${VERSION}-arm64.AppImage` }),
        expect.objectContaining({ name: `Leaflogue-${VERSION}-arm64.tar.gz` })
      ])
    });
  });
});
