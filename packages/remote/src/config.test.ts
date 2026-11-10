import { fileURLToPath } from "node:url";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acceptAiProviderTerms, CURRENT_SETUP_VERSION, loadAiRuntimeProvider, loadRemoteConfig, setupCompletedVersion, summarizeAiConfig, summarizeRemoteConfig, writeAiConfig, writeRemoteConfig, writeSetupCompletion, loadUpdatePreferences, writeUpdatePreferences } from "./config";

describe("desktop remote configuration", () => {
  it("saves a Convex sync key write-only, keeps it only for the same deployment, and prefers the environment", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-convex-sync-key-"));
    const path = join(directory, "config.json");
    const key = "a".repeat(44);
    try {
      expect(() => writeRemoteConfig(path, { provider: "convex", deploymentUrl: "https://quiet-otter-123.convex.cloud", syncKey: "short" }))
        .toThrow("32 to 512 printable characters");
      writeRemoteConfig(path, { provider: "convex", deploymentUrl: "https://quiet-otter-123.convex.cloud", syncKey: key });
      const loaded = loadRemoteConfig({ defaultConfigPath: path, environment: {}, platform: "linux" });
      expect(loaded).toEqual({ provider: "convex", deploymentUrl: "https://quiet-otter-123.convex.cloud", source: "config", syncKey: key });
      const summary = summarizeRemoteConfig(loaded);
      expect(summary.syncKeySaved).toBe(true);
      expect(JSON.stringify(summary)).not.toContain(key);
      expect(statMode(path)).toBe(0o600);

      // Re-saving the same deployment keeps the key; naming another deployment
      // must not hand it the key.
      writeRemoteConfig(path, { provider: "convex", deploymentUrl: "https://quiet-otter-123.convex.cloud/" });
      expect(loadRemoteConfig({ defaultConfigPath: path, environment: {}, platform: "linux" })).toMatchObject({ syncKey: key });
      writeRemoteConfig(path, { provider: "convex", deploymentUrl: "https://other-owl-456.convex.cloud" });
      const moved = loadRemoteConfig({ defaultConfigPath: path, environment: {}, platform: "linux" });
      expect(moved).toMatchObject({ deploymentUrl: "https://other-owl-456.convex.cloud" });
      expect(moved).not.toHaveProperty("syncKey");
      writeRemoteConfig(path, { provider: "convex", deploymentUrl: "https://other-owl-456.convex.cloud", syncKey: key });
      const fromEnvironment = "b".repeat(44);
      expect(loadRemoteConfig({ defaultConfigPath: path, environment: { LEAFLOGUE_CONVEX_SYNC_KEY: fromEnvironment }, platform: "linux" }))
        .toMatchObject({ syncKey: fromEnvironment });
      writeRemoteConfig(path, { provider: "postgres", databaseUrl: "postgresql://reader@db.example.test/leaflogue?sslmode=require" });
      writeRemoteConfig(path, { provider: "convex", deploymentUrl: "https://quiet-otter-123.convex.cloud" });
      expect(summarizeRemoteConfig(loadRemoteConfig({ defaultConfigPath: path, environment: {}, platform: "linux" })).syncKeySaved).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists setup completion without replacing existing protected settings", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-setup-config-"));
    const path = join(directory, "config.json");
    try {
      writeRemoteConfig(path, { provider: "convex", deploymentUrl: "https://quiet-otter-123.convex.cloud" });
      expect(setupCompletedVersion({ defaultConfigPath: path, environment: {}, platform: "linux" })).toBeUndefined();
      writeSetupCompletion(path, CURRENT_SETUP_VERSION, "linux");
      expect(setupCompletedVersion({ defaultConfigPath: path, environment: {}, platform: "linux" })).toBe(CURRENT_SETUP_VERSION);
      expect(loadRemoteConfig({ defaultConfigPath: path, environment: {}, platform: "linux" }))
        .toMatchObject({ provider: "convex", deploymentUrl: "https://quiet-otter-123.convex.cloud" });
      expect(statMode(path)).toBe(0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses PostgreSQL URLs that would quietly connect without verified TLS", () => {
    const write = (databaseUrl: string) => () => writeRemoteConfig("/does/not/matter.json", { provider: "postgres", databaseUrl });
    expect(write("postgresql://reader:secret@db.example.test/library?SSLMODE=require")).toThrow(/lower case/);
    expect(write("postgresql://reader:secret@db.example.test/library?SslMode=require")).toThrow(/lower case/);
    expect(write("postgresql://reader:secret@db.example.test/library?sslmode=require&uselibpqcompat=true")).toThrow(/weaken TLS/);
    expect(write("postgresql://reader:secret@db.example.test/library?sslmode=require&sslkey=/home/reader/.ssh/id_ed25519")).toThrow(/client certificates/);
  });

  it("keeps automatic update checks off until turned on, without touching other settings", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-update-config-"));
    const path = join(directory, "config.json");
    try {
      expect(loadUpdatePreferences({ defaultConfigPath: path, environment: {}, platform: "linux" })).toEqual({ automaticCheck: false });
      writeRemoteConfig(path, { provider: "convex", deploymentUrl: "https://quiet-otter-123.convex.cloud" });
      expect(writeUpdatePreferences(path, { automaticCheck: true }, "linux")).toEqual({ automaticCheck: true });
      expect(loadUpdatePreferences({ defaultConfigPath: path, environment: {}, platform: "linux" })).toEqual({ automaticCheck: true });
      expect(loadRemoteConfig({ defaultConfigPath: path, environment: {}, platform: "linux" })).toMatchObject({ provider: "convex" });
      expect(statMode(path)).toBe(0o600);
      expect(() => writeUpdatePreferences(path, { automaticCheck: "yes" } as never, "linux")).toThrow(/invalid/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("loads a PostgreSQL URL from the environment and only exposes a redacted summary", () => {
    const config = loadRemoteConfig({
      defaultConfigPath: "/does/not/exist",
      environment: { LEAFLOGUE_DATABASE_URL: "postgresql://reader:secret@db.example.test:5432/my%20library?sslmode=require" },
      platform: "linux",
    });
    expect(config?.provider).toBe("postgres");
    if (!config || config.provider !== "postgres") throw new Error("PostgreSQL config missing");
    expect(config.connectionString).toContain("secret");
    const summary = summarizeRemoteConfig(config);
    expect(summary).toEqual({
      configured: true,
      provider: "postgres",
      source: "environment",
      host: "db.example.test",
      database: "my library",
      transport: "tls",
    });
    expect(JSON.stringify(summary)).not.toContain("reader");
    expect(JSON.stringify(summary)).not.toContain("secret");
  });

  it("resolves an environment variable named by a protected config file", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-remote-config-"));
    const path = join(directory, "config.json");
    try {
      writeFileSync(path, JSON.stringify({ sync: { provider: "postgres", databaseUrlEnv: "MY_DATABASE_URL" } }), { mode: 0o600 });
      const config = loadRemoteConfig({
        defaultConfigPath: path,
        environment: { MY_DATABASE_URL: "postgres://leaflogue:pw@localhost/leaflogue" },
        platform: "linux",
      });
      expect(config).toMatchObject({ provider: "postgres", source: "environment" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a config file readable by other users", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-remote-config-"));
    const path = join(directory, "config.json");
    try {
      writeFileSync(path, JSON.stringify({ sync: { provider: "postgres", databaseUrl: "postgres://localhost/leaflogue" } }));
      chmodSync(path, 0o644);
      expect(() => loadRemoteConfig({ defaultConfigPath: path, environment: {}, platform: "linux" }))
        .toThrow(/permissions must be 0600/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("treats a missing default config as local-only mode", () => {
    expect(loadRemoteConfig({ defaultConfigPath: "/does/not/exist", environment: {}, platform: "linux" }))
      .toBeUndefined();
    expect(summarizeRemoteConfig(undefined)).toEqual({ configured: false });
  });

  it("writes an atomic protected PostgreSQL config that can be loaded again", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-remote-write-"));
    const path = join(directory, "config.json");
    try {
      writeRemoteConfig(path, { provider: "postgres", databaseUrl: "postgres://leaflogue:secret@db.test/library?sslmode=require" });
      expect(statMode(path)).toBe(0o600);
      expect(loadRemoteConfig({ defaultConfigPath: path, environment: {}, platform: "linux" }))
        .toMatchObject({ provider: "postgres", source: "config" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("stores and redacts a Convex deployment configuration", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-convex-config-"));
    const path = join(directory, "config.json");
    try {
      const config = writeRemoteConfig(path, { provider: "convex", deploymentUrl: "https://quiet-otter-123.convex.cloud" });
      expect(summarizeRemoteConfig(config)).toEqual({
        configured: true,
        provider: "convex",
        source: "config",
        host: "quiet-otter-123.convex.cloud",
        deployment: "quiet-otter-123",
        transport: "tls",
        syncKeySaved: false,
      });
      expect(loadRemoteConfig({ defaultConfigPath: path, environment: {}, platform: "linux" }))
        .toEqual(config);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts only a credential-free Convex deployment origin", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-convex-origin-"));
    const path = join(directory, "config.json");
    try {
      for (const deploymentUrl of [
        "https://user:secret@example.convex.cloud",
        "https://example.convex.cloud/functions",
        "https://example.convex.cloud?token=secret",
        "https://example.convex.cloud#fragment",
      ]) {
        expect(() => writeRemoteConfig(path, { provider: "convex", deploymentUrl })).toThrow(/credential-free deployment origin/);
      }
      expect(() => writeRemoteConfig(path, { provider: "convex", deploymentUrl: "http://[::1]:3210" })).not.toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("updates only the sync section and preserves future configuration sections", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-config-merge-"));
    const path = join(directory, "config.json");
    try {
      const ai = {
        enabled: false,
        selectedProvider: "anthropic",
        providers: { anthropic: { apiKey: "preserve-me", models: ["configured-model"] } },
      };
      writeFileSync(path, JSON.stringify({ version: 1, ai, extensionSetting: { retained: true } }), { mode: 0o600 });

      writeRemoteConfig(path, { provider: "postgres", databaseUrl: "postgres://leaflogue:secret@db.test/library?sslmode=require" });

      const saved = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(saved).toMatchObject({ version: 1, ai, extensionSetting: { retained: true } });
      expect(saved.sync).toEqual({ provider: "postgres", databaseUrl: "postgres://leaflogue:secret@db.test/library?sslmode=require" });
      expect(readdirSync(directory)).toEqual(["config.json"]);
      expect(statMode(path)).toBe(0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("copies the complete active configuration when its location changes", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-config-relocate-"));
    const sourcePath = join(directory, "active.json");
    const destinationPath = join(directory, "selected.json");
    try {
      const ai = {
        enabled: false,
        selectedProvider: "anthropic",
        providers: { anthropic: { apiKey: "preserve-me", defaultModel: "model", models: ["model"] } },
      };
      writeFileSync(sourcePath, JSON.stringify({ version: 1, ai, extensionSetting: { retained: true } }), { mode: 0o600 });
      writeFileSync(destinationPath, JSON.stringify({ version: 1, ai: {
        enabled: true,
        selectedProvider: "openai",
        providers: { openai: { apiKey: "destination-only-key", defaultModel: "old", models: ["old"] } },
      } }), { mode: 0o600 });

      writeRemoteConfig(destinationPath, {
        provider: "convex",
        deploymentUrl: "https://quiet-otter-123.convex.cloud",
      }, { sourcePath, platform: "linux" });

      const saved = JSON.parse(readFileSync(destinationPath, "utf8")) as Record<string, unknown>;
      expect(saved).toMatchObject({ version: 1, ai, extensionSetting: { retained: true } });
      expect(saved.sync).toEqual({ provider: "convex", deploymentUrl: "https://quiet-otter-123.convex.cloud" });
      expect(JSON.stringify(saved)).not.toContain("destination-only-key");
      expect(summarizeAiConfig({ defaultConfigPath: destinationPath, environment: {}, platform: "linux" }))
        .toMatchObject({ enabled: false, selectedProvider: "anthropic", providers: [{ credential: "saved" }, { id: "gemini" }] });
      expect(readFileSync(sourcePath, "utf8")).toContain("preserve-me");
      expect(statMode(destinationPath)).toBe(0o600);
      expect(readdirSync(directory).sort()).toEqual(["active.json", "selected.json"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps a relative custom theme pointed at the same file when relocating configuration", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-config-theme-relocate-"));
    const sourceDirectory = join(directory, "source");
    const destinationDirectory = join(directory, "destination");
    const sourcePath = join(sourceDirectory, "active.json");
    const destinationPath = join(destinationDirectory, "selected.json");
    const themePath = join(sourceDirectory, "themes", "rose-pine.json");
    try {
      mkdirSync(join(sourceDirectory, "themes"), { recursive: true });
      mkdirSync(destinationDirectory, { recursive: true });
      writeFileSync(themePath, JSON.stringify({ id: "rose-pine-custom" }), { mode: 0o600 });
      writeFileSync(sourcePath, JSON.stringify({
        version: 1,
        appearance: {
          themeId: "rose-pine-custom",
          mode: "dark",
          themeFile: "themes/rose-pine.json",
          overrides: { "rose-pine": { accent: "#c4a7e7" } },
        },
      }), { mode: 0o600 });

      writeRemoteConfig(destinationPath, {
        provider: "convex",
        deploymentUrl: "https://quiet-otter-123.convex.cloud",
      }, { sourcePath, platform: "linux" });

      const saved = JSON.parse(readFileSync(destinationPath, "utf8")) as {
        appearance: { themeFile: string; overrides: unknown };
      };
      expect(saved.appearance.themeFile).toBe(themePath);
      expect(saved.appearance.overrides).toEqual({ "rose-pine": { accent: "#c4a7e7" } });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("restores the destination when publishing its new location fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-config-rollback-"));
    const sourcePath = join(directory, "active.json");
    const destinationPath = join(directory, "selected.json");
    try {
      const originalDestination = { version: 1, extensionSetting: { original: true } };
      writeFileSync(sourcePath, JSON.stringify({ version: 1, ai: {
        enabled: false,
        providers: { openai: { apiKey: "source-key", defaultModel: "model", models: ["model"] } },
      } }), { mode: 0o600 });
      writeFileSync(destinationPath, JSON.stringify(originalDestination), { mode: 0o600 });

      expect(() => writeRemoteConfig(destinationPath, {
        provider: "convex",
        deploymentUrl: "https://quiet-otter-123.convex.cloud",
      }, { sourcePath, platform: "linux", activate: () => { throw new Error("locator failed"); } }))
        .toThrow(/locator failed/);

      expect(JSON.parse(readFileSync(destinationPath, "utf8"))).toEqual(originalDestination);

      const newDestinationPath = join(directory, "new-selected.json");
      expect(() => writeRemoteConfig(newDestinationPath, {
        provider: "convex",
        deploymentUrl: "https://quiet-otter-123.convex.cloud",
      }, { sourcePath, platform: "linux", activate: () => { throw new Error("locator failed"); } }))
        .toThrow(/locator failed/);
      expect(() => readFileSync(newDestinationPath, "utf8")).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("restores an exact compact destination even when formatting it would exceed the size limit", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-config-byte-rollback-"));
    const sourcePath = join(directory, "active.json");
    const destinationPath = join(directory, "compact.json");
    try {
      writeFileSync(sourcePath, JSON.stringify({ version: 1, ai: {
        enabled: false,
        providers: { openai: { apiKey: "source-key", defaultModel: "model", models: ["model"] } },
      } }), { mode: 0o600 });
      const compactDestination = JSON.stringify({ version: 1, extensionSetting: {
        values: Array.from({ length: 10_000 }, (_, index) => index % 10),
      } });
      expect(Buffer.byteLength(compactDestination)).toBeLessThan(64 * 1024);
      expect(Buffer.byteLength(JSON.stringify(JSON.parse(compactDestination), null, 2))).toBeGreaterThan(64 * 1024);
      writeFileSync(destinationPath, compactDestination, { mode: 0o600 });

      expect(() => writeRemoteConfig(destinationPath, {
        provider: "convex",
        deploymentUrl: "https://quiet-otter-123.convex.cloud",
      }, { sourcePath, platform: "linux", activate: () => { throw new Error("locator failed"); } }))
        .toThrow(/locator failed/);

      expect(readFileSync(destinationPath, "utf8")).toBe(compactDestination);
      expect(statMode(destinationPath)).toBe(0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite malformed or newer configuration documents", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-config-guard-"));
    const path = join(directory, "config.json");
    try {
      writeFileSync(path, "[]", { mode: 0o600 });
      expect(() => loadRemoteConfig({ defaultConfigPath: path, environment: {}, platform: "linux" }))
        .toThrow(/root must be an object/);
      expect(() => writeRemoteConfig(path, { provider: "convex", deploymentUrl: "https://example.convex.cloud" }))
        .toThrow(/root must be an object/);
      expect(readFileSync(path, "utf8")).toBe("[]");

      writeFileSync(path, JSON.stringify({ version: 2, ai: { enabled: true } }), { mode: 0o600 });
      expect(() => loadRemoteConfig({ defaultConfigPath: path, environment: {}, platform: "linux" }))
        .toThrow(/version is not supported/);
      expect(() => writeRemoteConfig(path, { provider: "convex", deploymentUrl: "https://example.convex.cloud" }))
        .toThrow(/version is not supported/);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 2, ai: { enabled: true } });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requires TLS for non-loopback PostgreSQL and honors an explicit provider", () => {
    expect(() => loadRemoteConfig({
      defaultConfigPath: "/does/not/exist",
      environment: { LEAFLOGUE_DATABASE_URL: "postgres://reader:secret@db.example.test/library" },
      platform: "linux",
    })).toThrow(/must require TLS/);
    expect(() => loadRemoteConfig({
      defaultConfigPath: "/does/not/exist",
      environment: { LEAFLOGUE_SYNC_PROVIDER: "postgres" },
      platform: "linux",
    })).toThrow(/LEAFLOGUE_DATABASE_URL is unavailable/);
  });

  it("rejects PostgreSQL host and duplicate-TLS query overrides", () => {
    for (const databaseUrl of [
      "postgres://reader:secret@localhost/library?host=remote.example.test&sslmode=disable",
      "postgres://reader:secret@db.example.test/library?sslmode=require&sslmode=disable",
      "postgres://reader:secret@db.example.test/library?sslmode=require&ssl=false",
    ]) {
      expect(() => loadRemoteConfig({
        defaultConfigPath: "/does/not/exist",
        environment: { LEAFLOGUE_DATABASE_URL: databaseUrl },
        platform: "linux",
      })).toThrow(/override host or TLS|at most one sslmode/);
    }
  });
});

const DEFAULT_GEMINI = {
  id: "gemini",
  models: ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-3.5-flash-lite", "gemini-flash-lite-latest"],
  defaultModel: "gemini-2.5-flash",
  selectedModel: "gemini-2.5-flash",
  capabilities: ["chat", "structured-output"],
  credential: "missing",
  consented: false,
} as const;

describe("desktop AI configuration", () => {
  it("offers Gemini by default and saves a key without copying its catalog", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-ai-gemini-"));
    const path = join(directory, "config.json");
    const sync = { provider: "convex", deploymentUrl: "https://quiet-otter-123.convex.cloud" };
    try {
      writeFileSync(path, JSON.stringify({ version: 1, sync }), { mode: 0o600 });
      expect(summarizeAiConfig({ defaultConfigPath: path, environment: {}, platform: "linux" }))
        .toEqual({ enabled: false, providers: [DEFAULT_GEMINI] });
      expect(summarizeAiConfig({ defaultConfigPath: path, environment: { GEMINI_API_KEY: "free-tier-key" }, platform: "linux" }).providers)
        .toEqual([{ ...DEFAULT_GEMINI, credential: "environment" }]);

      const summary = writeAiConfig(path, { enabled: true, selectedProvider: "gemini", selectedModel: "gemini-3.5-flash-lite", apiKey: " studio-key " }, {});
      expect(summary).toEqual({ enabled: true, selectedProvider: "gemini", providers: [{ ...DEFAULT_GEMINI, selectedModel: "gemini-3.5-flash-lite", credential: "saved" }] });
      const stored = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(stored).toEqual({
        version: 1,
        sync,
        ai: { enabled: true, selectedProvider: "gemini", selectedModels: { gemini: "gemini-3.5-flash-lite" }, providers: { gemini: { apiKey: "studio-key" } } },
      });
      expect(statMode(path)).toBe(0o600);

      // No request may leave this process before the reader accepts the terms.
      expect(() => loadAiRuntimeProvider({ defaultConfigPath: path, environment: {}, platform: "linux" }))
        .toThrow(/has not been accepted yet/);
      expect(acceptAiProviderTerms(path, "gemini", {}, 1_700_000_000_000).providers)
        .toEqual([{ ...DEFAULT_GEMINI, selectedModel: "gemini-3.5-flash-lite", credential: "saved", consented: true }]);
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
        sync,
        ai: { enabled: true, providers: { gemini: { apiKey: "studio-key", consentAcceptedAt: 1_700_000_000_000 } } },
      });
      expect(() => acceptAiProviderTerms(path, "mistral", {})).toThrow(/unavailable/);
      expect(loadAiRuntimeProvider({ defaultConfigPath: path, environment: {}, platform: "linux" }))
        .toEqual({ id: "gemini", model: "gemini-3.5-flash-lite", apiKey: "studio-key" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps the documented AI example valid, with Gemini inheriting the defaults", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-ai-example-"));
    const path = join(directory, "config.json");
    try {
      writeFileSync(path, readFileSync(fileURLToPath(new URL("../../../config.ai.example.json", import.meta.url))), { mode: 0o600 });
      const summary = summarizeAiConfig({ defaultConfigPath: path, environment: {}, platform: "linux" });
      expect(summary.providers.find(({ id }) => id === "gemini")).toEqual(DEFAULT_GEMINI);
      expect(summary.providers.map(({ id }) => id)).toEqual(["openai", "anthropic", "gemini", "mistral", "xai", "deepseek", "openai-compatible"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("lets a configured Gemini entry pin its own models instead of inheriting", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-ai-gemini-pinned-"));
    const path = join(directory, "config.json");
    try {
      writeFileSync(path, JSON.stringify({ version: 1, ai: { enabled: false, providers: {
        gemini: { apiKeyEnv: "MY_GEMINI_KEY", defaultModel: "gemini-2.5-flash", models: ["gemini-2.5-flash"] },
      } } }), { mode: 0o600 });
      expect(summarizeAiConfig({ defaultConfigPath: path, environment: { MY_GEMINI_KEY: "k" }, platform: "linux" }).providers)
        .toEqual([{ id: "gemini", models: ["gemini-2.5-flash"], defaultModel: "gemini-2.5-flash", selectedModel: "gemini-2.5-flash", capabilities: ["chat", "structured-output"], credential: "environment", consented: false }]);
      expect(() => writeAiConfig(path, { enabled: true, selectedProvider: "gemini", selectedModel: "gemini-3.8-flash" }, {}))
        .toThrow(/model is unavailable/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resolves the enabled provider only inside the trusted runtime boundary", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-ai-runtime-"));
    const path = join(directory, "config.json");
    try {
      writeFileSync(path, JSON.stringify({ version: 1, ai: {
        enabled: true,
        selectedProvider: "openai",
        selectedModels: { openai: "model-b" },
        providers: { openai: { apiKeyEnv: "TEST_AI_KEY", defaultModel: "model-a", models: ["model-a", "model-b"], capabilities: ["chat"], consentAcceptedAt: 1_700_000_000_000 } },
      } }), { mode: 0o600 });
      expect(loadAiRuntimeProvider({ defaultConfigPath: path, environment: { TEST_AI_KEY: "environment-secret" }, platform: "linux" }))
        .toEqual({ id: "openai", model: "model-b", apiKey: "environment-secret" });
      expect(summarizeAiConfig({ defaultConfigPath: path, environment: { TEST_AI_KEY: "environment-secret" }, platform: "linux" }))
        .toMatchObject({ enabled: true, providers: [{ credential: "environment" }, { id: "gemini" }] });
      expect(() => loadAiRuntimeProvider({ defaultConfigPath: path, environment: {}, platform: "linux" })).toThrow(/credential is unavailable/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("is disabled by default and never returns saved keys", () => {
    expect(summarizeAiConfig({ defaultConfigPath: "/does/not/exist", environment: {}, platform: "linux" }))
      .toEqual({ enabled: false, providers: [DEFAULT_GEMINI] });

    const directory = mkdtempSync(join(tmpdir(), "leaflogue-ai-config-"));
    const path = join(directory, "config.json");
    try {
      writeFileSync(path, JSON.stringify({ version: 1, ai: {
        enabled: false,
        selectedProvider: "anthropic",
        providers: {
          anthropic: { apiKey: "stored-secret", defaultModel: "model-a", models: ["model-a", "model-b"] },
          openai: { apiKeyEnv: "MY_OPENAI_KEY", defaultModel: "model-c", models: ["model-c"] },
        },
      } }), { mode: 0o600 });
      const summary = summarizeAiConfig({ defaultConfigPath: path, environment: { MY_OPENAI_KEY: "environment-secret" }, platform: "linux" });
      expect(summary).toEqual({
        enabled: false,
        selectedProvider: "anthropic",
        providers: [
          { id: "anthropic", models: ["model-a", "model-b"], defaultModel: "model-a", selectedModel: "model-a", capabilities: [], credential: "saved", consented: false },
          { id: "openai", models: ["model-c"], defaultModel: "model-c", selectedModel: "model-c", capabilities: [], credential: "environment", consented: false },
          DEFAULT_GEMINI,
        ],
      });
      expect(JSON.stringify(summary)).not.toContain("secret");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("atomically updates only AI state and preserves sync configuration", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-ai-write-"));
    const path = join(directory, "config.json");
    const sync = { provider: "convex", deploymentUrl: "https://quiet-otter-123.convex.cloud" };
    try {
      writeFileSync(path, JSON.stringify({ version: 1, sync, ai: {
        enabled: false,
        selectedProvider: "openai",
        selectedModels: { openai: "model-a" },
        providers: { openai: { defaultModel: "model-a", models: ["model-a", "model-b"] } },
      } }), { mode: 0o600 });
      const summary = writeAiConfig(path, {
        enabled: true,
        selectedProvider: "openai",
        selectedModel: "model-b",
        apiKey: " replacement-secret ",
      }, {});
      expect(summary).toEqual({
        enabled: true,
        selectedProvider: "openai",
        providers: [{ id: "openai", models: ["model-a", "model-b"], defaultModel: "model-a", selectedModel: "model-b", capabilities: [], credential: "saved", consented: false }, DEFAULT_GEMINI],
      });
      const stored = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(stored.sync).toEqual(sync);
      expect(stored).toMatchObject({ ai: { enabled: true, selectedModels: { openai: "model-b" }, providers: { openai: { apiKey: "replacement-secret" } } } });
      expect(statMode(path)).toBe(0o600);
      expect(readdirSync(directory)).toEqual(["config.json"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects unknown models and malformed catalogs without changing the file", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-ai-invalid-"));
    const path = join(directory, "config.json");
    try {
      const original = JSON.stringify({ version: 1, ai: { enabled: false, providers: { openai: { defaultModel: "model-a", models: ["model-a"] } } } });
      writeFileSync(path, original, { mode: 0o600 });
      expect(() => writeAiConfig(path, { enabled: true, selectedProvider: "openai", selectedModel: "invented" }, {}))
        .toThrow(/model is unavailable/);
      expect(readFileSync(path, "utf8")).toBe(original);

      writeFileSync(path, JSON.stringify({ version: 1, ai: { enabled: true, providers: { openai: { defaultModel: "missing", models: ["model-a"] } } } }), { mode: 0o600 });
      expect(() => summarizeAiConfig({ defaultConfigPath: path, environment: {}, platform: "linux" }))
        .toThrow(/default model is invalid/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("validates compatible endpoints and capabilities before credentials can use them", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-ai-endpoint-"));
    const path = join(directory, "config.json");
    try {
      writeFileSync(path, JSON.stringify({ version: 1, ai: { enabled: false, providers: {
        "openai-compatible": {
          endpoint: "http://remote.example.test/v1?send=secret",
          defaultModel: "local-model",
          models: ["local-model"],
          capabilities: ["chat"],
        },
      } } }), { mode: 0o600 });
      expect(() => summarizeAiConfig({ defaultConfigPath: path, environment: {}, platform: "linux" }))
        .toThrow(/credential-free HTTPS/);

      writeFileSync(path, JSON.stringify({ version: 1, ai: { enabled: false, providers: {
        openai: { endpoint: "https://proxy.example.test/v1", defaultModel: "model", models: ["model"], capabilities: ["telepathy"] },
      } } }), { mode: 0o600 });
      expect(() => summarizeAiConfig({ defaultConfigPath: path, environment: {}, platform: "linux" }))
        .toThrow(/capabilities are invalid|cannot override/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("projects safe compatible endpoint and capability metadata without credentials", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-ai-summary-"));
    const path = join(directory, "config.json");
    try {
      writeFileSync(path, JSON.stringify({ version: 1, ai: {
        enabled: true,
        selectedProvider: "openai-compatible",
        selectedModels: { "openai-compatible": "local-large" },
        providers: { "openai-compatible": {
          endpoint: "https://models.example.test/v1/",
          apiKeyEnv: "LOCAL_AI_KEY",
          defaultModel: "local-small",
          models: ["local-small", "local-large"],
          capabilities: ["chat", "structured-output"],
        } },
      } }), { mode: 0o600 });
      const summary = summarizeAiConfig({ defaultConfigPath: path, environment: { LOCAL_AI_KEY: "private-key" }, platform: "linux" });
      expect(summary.providers).toEqual([{
        id: "openai-compatible",
        models: ["local-small", "local-large"],
        defaultModel: "local-small",
        selectedModel: "local-large",
        endpoint: "https://models.example.test/v1",
        capabilities: ["chat", "structured-output"],
        credential: "environment",
        consented: false,
      }, DEFAULT_GEMINI]);
      expect(JSON.stringify(summary)).not.toContain("LOCAL_AI_KEY");
      expect(JSON.stringify(summary)).not.toContain("private-key");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses a write that would make the shared config unreadable", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-ai-size-"));
    const path = join(directory, "config.json");
    try {
      const original = JSON.stringify({ version: 1, padding: "x".repeat(60 * 1024), ai: {
        enabled: false,
        providers: { openai: { defaultModel: "model", models: ["model"] } },
      } });
      writeFileSync(path, original, { mode: 0o600 });
      expect(() => writeAiConfig(path, {
        enabled: true,
        selectedProvider: "openai",
        selectedModel: "model",
        apiKey: "k".repeat(8_000),
      }, {})).toThrow(/smaller than 64 KiB/);
      expect(readFileSync(path, "utf8")).toBe(original);
      expect(readdirSync(directory)).toEqual(["config.json"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function statMode(path: string): number {
  return statSync(path).mode & 0o777;
}
