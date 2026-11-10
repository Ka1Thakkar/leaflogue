import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { generateReleaseEvidence } from "./release-evidence.mjs";

// The scripts name artifacts after the desktop version, so the tests follow it.
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const temporaryDirectories = [];

async function createReleaseDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "leaflogue-release-evidence-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeReleaseSet(directory) {
  const artifacts = [
    [`Leaflogue-${VERSION}-x86_64.AppImage`, "app-image"],
    [`Leaflogue-${VERSION}-x64.tar.gz`, "tar"]
  ];
  await Promise.all(artifacts.map(([name, contents]) => writeFile(join(directory, name), contents)));
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("generateReleaseEvidence", () => {
  it("writes auditable release evidence only after verifying the artifact set", async () => {
    const directory = await createReleaseDirectory();
    await writeReleaseSet(directory);
    const commands = [];
    const commandRunner = async (command, argumentsList, options) => {
      commands.push({ argumentsList, command, options });
      if (argumentsList[0] === "sbom") return { stdout: JSON.stringify({ bomFormat: "CycloneDX" }) };
      return { stdout: JSON.stringify({ metadata: { vulnerabilities: { total: 0 } } }) };
    };

    const paths = await generateReleaseEvidence(
      { architecture: "x64", artifactDirectory: directory },
      { commandRunner }
    );

    expect(commands).toEqual([
      expect.objectContaining({
        argumentsList: ["sbom", "--package-lock-only", "--sbom-format", "cyclonedx", "--sbom-type", "application"],
        command: "npm"
      }),
      expect.objectContaining({
        argumentsList: ["audit", "--omit=dev", "--audit-level=high", "--json"],
        command: "npm"
      })
    ]);
    expect(JSON.parse(await readFile(paths.sbom, "utf8"))).toEqual({ bomFormat: "CycloneDX" });
    expect(JSON.parse(await readFile(paths.audit, "utf8"))).toEqual({
      metadata: { vulnerabilities: { total: 0 } }
    });
    expect(JSON.parse(await readFile(paths.buildInputs, "utf8"))).toMatchObject({
      architecture: "x64",
      productName: "Leaflogue",
      schemaVersion: 1,
      sourceDateEpoch: null,
      version: VERSION
    });
  });

  it("does not run provenance commands for an incomplete release set", async () => {
    const directory = await createReleaseDirectory();
    let commandWasCalled = false;

    await expect(
      generateReleaseEvidence(
        { architecture: "x64", artifactDirectory: directory },
        {
          commandRunner: async () => {
            commandWasCalled = true;
            return { stdout: "{}" };
          }
        }
      )
    ).rejects.toThrow("Missing Linux release artifacts");

    expect(commandWasCalled).toBe(false);
  });

  it("writes the audit report before failing a vulnerable release", async () => {
    const directory = await createReleaseDirectory();
    await writeReleaseSet(directory);
    const commandRunner = async (_command, argumentsList) => {
      if (argumentsList[0] === "sbom") return { code: 0, stdout: JSON.stringify({ bomFormat: "CycloneDX" }) };
      return { code: 1, stdout: JSON.stringify({ metadata: { vulnerabilities: { high: 1 } } }) };
    };

    await expect(
      generateReleaseEvidence(
        { architecture: "x64", artifactDirectory: directory },
        { commandRunner }
      )
    ).rejects.toThrow("Production dependency audit found release-blocking vulnerabilities");

    expect(
      JSON.parse(await readFile(join(directory, `Leaflogue-${VERSION}-x64.production-audit.json`), "utf8"))
    ).toEqual({ metadata: { vulnerabilities: { high: 1 } } });
  });

  it("rejects operational audit failures without writing an error payload as evidence", async () => {
    const directory = await createReleaseDirectory();
    await writeReleaseSet(directory);
    const commandRunner = async (_command, argumentsList) => {
      if (argumentsList[0] === "sbom") return { code: 0, stdout: JSON.stringify({ bomFormat: "CycloneDX" }) };
      return { code: 1, stdout: JSON.stringify({ error: { code: "E401" } }) };
    };

    await expect(
      generateReleaseEvidence(
        { architecture: "x64", artifactDirectory: directory },
        { commandRunner }
      )
    ).rejects.toThrow("npm audit did not produce a dependency vulnerability report");

    await expect(
      readFile(join(directory, `Leaflogue-${VERSION}-x64.production-audit.json`), "utf8")
    ).rejects.toThrow();
  });
});
