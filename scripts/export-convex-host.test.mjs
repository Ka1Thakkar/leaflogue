import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exportConvexHost, exportUiHost } from "./export-convex-host.mjs";

function hostProject() {
  const directory = mkdtempSync(join(tmpdir(), "leaflogue-host-test-"));
  writeFileSync(join(directory, "package.json"), "{}\n");
  mkdirSync(join(directory, "convex"));
  writeFileSync(join(directory, "convex", "schema.ts"), "// the host's schema\n");
  writeFileSync(join(directory, "convex", "auth.config.ts"), "// the host's auth\n");
  writeFileSync(join(directory, "convex", "publications.ts"), "// a host module\n");
  return directory;
}

test("copies Leaflogue's modules and packages into a host, leaving the host's own files alone", () => {
  const host = hostProject();
  try {
    const manifest = exportConvexHost({ hostProject: host });
    assert.ok(manifest.files.includes("syncRuntime.ts"));
    assert.ok(manifest.files.includes("tables.ts"));
    assert.ok(!manifest.files.includes("schema.ts"));
    assert.ok(!manifest.files.some((name) => name.endsWith(".test.ts")));
    assert.equal(readFileSync(join(host, "convex", "schema.ts"), "utf8"), "// the host's schema\n");
    assert.equal(readFileSync(join(host, "convex", "auth.config.ts"), "utf8"), "// the host's auth\n");
    assert.equal(readFileSync(join(host, "convex", "publications.ts"), "utf8"), "// a host module\n");
    assert.ok(existsSync(join(host, "vendor", "leaflogue", "contracts", "src", "index.ts")));
    const domain = JSON.parse(readFileSync(join(host, "vendor", "leaflogue", "domain", "package.json"), "utf8"));
    assert.equal(domain.dependencies["@leaflogue/contracts"], "file:../contracts");
    assert.deepEqual(manifest.packages, {
      "@leaflogue/ai": "file:vendor/leaflogue/ai",
      "@leaflogue/appearance": "file:vendor/leaflogue/appearance",
      "@leaflogue/catalog": "file:vendor/leaflogue/catalog",
      "@leaflogue/contracts": "file:vendor/leaflogue/contracts",
      "@leaflogue/domain": "file:vendor/leaflogue/domain",
      "@leaflogue/importers": "file:vendor/leaflogue/importers",
      "@leaflogue/ui": "file:vendor/leaflogue/ui",
    });
    assert.ok(existsSync(join(host, "vendor", "leaflogue", "ui", "src", "index.tsx")));
    assert.ok(existsSync(join(host, "vendor", "leaflogue", "ui", "src", "ui.css")));
    assert.ok(!existsSync(join(host, "vendor", "leaflogue", "ui", "src", "index.test.tsx")));
    const ui = JSON.parse(readFileSync(join(host, "vendor", "leaflogue", "ui", "package.json"), "utf8"));
    assert.ok(ui.dependencies["@fontsource/barlow"]);
    assert.ok(existsSync(join(host, "vendor", "leaflogue", "importers", "src", "kobo.ts")));
    assert.ok(!existsSync(join(host, "vendor", "leaflogue", "importers", "src", "kobo.test.ts")));
    assert.ok(Number.isSafeInteger(manifest.schemaVersion) && Number.isSafeInteger(manifest.mutationContractVersion));
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
});

test("refuses to overwrite a host module that shares a Leaflogue module's name", () => {
  const host = hostProject();
  try {
    writeFileSync(join(host, "convex", "library.ts"), "// the host's own library\n");
    assert.throws(() => exportConvexHost({ hostProject: host }), /already has its own library\.ts/u);
    assert.equal(readFileSync(join(host, "convex", "library.ts"), "utf8"), "// the host's own library\n");
    assert.ok(!existsSync(join(host, "convex", "syncRuntime.ts")));
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
});

test("a later export replaces its own files and removes ones Leaflogue dropped", () => {
  const host = hostProject();
  try {
    exportConvexHost({ hostProject: host });
    const manifestPath = join(host, "convex", "leaflogue-backend.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(join(host, "convex", "retired.ts"), "// from an older export\n");
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, files: [...manifest.files, "retired.ts"] }));
    writeFileSync(join(host, "convex", "syncRuntime.ts"), "// stale\n");
    exportConvexHost({ hostProject: host });
    assert.ok(!existsSync(join(host, "convex", "retired.ts")));
    assert.notEqual(readFileSync(join(host, "convex", "syncRuntime.ts"), "utf8"), "// stale\n");
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
});

test("keeps a host's own hostIdentity.ts, and writes Leaflogue's default where there is none", () => {
  const plain = hostProject();
  const custom = hostProject();
  try {
    const manifest = exportConvexHost({ hostProject: plain });
    assert.ok(manifest.files.includes("hostIdentity.ts"));
    assert.deepEqual(manifest.hostOverrides, []);
    // A later export still owns the default it wrote.
    assert.ok(exportConvexHost({ hostProject: plain }).files.includes("hostIdentity.ts"));

    writeFileSync(join(custom, "convex", "hostIdentity.ts"), "// the host's identity\n");
    const overridden = exportConvexHost({ hostProject: custom });
    assert.ok(!overridden.files.includes("hostIdentity.ts"));
    assert.deepEqual(overridden.hostOverrides, ["hostIdentity.ts"]);
    assert.equal(readFileSync(join(custom, "convex", "hostIdentity.ts"), "utf8"), "// the host's identity\n");
    exportConvexHost({ hostProject: custom });
    assert.equal(readFileSync(join(custom, "convex", "hostIdentity.ts"), "utf8"), "// the host's identity\n");
  } finally {
    rmSync(plain, { recursive: true, force: true });
    rmSync(custom, { recursive: true, force: true });
  }
});


test("a UI-only refresh preserves the deployed backend and other packages", () => {
  const host = hostProject();
  try {
    exportConvexHost({ hostProject: host });
    const backend = join(host, "convex", "syncRuntime.ts");
    const domain = join(host, "vendor", "leaflogue", "domain", "src", "widgets.ts");
    const manifest = readFileSync(join(host, "convex", "leaflogue-backend.json"), "utf8");
    writeFileSync(backend, "// deployed backend\n");
    writeFileSync(domain, "// deployed domain\n");
    writeFileSync(join(host, "vendor", "leaflogue", "ui", "src", "ui.css"), "/* stale */");
    exportUiHost({ hostProject: host });
    assert.equal(readFileSync(backend, "utf8"), "// deployed backend\n");
    assert.equal(readFileSync(domain, "utf8"), "// deployed domain\n");
    assert.equal(readFileSync(join(host, "convex", "leaflogue-backend.json"), "utf8"), manifest);
    assert.match(readFileSync(join(host, "vendor", "leaflogue", "ui", "src", "ui.css"), "utf8"), /ui-companion/);
    assert.ok(existsSync(join(host, "vendor", "leaflogue", "ui", "src", "app-icons.tsx")));
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
});
