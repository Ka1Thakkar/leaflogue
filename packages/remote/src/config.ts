import { DEFAULT_AI_PROVIDERS as SHARED_DEFAULT_AI_PROVIDERS, type AiProviderDefaults } from "@leaflogue/ai";
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { AiConfigurationSummary, AiSettingsInput, AppearanceConfiguration, AppearanceSettingsInput, CustomWidget, DashboardId, DashboardLayouts, DashboardPlacement, ThemeDefinition, WidgetImportReceipt } from "@leaflogue/contracts";
import { DASHBOARD_IDS, isCustomWidgetSlot, WIDGET_LIMITS } from "@leaflogue/contracts";
import { CUSTOM_WIDGET_ID, customWidgetFile, customWidgetIdFor, parseCustomWidget, parseCustomWidgetFile, parseCustomWidgets, parseDashboardLayout, sameRecipe } from "@leaflogue/domain";
import type { AiRuntimeProvider } from "@leaflogue/ai";
import { appearanceConfiguration, applyThemeOverrides, BUILT_IN_THEMES, parseThemeManifest, parseThemeOverrides, validateAppearanceSettings, type ThemeManifest, type ThemeOverrides } from "@leaflogue/appearance";

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_THEME_BYTES = 32 * 1024;
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]*$/;
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const AI_PROVIDER_IDS = new Set(["openai", "anthropic", "gemini", "mistral", "xai", "deepseek", "openai-compatible"]);
const AI_CAPABILITIES = new Set(["chat", "structured-output", "vision", "tools"]);
const BUILT_IN_THEME_IDS = new Set(BUILT_IN_THEMES.map(({ id }) => id));

/**
 * Providers available without editing the config (shared with servers through
 * @leaflogue/ai). A configured entry may omit models, default model,
 * capabilities, or key variable to inherit these, so the list follows
 * application releases unless the reader pins their own.
 */
const DEFAULT_AI_PROVIDERS: Readonly<Record<string, AiProviderDefaults>> =
  SHARED_DEFAULT_AI_PROVIDERS as Readonly<Record<string, AiProviderDefaults>>;

export type RemoteConfig =
  | { readonly provider: "postgres"; readonly connectionString: string; readonly source: "environment" | "config" }
  | {
      readonly provider: "convex";
      readonly deploymentUrl: string;
      readonly source: "environment" | "config";
      /** The deployment's `LEAFLOGUE_SYNC_KEY`; absent until the reader saves it. */
      readonly syncKey?: string;
    };

export type RemoteConfigInput =
  | { readonly provider: "postgres"; readonly databaseUrl: string }
  /** Omitting `syncKey` keeps the saved key when the provider stays Convex. */
  | { readonly provider: "convex"; readonly deploymentUrl: string; readonly syncKey?: string };

export interface RemoteConfigSummary {
  readonly configured: boolean;
  readonly provider?: "postgres" | "convex";
  readonly source?: "environment" | "config";
  readonly host?: string;
  readonly database?: string;
  readonly deployment?: string;
  readonly transport?: "tls" | "unspecified";
  readonly problem?: string;
  /** Redacted: whether a Convex sync key is available, never its value. */
  readonly syncKeySaved?: boolean;
}

interface ConfigFile extends Record<string, unknown> {
  readonly version?: unknown;
  readonly setup?: {
    readonly completedVersion?: unknown;
  };
  readonly sync?: {
    readonly provider?: unknown;
    readonly databaseUrl?: unknown;
    readonly databaseUrlEnv?: unknown;
    readonly deploymentUrl?: unknown;
    readonly syncKey?: unknown;
    readonly syncKeyEnv?: unknown;
  };
  readonly ai?: unknown;
  readonly appearance?: unknown;
  readonly updates?: {
    readonly automaticCheck?: unknown;
  };
  readonly dashboards?: unknown;
  readonly widgets?: unknown;
}

export const CURRENT_SETUP_VERSION = 1;

export function setupCompletedVersion(options: {
  readonly defaultConfigPath: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}): number | undefined {
  const environment = options.environment ?? process.env;
  const path = environment.LEAFLOGUE_CONFIG_FILE?.trim() || options.defaultConfigPath;
  const document = readConfigDocument(path, options.platform ?? process.platform);
  const version = document?.setup?.completedVersion;
  return typeof version === "number" && Number.isSafeInteger(version) && version >= 1 ? version : undefined;
}

export function writeSetupCompletion(path: string, version = CURRENT_SETUP_VERSION, platform: NodeJS.Platform = process.platform): void {
  if (!Number.isSafeInteger(version) || version < 1 || version > CURRENT_SETUP_VERSION) {
    throw new Error("Setup completion version is invalid");
  }
  const document = readConfigDocument(path, platform) ?? {};
  writeConfigDocument(path, { ...document, version: 1, setup: { completedVersion: version } });
}

/** Update preferences (ADR 0007). Automatic checks are off unless the reader turns them on. */
export interface UpdatePreferences {
  readonly automaticCheck: boolean;
}

export function loadUpdatePreferences(options: {
  readonly defaultConfigPath: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}): UpdatePreferences {
  const environment = options.environment ?? process.env;
  const path = environment.LEAFLOGUE_CONFIG_FILE?.trim() || options.defaultConfigPath;
  const document = readConfigDocument(path, options.platform ?? process.platform);
  return { automaticCheck: document?.updates?.automaticCheck === true };
}

/** Replace only the `updates` section, keeping every other setting. */
export function writeUpdatePreferences(path: string, input: UpdatePreferences, platform: NodeJS.Platform = process.platform): UpdatePreferences {
  if (typeof input?.automaticCheck !== "boolean") throw new Error("Update preferences are invalid");
  const document = readConfigDocument(path, platform) ?? {};
  writeConfigDocument(path, { ...document, version: 1, updates: { automaticCheck: input.automaticCheck } });
  return { automaticCheck: input.automaticCheck };
}

/** Validate one dashboard's widget list; shared with the web app's backends. */
export { parseDashboardLayout };

function parseDashboardsDocument(value: unknown): Layouts {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Dashboard layouts are invalid");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !(DASHBOARD_IDS as readonly string[]).includes(key))) throw new Error("Dashboard layouts contain unknown dashboards");
  return {
    ...(input.library !== undefined ? { library: parseDashboardLayout(input.library) } : {}),
    ...(input.statistics !== undefined ? { statistics: parseDashboardLayout(input.statistics) } : {}),
  };
}

type Layouts = { -readonly [K in DashboardId]?: readonly DashboardPlacement[] };

/** Drop placements of custom widgets that no longer exist. */
function placedWidgetsOnly(layouts: Omit<DashboardLayouts, "problem" | "widgets">, widgets: readonly CustomWidget[]): Layouts {
  const known = new Set(widgets.map(({ id }) => `custom:${id}`));
  const kept: Layouts = {};
  for (const dashboard of DASHBOARD_IDS) {
    const layout = layouts[dashboard];
    if (layout) kept[dashboard] = layout.filter(({ widget }) => !isCustomWidgetSlot(widget) || known.has(widget));
  }
  return kept;
}

function withWidgets(layouts: Layouts, widgets: readonly CustomWidget[]): DashboardLayouts {
  return { ...placedWidgetsOnly(layouts, widgets), ...(widgets.length > 0 ? { widgets } : {}) };
}

/** Both sections as saved, each replaced by nothing when broken so a save can fix it. */
function currentDashboards(document: ConfigFile): { layouts: Layouts; widgets: CustomWidget[] } {
  let layouts: Layouts;
  let widgets: CustomWidget[];
  try { layouts = parseDashboardsDocument(document.dashboards); } catch { layouts = {}; }
  try { widgets = document.widgets === undefined ? [] : parseCustomWidgets(document.widgets); } catch { widgets = []; }
  return { layouts, widgets };
}

function writeDashboards(path: string, document: ConfigFile, layouts: Layouts, widgets: readonly CustomWidget[]): DashboardLayouts {
  const dashboards = placedWidgetsOnly(layouts, widgets);
  const rest: ConfigFile = { ...document };
  delete (rest as { dashboards?: unknown }).dashboards;
  delete (rest as { widgets?: unknown }).widgets;
  writeConfigDocument(path, {
    ...rest,
    version: 1,
    ...(Object.keys(dashboards).length > 0 ? { dashboards } : {}),
    ...(widgets.length > 0 ? { widgets } : {}),
  });
  return withWidgets(dashboards, widgets);
}

/**
 * The reader's dashboard layouts and custom widgets. A section that does not
 * parse is reported and left out: a broken layout falls back to the default,
 * and broken widgets are not shown.
 */
export function loadDashboardLayouts(options: {
  readonly defaultConfigPath: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}): DashboardLayouts {
  const environment = options.environment ?? process.env;
  const path = environment.LEAFLOGUE_CONFIG_FILE?.trim() || options.defaultConfigPath;
  let document: ConfigFile | undefined;
  try {
    document = readConfigDocument(path, options.platform ?? process.platform);
  } catch (error) {
    return { problem: `Your saved dashboard layout was not used: ${error instanceof Error ? error.message : "it is invalid"}` };
  }
  const problems: string[] = [];
  let layouts: Layouts = {};
  let widgets: CustomWidget[] = [];
  try {
    layouts = parseDashboardsDocument(document?.dashboards);
  } catch (error) {
    problems.push(`Your saved dashboard layout was not used: ${error instanceof Error ? error.message : "it is invalid"}`);
  }
  try {
    widgets = document?.widgets === undefined ? [] : parseCustomWidgets(document.widgets);
  } catch (error) {
    problems.push(`Your custom widgets were not loaded: ${error instanceof Error ? error.message : "they are invalid"}`);
  }
  return { ...withWidgets(layouts, widgets), ...(problems.length > 0 ? { problem: problems.join(". ") } : {}) };
}

/** Replace one dashboard's layout, or remove it with `null` to return to the default. */
export function writeDashboardLayout(
  path: string,
  dashboard: DashboardId,
  layout: unknown,
  platform: NodeJS.Platform = process.platform,
): DashboardLayouts {
  if (!(DASHBOARD_IDS as readonly string[]).includes(dashboard)) throw new Error("Dashboard is unknown");
  const next = layout === null ? undefined : parseDashboardLayout(layout);
  const document = readConfigDocument(path, platform) ?? {};
  const { layouts, widgets } = currentDashboards(document);
  const dashboards: Layouts = { ...layouts };
  if (next) dashboards[dashboard] = next;
  else delete dashboards[dashboard];
  return writeDashboards(path, document, dashboards, widgets);
}

/** Add a custom widget, or replace the one with the same ID where it already sits. */
export function writeCustomWidget(path: string, widget: unknown, platform: NodeJS.Platform = process.platform): DashboardLayouts {
  const parsed = parseCustomWidget(widget);
  const document = readConfigDocument(path, platform) ?? {};
  const { layouts, widgets } = currentDashboards(document);
  const index = widgets.findIndex(({ id }) => id === parsed.id);
  if (index < 0 && widgets.length >= WIDGET_LIMITS.widgets) throw new Error(`You can keep up to ${WIDGET_LIMITS.widgets} custom widgets; delete one to make room`);
  const next = index < 0 ? [...widgets, parsed] : widgets.map((entry, position) => (position === index ? parsed : entry));
  return writeDashboards(path, document, layouts, next);
}

/** Remove a custom widget and every placement of it, in one write. */
export function deleteCustomWidget(path: string, id: unknown, platform: NodeJS.Platform = process.platform): DashboardLayouts {
  if (typeof id !== "string" || !CUSTOM_WIDGET_ID.test(id)) throw new Error("Custom widget is unknown");
  const document = readConfigDocument(path, platform) ?? {};
  const { layouts, widgets } = currentDashboards(document);
  return writeDashboards(path, document, layouts, widgets.filter((widget) => widget.id !== id));
}

/** Write one widget to a file meant for sharing; nothing in it is private. */
export function writeCustomWidgetExport(path: string, widget: CustomWidget): void {
  writeFileAtomically(path, `${JSON.stringify(customWidgetFile(widget), null, 2)}\n`, 0o644);
}

/**
 * Add the widgets in files the reader chose. Every file is read once
 * without following links, bounded, and validated before anything is
 * written; one bad file refuses the whole import. A widget the library
 * already has is skipped, and one whose ID is taken by a different widget
 * gets a new ID.
 */
export function importCustomWidgetFiles(path: string, sourcePaths: readonly string[], platform: NodeJS.Platform = process.platform): WidgetImportReceipt {
  if (sourcePaths.length === 0) throw new Error("Choose at least one widget file");
  if (sourcePaths.length > WIDGET_LIMITS.importFiles) throw new Error(`Import up to ${WIDGET_LIMITS.importFiles} widget files at a time`);
  const incoming = sourcePaths.map((sourcePath) => {
    try {
      return parseCustomWidgetFile(readBoundedJson(sourcePath, WIDGET_LIMITS.fileBytes, platform, "A widget file"));
    } catch (error) {
      throw new Error(`${basename(sourcePath)}: ${error instanceof Error ? error.message : "it is not a widget file"}`, { cause: error });
    }
  });
  const document = readConfigDocument(path, platform) ?? {};
  const { layouts, widgets } = currentDashboards(document);
  const next = [...widgets];
  const added: string[] = [];
  let unchanged = 0;
  for (const widget of incoming) {
    if (next.some((existing) => sameRecipe(existing, widget))) {
      unchanged += 1;
      continue;
    }
    const id = next.some((existing) => existing.id === widget.id) ? customWidgetIdFor(widget.title, next.map((existing) => existing.id)) : widget.id;
    next.push({ ...widget, id });
    added.push(widget.title);
  }
  if (next.length > WIDGET_LIMITS.widgets) throw new Error(`You can keep up to ${WIDGET_LIMITS.widgets} custom widgets; delete some to make room`);
  const result = added.length > 0 ? writeDashboards(path, document, layouts, next) : withWidgets(layouts, widgets);
  return { layouts: result, added, unchanged };
}

/** Read a small JSON file the reader chose, without following links. */
function readBoundedJson(sourcePath: string, maxBytes: number, platform: NodeJS.Platform, label: string): unknown {
  let descriptor: number | undefined;
  try {
    try {
      descriptor = openSync(sourcePath, constants.O_RDONLY | (platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
    } catch (error) {
      throw new Error("Leaflogue could not read it; choose a regular file rather than a link", { cause: error });
    }
    const tooLarge = `${label} must be a regular file smaller than ${Math.round(maxBytes / 1024)} KiB`;
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > maxBytes) throw new Error(tooLarge);
    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < buffer.byteLength) {
      const count = readSync(descriptor, buffer, total, buffer.byteLength - total, total);
      if (count === 0) break;
      total += count;
    }
    if (total > maxBytes) throw new Error(tooLarge);
    try {
      return JSON.parse(buffer.subarray(0, total).toString("utf8"));
    } catch {
      throw new Error(`${label} is not valid JSON`);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function loadRemoteConfig(options: {
  readonly defaultConfigPath: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}): RemoteConfig | undefined {
  const environment = options.environment ?? process.env;
  const directEnvironment = environment.LEAFLOGUE_DATABASE_URL?.trim();
  const convexEnvironment = environment.LEAFLOGUE_CONVEX_URL?.trim();
  const environmentProvider = environment.LEAFLOGUE_SYNC_PROVIDER?.trim().toLocaleLowerCase("en");
  if (environmentProvider && environmentProvider !== "postgres" && environmentProvider !== "convex") {
    throw new Error("LEAFLOGUE_SYNC_PROVIDER must be postgres or convex");
  }
  if (environmentProvider === "postgres") {
    if (!directEnvironment) throw new Error("LEAFLOGUE_DATABASE_URL is unavailable");
    validatePostgresUrl(directEnvironment);
    return { provider: "postgres", connectionString: directEnvironment, source: "environment" };
  }
  const configPath = environment.LEAFLOGUE_CONFIG_FILE?.trim() || options.defaultConfigPath;
  const convexFromEnvironment = (deploymentUrl: string): RemoteConfig => {
    validateConvexUrl(deploymentUrl);
    const file = readConfigDocument(configPath, options.platform ?? process.platform);
    return { provider: "convex", deploymentUrl, source: "environment", ...convexSyncKey(file?.sync, environment) };
  };
  if (environmentProvider === "convex") {
    if (!convexEnvironment) throw new Error("LEAFLOGUE_CONVEX_URL is unavailable");
    return convexFromEnvironment(convexEnvironment);
  }
  if (directEnvironment && convexEnvironment && !environmentProvider) {
    throw new Error("Choose one remote provider with LEAFLOGUE_SYNC_PROVIDER");
  }
  if (!directEnvironment && convexEnvironment) return convexFromEnvironment(convexEnvironment);
  if (directEnvironment) {
    validatePostgresUrl(directEnvironment);
    return { provider: "postgres", connectionString: directEnvironment, source: "environment" };
  }

  const file = readConfigDocument(configPath, options.platform ?? process.platform);
  if (!file) return undefined;
  if (!file.sync) return undefined;
  if (file.sync.provider === "convex") {
    if (typeof file.sync.deploymentUrl !== "string" || !file.sync.deploymentUrl.trim()) {
      throw new Error("The configured Convex deployment URL is unavailable");
    }
    const deploymentUrl = file.sync.deploymentUrl.trim();
    validateConvexUrl(deploymentUrl);
    return { provider: "convex", deploymentUrl, source: "config", ...convexSyncKey(file.sync, environment) };
  }
  if (file.sync.provider !== "postgres") {
    throw new Error("Leaflogue sync provider must be postgres or convex");
  }
  const environmentName = file.sync.databaseUrlEnv;
  let connectionString: string | undefined;
  let source: RemoteConfig["source"] = "config";
  if (typeof environmentName === "string") {
    if (!ENVIRONMENT_NAME.test(environmentName)) throw new Error("Database environment variable name is invalid");
    connectionString = environment[environmentName]?.trim();
    source = "environment";
  }
  if (!connectionString && typeof file.sync.databaseUrl === "string") {
    connectionString = file.sync.databaseUrl.trim();
    source = "config";
  }
  if (!connectionString) throw new Error("The configured database URL is unavailable");
  validatePostgresUrl(connectionString);
  return { provider: "postgres", connectionString, source };
}

export function summarizeRemoteConfig(config: RemoteConfig | undefined): RemoteConfigSummary {
  if (!config) return { configured: false };
  if (config.provider === "convex") {
    const url = validateConvexUrl(config.deploymentUrl);
    return {
      configured: true,
      provider: "convex",
      source: config.source,
      host: url.hostname,
      deployment: url.hostname.split(".")[0] || url.hostname,
      transport: url.protocol === "https:" ? "tls" : "unspecified",
      syncKeySaved: config.syncKey !== undefined,
    };
  }
  const url = validatePostgresUrl(config.connectionString);
  const sslMode = url.searchParams.get("sslmode")?.toLocaleLowerCase("en");
  return {
    configured: true,
    provider: "postgres",
    source: config.source,
    host: url.hostname,
    database: safeDecode(url.pathname.replace(/^\/+/, "")) || undefined,
    transport: isRequiredTlsMode(sslMode) ? "tls" : "unspecified",
  };
}

export function writeRemoteConfig(
  path: string,
  input: RemoteConfigInput,
  options: { readonly sourcePath?: string; readonly platform?: NodeJS.Platform; readonly activate?: () => void } = {},
): RemoteConfig {
  const sync = input.provider === "postgres"
    ? (() => {
        const databaseUrl = input.databaseUrl.trim();
        validatePostgresUrl(databaseUrl);
        return { provider: "postgres" as const, databaseUrl };
      })()
    : (() => {
        const deploymentUrl = input.deploymentUrl.trim();
        validateConvexUrl(deploymentUrl);
        const syncKey = input.syncKey?.trim();
        if (syncKey !== undefined && syncKey !== "") validateSyncKey(syncKey);
        return { provider: "convex" as const, deploymentUrl, ...(syncKey ? { syncKey } : {}) };
      })();
  const platform = options.platform ?? process.platform;
  const destinationExisted = existsSync(path);
  const destinationDocument = readConfigDocument(path, platform) ?? {};
  const destinationBytes = destinationExisted ? readFileSync(path) : undefined;
  const destinationMode = destinationExisted ? statSync(path).mode & 0o777 : 0o600;
  const relocating = Boolean(options.sourcePath && options.sourcePath !== path);
  const sourceDocument = relocating && options.sourcePath
    ? readConfigDocument(options.sourcePath, platform)
    : undefined;
  const document = relocating ? rebaseRelativeThemeFile(sourceDocument ?? {}, options.sourcePath) : destinationDocument;
  // Saving the same deployment without a key keeps the saved key and any key
  // variable. A different deployment never inherits it: otherwise changing the
  // URL alone would send the existing key to whatever server it names.
  const sameDeployment = sync.provider === "convex" && document.sync?.provider === "convex" &&
    typeof document.sync.deploymentUrl === "string" && sameOrigin(document.sync.deploymentUrl, sync.deploymentUrl);
  const retained = sync.provider === "convex" && !sync.syncKey && sameDeployment
    ? { ...(document.sync.syncKey !== undefined ? { syncKey: document.sync.syncKey } : {}),
        ...(document.sync.syncKeyEnv !== undefined ? { syncKeyEnv: document.sync.syncKeyEnv } : {}) }
    : {};
  const updatedDocument: ConfigFile = { ...document, version: 1, sync: { ...sync, ...retained } };
  writeConfigDocument(path, updatedDocument);
  try {
    options.activate?.();
  } catch (error) {
    try {
      if (destinationBytes) writeFileAtomically(path, destinationBytes, destinationMode);
      else rmSync(path, { force: true });
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Leaflogue could not restore the previous configuration", { cause: rollbackError });
    }
    throw error;
  }
  return input.provider === "postgres"
    ? { provider: "postgres", connectionString: input.databaseUrl.trim(), source: "config" }
    : { provider: "convex", deploymentUrl: input.deploymentUrl.trim(), source: "config", ...convexSyncKey(updatedDocument.sync, process.env) };
}

function convexSyncKey(sync: ConfigFile["sync"] | undefined, environment: NodeJS.ProcessEnv): { syncKey?: string } {
  const direct = environment.LEAFLOGUE_CONVEX_SYNC_KEY?.trim();
  if (direct) return { syncKey: validateSyncKey(direct) };
  if (!sync) return {};
  if (sync.syncKeyEnv !== undefined) {
    if (typeof sync.syncKeyEnv !== "string" || !ENVIRONMENT_NAME.test(sync.syncKeyEnv)) {
      throw new Error("Sync key environment variable name is invalid");
    }
    const referenced = environment[sync.syncKeyEnv]?.trim();
    if (referenced) return { syncKey: validateSyncKey(referenced) };
  }
  if (sync.syncKey === undefined) return {};
  if (typeof sync.syncKey !== "string") throw new Error("The configured Convex sync key is invalid");
  return { syncKey: validateSyncKey(sync.syncKey.trim()) };
}

/** Matches the deployment's floor so a too-short key fails here, not on first sync. */
function validateSyncKey(value: string): string {
  if (value.length < 32 || value.length > 512 || !/^[\x21-\x7e]+$/u.test(value)) {
    throw new Error("The Convex sync key must be 32 to 512 printable characters");
  }
  return value;
}

function rebaseRelativeThemeFile(document: ConfigFile, sourcePath: string | undefined): ConfigFile {
  if (!sourcePath || document.appearance === undefined) return document;
  const appearance = parseAppearanceDocument(document.appearance);
  if (!appearance.themeFile || isAbsolute(appearance.themeFile)) return document;
  return {
    ...document,
    appearance: {
      ...appearance.settings,
      themeFile: resolve(dirname(sourcePath), appearance.themeFile),
      ...(appearance.overrides !== undefined ? { overrides: appearance.overrides } : {}),
    },
  };
}

export function summarizeAiConfig(options: {
  readonly defaultConfigPath: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}): AiConfigurationSummary {
  const environment = options.environment ?? process.env;
  const configPath = environment.LEAFLOGUE_CONFIG_FILE?.trim() || options.defaultConfigPath;
  const document = readConfigDocument(configPath, options.platform ?? process.platform);
  return summarizeAiDocument(parseAiDocument(document?.ai), environment);
}

/** Record the reader's acceptance for one provider, changing nothing else. */
export function acceptAiProviderTerms(path: string, providerId: string, environment: NodeJS.ProcessEnv = process.env, now: number = Date.now()): AiConfigurationSummary {
  const document = readConfigDocument(path, process.platform) ?? {};
  const ai = parseAiDocument(document.ai);
  if (!ai.providers[providerId]) throw new Error("Selected AI provider is unavailable");
  const rawAi = typeof document.ai === "object" && document.ai !== null && !Array.isArray(document.ai)
    ? document.ai as Record<string, unknown>
    : {};
  const rawProviders = typeof rawAi.providers === "object" && rawAi.providers !== null && !Array.isArray(rawAi.providers)
    ? rawAi.providers as Record<string, Record<string, unknown>>
    : {};
  const storedAi = {
    ...rawAi,
    providers: { ...rawProviders, [providerId]: { ...(rawProviders[providerId] ?? {}), consentAcceptedAt: now } },
  };
  const updated = parseAiDocument(storedAi);
  writeConfigDocument(path, { ...document, version: 1, ai: storedAi });
  return summarizeAiDocument(updated, environment);
}

export function loadAiRuntimeProvider(options: {
  readonly defaultConfigPath: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}): AiRuntimeProvider {
  const environment = options.environment ?? process.env;
  const configPath = environment.LEAFLOGUE_CONFIG_FILE?.trim() || options.defaultConfigPath;
  const document = readConfigDocument(configPath, options.platform ?? process.platform);
  if (!document?.ai) throw new Error("AI is not configured");
  const ai = parseAiDocument(document.ai);
  if (!ai.enabled) throw new Error("AI features are disabled");
  if (!ai.selectedProvider) throw new Error("An AI provider has not been selected");
  const provider = ai.providers[ai.selectedProvider];
  if (!provider) throw new Error("The selected AI provider is unavailable");
  if (!provider.capabilities.includes("chat")) throw new Error("The selected AI provider does not enable text generation");
  // Defence in depth: no request can leave this process for a provider whose
  // terms the reader has not explicitly accepted.
  if (typeof provider.consentAcceptedAt !== "number") throw new Error("The selected AI provider has not been accepted yet");
  const apiKey = provider.apiKey?.trim() || (provider.apiKeyEnv ? environment[provider.apiKeyEnv]?.trim() : undefined);
  if (!apiKey) throw new Error("The selected AI provider credential is unavailable");
  return {
    id: ai.selectedProvider as AiRuntimeProvider["id"],
    model: ai.selectedModels[ai.selectedProvider] ?? provider.defaultModel,
    apiKey,
    ...(provider.endpoint ? { endpoint: provider.endpoint } : {}),
  };
}

export function writeAiConfig(path: string, input: AiSettingsInput, environment: NodeJS.ProcessEnv = process.env): AiConfigurationSummary {
  const document = readConfigDocument(path, process.platform) ?? {};
  const ai = parseAiDocument(document.ai);
  const provider = ai.providers[input.selectedProvider];
  if (!provider) throw new Error("Selected AI provider is unavailable");
  if (!provider.models.includes(input.selectedModel)) throw new Error("Selected AI model is unavailable");
  if (input.apiKey !== undefined && input.clearSavedApiKey) throw new Error("Choose either a replacement key or key removal");
  const apiKey = input.apiKey?.trim();
  if (input.apiKey !== undefined && (!apiKey || apiKey.length > 8_192)) throw new Error("AI API key is invalid");

  // Persist only what the reader configured or changed. A default provider's
  // inherited catalog is not copied into the file, so it keeps following
  // application releases.
  const rawAi = typeof document.ai === "object" && document.ai !== null && !Array.isArray(document.ai)
    ? document.ai as Record<string, unknown>
    : {};
  const rawProviders = typeof rawAi.providers === "object" && rawAi.providers !== null && !Array.isArray(rawAi.providers)
    ? rawAi.providers as Record<string, Record<string, unknown>>
    : {};
  const storedProvider: Record<string, unknown> = { ...(rawProviders[input.selectedProvider] ?? {}) };
  if (apiKey) storedProvider.apiKey = apiKey;
  if (input.clearSavedApiKey) delete storedProvider.apiKey;
  const storedAi = {
    ...rawAi,
    enabled: input.enabled,
    selectedProvider: input.selectedProvider,
    selectedModels: { ...ai.selectedModels, [input.selectedProvider]: input.selectedModel },
    providers: { ...rawProviders, [input.selectedProvider]: storedProvider },
  };
  const updatedAi = parseAiDocument(storedAi);
  writeConfigDocument(path, { ...document, version: 1, ai: storedAi });
  return summarizeAiDocument(updatedAi, environment);
}

export function loadAppearanceConfig(options: {
  readonly defaultConfigPath: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}): AppearanceConfiguration {
  const environment = options.environment ?? process.env;
  const configPath = environment.LEAFLOGUE_CONFIG_FILE?.trim() || options.defaultConfigPath;
  return loadAppearanceAt(configPath, options.platform ?? process.platform);
}

function loadAppearanceAt(configPath: string, platform: NodeJS.Platform): AppearanceConfiguration {
  let document: ConfigFile | undefined;
  try {
    document = readConfigDocument(configPath, platform);
  } catch (error) {
    return appearanceConfiguration(undefined, error instanceof Error ? error.message : "Leaflogue could not read its appearance configuration");
  }
  let appearance: ReturnType<typeof parseAppearanceDocument> | undefined;
  try {
    appearance = document?.appearance === undefined ? undefined : parseAppearanceDocument(document.appearance);
  } catch (error) {
    return appearanceConfiguration(undefined, error instanceof Error ? error.message : "Leaflogue appearance configuration is invalid");
  }
  const custom = loadCustomThemes(configPath, appearance?.themeFile, platform);
  const { overrides, problem: overrideProblem } = resolveThemeOverrides(appearance?.overrides, [...BUILT_IN_THEMES, ...custom.themes]);
  let settings: AppearanceSettingsInput | undefined;
  let settingsProblem: string | undefined;
  if (appearance) {
    try {
      settings = validateAppearanceSettings(appearance.settings, availableThemeIds(custom.themes));
    } catch (error) {
      // A broken reference explains a missing theme better than "unavailable".
      if (!custom.referenceProblem) settingsProblem = error instanceof Error ? error.message : "Appearance settings are invalid";
    }
  }
  return appearanceConfiguration(
    settings,
    joinProblems([custom.referenceProblem, settingsProblem, overrideProblem, ...custom.skipped]),
    custom.themes,
    overrides,
  );
}

export function resolveAppearanceFiles(options: {
  readonly defaultConfigPath: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}): { readonly configPath: string; readonly themesDirectory: string; readonly themePath?: string } {
  const environment = options.environment ?? process.env;
  const requestedPath = resolve(environment.LEAFLOGUE_CONFIG_FILE?.trim() || options.defaultConfigPath);
  // Report the same canonical locations the loader validates, so watchers
  // observe exactly the files that decide the active appearance.
  const configPath = canonicalConfigPath(requestedPath);
  const themesDirectory = join(canonicalConfigDirectory(configPath), THEMES_DIRECTORY);
  const document = readConfigDocument(configPath, options.platform ?? process.platform);
  if (document?.appearance === undefined) return { configPath, themesDirectory };
  const appearance = parseAppearanceDocument(document.appearance);
  return {
    configPath,
    themesDirectory,
    ...(appearance.themeFile ? { themePath: expectedThemePath(configPath, appearance.themeFile) } : {}),
  };
}

export function writeAppearanceConfig(path: string, input: AppearanceSettingsInput): AppearanceConfiguration {
  const document = readConfigDocument(path, process.platform) ?? {};
  const appearance: { readonly themeFile?: string; readonly overrides?: unknown } = document.appearance === undefined
    ? {}
    : parseAppearanceDocument(document.appearance);
  const custom = loadCustomThemes(path, appearance.themeFile, process.platform);
  // A reference that no longer reads is dropped so the saved choice stands on its own.
  const themeFile = custom.referenceProblem ? undefined : appearance.themeFile;
  const settings = validateAppearanceSettings(input, availableThemeIds(custom.themes));
  // Overrides are config-only: the settings screen never edits them, so a
  // save preserves them verbatim and reports whether they still apply.
  const { overrides, problem } = resolveThemeOverrides(appearance.overrides, [...BUILT_IN_THEMES, ...custom.themes]);
  writeConfigDocument(path, {
    ...document,
    version: 1,
    appearance: {
      ...settings,
      ...(themeFile ? { themeFile } : {}),
      ...(appearance.overrides !== undefined ? { overrides: appearance.overrides } : {}),
    },
  });
  return appearanceConfiguration(settings, joinProblems([problem, ...custom.skipped]), custom.themes, overrides);
}

/** The folder beside the config whose theme files are picked up automatically. */
const THEMES_DIRECTORY = "themes";
const MAX_THEME_FILES = 64;
/** Copies written by an import are named `<id>-<sha256>.json`. */
const IMPORTED_COPY = /-[0-9a-f]{64}\.json$/u;

function availableThemeIds(customThemes: readonly ThemeDefinition[]): ReadonlySet<string> {
  return new Set([...BUILT_IN_THEME_IDS, ...customThemes.map(({ id }) => id)]);
}

function joinProblems(problems: readonly (string | undefined)[]): string | undefined {
  const present = problems.filter((problem): problem is string => Boolean(problem));
  return present.length ? present.join("; ") : undefined;
}

/**
 * Every theme the reader has placed in the themes folder, plus the one the
 * config references explicitly. Each file passes the same checks as a
 * referenced theme; a file that fails is skipped and named, never fatal. When
 * two files share an ID the referenced file wins, then the first by name;
 * older import copies of the same theme are skipped quietly.
 */
function loadCustomThemes(configPath: string, themeFile: string | undefined, platform: NodeJS.Platform): {
  readonly themes: readonly ThemeDefinition[];
  readonly referenceProblem?: string;
  readonly skipped: readonly string[];
} {
  const themes: ThemeDefinition[] = [];
  const seen = new Set<string>();
  const skipped: string[] = [];
  let referenceProblem: string | undefined;
  let referencedPath: string | undefined;
  if (themeFile) {
    referencedPath = expectedThemePath(configPath, themeFile);
    try {
      const theme = readThemeManifest(configPath, themeFile, platform);
      themes.push(theme);
      seen.add(theme.id);
    } catch (error) {
      referenceProblem = error instanceof Error ? error.message : "Leaflogue could not read the custom theme file";
    }
  }

  const directory = join(canonicalConfigDirectory(configPath), THEMES_DIRECTORY);
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".json") && !name.startsWith(".")).sort();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") skipped.push("Leaflogue could not read the themes folder");
    return { themes, ...(referenceProblem ? { referenceProblem } : {}), skipped };
  }
  if (names.length > MAX_THEME_FILES) {
    skipped.push(`Only the first ${MAX_THEME_FILES} of ${names.length} theme files were read`);
    names = names.slice(0, MAX_THEME_FILES);
  }
  for (const name of names) {
    const relative = `${THEMES_DIRECTORY}/${name}`;
    if (resolve(directory, name) === referencedPath) continue;
    try {
      const theme = readThemeManifest(configPath, relative, platform);
      if (seen.has(theme.id)) {
        if (!(name.startsWith(`${theme.id}-`) && IMPORTED_COPY.test(name))) {
          skipped.push(`Skipped ${relative}: another theme already uses the ID "${theme.id}"`);
        }
        continue;
      }
      seen.add(theme.id);
      themes.push(theme);
    } catch (error) {
      skipped.push(`Skipped ${relative}: ${error instanceof Error ? error.message : "it could not be read"}`);
    }
  }
  return { themes, ...(referenceProblem ? { referenceProblem } : {}), skipped };
}

function parseAppearanceDocument(value: unknown): {
  readonly settings: AppearanceSettingsInput;
  readonly themeFile?: string;
  /** Kept verbatim so a problem in it never discards the rest of the section. */
  readonly overrides?: unknown;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Appearance settings are invalid");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "themeId" && key !== "mode" && key !== "themeFile" && key !== "overrides")) {
    throw new Error("Appearance settings contain unknown fields");
  }
  let themeFile: string | undefined;
  if (input.themeFile !== undefined) {
    if (typeof input.themeFile !== "string" || !input.themeFile.trim() || input.themeFile.length > 4_096 || input.themeFile.includes("\0")) {
      throw new Error("Custom theme path is invalid");
    }
    themeFile = input.themeFile.trim();
  }
  return {
    settings: { themeId: input.themeId as string, mode: input.mode as AppearanceSettingsInput["mode"] },
    ...(themeFile ? { themeFile } : {}),
    ...(input.overrides !== undefined ? { overrides: input.overrides } : {}),
  };
}

/**
 * Parse config-only overrides through the manifest grammar and prove the
 * adjusted themes still pass contrast. Returns the problem instead of throwing
 * so the selected theme stays usable when only the overrides are wrong.
 */
function resolveThemeOverrides(value: unknown, themes: readonly ThemeDefinition[]): { readonly overrides: ThemeOverrides; readonly problem?: string } {
  if (value === undefined) return { overrides: {} };
  try {
    const overrides = parseThemeOverrides(value);
    applyThemeOverrides(themes, overrides);
    return { overrides };
  } catch (error) {
    return { overrides: {}, problem: `Theme overrides were not applied: ${error instanceof Error ? error.message : "they are invalid"}` };
  }
}

const RELATIVE_THEME_LINK_PROBLEM = "Custom theme files must not use symbolic links between the config directory and the theme file";
const ABSOLUTE_THEME_LINK_PROBLEM = "Custom theme files must not use symbolic links; reference the theme by its canonical absolute path";

/**
 * The directory holding the protected config is the trust root for theme
 * paths. It is canonicalized once, so operating-system or user-chosen links at
 * or above it (such as macOS's /var or a linked home directory) are accepted:
 * the config file itself is already read through them. Falls back to the
 * lexical path when the directory does not exist yet.
 */
function canonicalConfigDirectory(configPath: string): string {
  const directory = dirname(resolve(configPath));
  try {
    return realpathSync(directory);
  } catch {
    return directory;
  }
}

/** The protected config file's path beneath its canonical directory. */
export function canonicalConfigPath(configPath: string): string {
  return join(canonicalConfigDirectory(configPath), basename(resolve(configPath)));
}

/** Where a referenced theme must live, expressed as a canonical path. */
function expectedThemePath(configPath: string, themeFile: string): string {
  return isAbsolute(themeFile) ? resolve(themeFile) : resolve(canonicalConfigDirectory(configPath), themeFile);
}

function readThemeManifest(configPath: string, themeFile: string, platform: NodeJS.Platform) {
  const path = expectedThemePath(configPath, themeFile);
  if (platform !== "win32") {
    // A relative reference may not pass through any link below the canonical
    // config directory; an absolute reference has no trusted root of its own,
    // so it must already be canonical. The final component is additionally
    // opened with O_NOFOLLOW below.
    const linkProblem = isAbsolute(themeFile) ? ABSOLUTE_THEME_LINK_PROBLEM : RELATIVE_THEME_LINK_PROBLEM;
    try {
      if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) throw new Error(linkProblem);
    } catch (error) {
      if (error instanceof Error && error.message === linkProblem) throw error;
      throw new Error("Leaflogue could not inspect the custom theme file", { cause: error });
    }
  }

  let descriptor: number | undefined;
  try {
    try {
      descriptor = openSync(path, constants.O_RDONLY | (platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
    } catch (error) {
      throw new Error("Leaflogue could not read the custom theme file", { cause: error });
    }
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > MAX_THEME_BYTES) {
      throw new Error("Custom theme must be a regular file smaller than 32 KiB");
    }
    if (platform !== "win32") {
      if ((info.mode & 0o777) !== 0o600) throw new Error("Custom theme file permissions must be 0600");
      if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("Custom theme file must be owned by the current user");
    }
    return parseThemeManifest(readBoundedThemeDocument(descriptor));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Write a portable theme manifest atomically with owner-only permissions. */
export function writeThemeExport(path: string, manifest: ThemeManifest): void {
  parseThemeManifest(manifest);
  writeFileAtomically(path, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
}

/**
 * Import a portable theme chosen by the reader. The source may live anywhere
 * and carry any permissions, because it is never referenced in place: it is
 * read once without following links, fully validated, then copied into the
 * protected config directory with owner-only permissions and selected.
 */
export function importThemeFile(configPath: string, sourcePath: string, platform: NodeJS.Platform = process.platform): AppearanceConfiguration {
  let descriptor: number | undefined;
  let manifest: ThemeDefinition;
  try {
    try {
      descriptor = openSync(sourcePath, constants.O_RDONLY | (platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
    } catch (error) {
      throw new Error("Leaflogue could not read that theme file; choose a regular file rather than a link", { cause: error });
    }
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > MAX_THEME_BYTES) throw new Error("Custom theme must be a regular file smaller than 32 KiB");
    manifest = parseThemeManifest(readBoundedThemeDocument(descriptor));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }

  const document = readConfigDocument(configPath, platform) ?? {};
  const current: { readonly settings?: AppearanceSettingsInput; readonly overrides?: unknown } = document.appearance === undefined
    ? {}
    : parseAppearanceDocument(document.appearance);
  const themeContents = `${JSON.stringify({ version: 1, ...manifest }, null, 2)}\n`;
  // A content-addressed destination prevents a same-ID import from replacing
  // the active theme before the config atomically publishes the new reference.
  const digest = createHash("sha256").update(themeContents).digest("hex");
  const themeFile = `themes/${manifest.id}-${digest}.json`;
  const themePath = expectedThemePath(configPath, themeFile);
  const themeExisted = existsSync(themePath);
  writeFileAtomically(themePath, themeContents, 0o600);
  const mode = current.settings?.mode === "light" || current.settings?.mode === "dark" ? current.settings.mode : "system";
  try {
    writeConfigDocument(configPath, {
      ...document,
      version: 1,
      appearance: {
        themeId: manifest.id,
        mode,
        themeFile,
        ...(current.overrides !== undefined ? { overrides: current.overrides } : {}),
      },
    });
  } catch (error) {
    if (!themeExisted) rmSync(themePath, { force: true });
    throw error;
  }
  return loadAppearanceAt(configPath, platform);
}

function readBoundedThemeDocument(descriptor: number): unknown {
  const buffer = Buffer.alloc(MAX_THEME_BYTES + 1);
  let total = 0;
  while (total < buffer.byteLength) {
    const count = readSync(descriptor, buffer, total, buffer.byteLength - total, total);
    if (count === 0) break;
    total += count;
  }
  if (total > MAX_THEME_BYTES || fstatSync(descriptor).size > MAX_THEME_BYTES) {
    throw new Error("Custom theme must be a regular file smaller than 32 KiB");
  }
  try {
    return JSON.parse(buffer.subarray(0, total).toString("utf8"));
  } catch {
    throw new Error("Custom theme is not valid JSON");
  }
}

interface ParsedAiProvider extends Record<string, unknown> {
  apiKey?: string;
  apiKeyEnv?: string;
  consentAcceptedAt?: number;
  defaultModel: string;
  models: string[];
  endpoint?: string;
  capabilities: string[];
}

interface ParsedAiDocument extends Record<string, unknown> {
  enabled: boolean;
  selectedProvider?: string;
  selectedModels: Record<string, string>;
  providers: Record<string, ParsedAiProvider>;
}

function parseAiDocument(value: unknown): ParsedAiDocument {
  if (value === undefined) value = { providers: {} };
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("AI configuration must be an object");
  const input = value as Record<string, unknown>;
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("AI enabled setting is invalid");
  if (input.selectedProvider !== undefined && typeof input.selectedProvider !== "string") throw new Error("Selected AI provider is invalid");
  if (typeof input.providers !== "object" || input.providers === null || Array.isArray(input.providers)) throw new Error("AI providers must be an object");
  const selectedModels = stringRecord(input.selectedModels, "Selected AI models");
  const providers: Record<string, ParsedAiProvider> = {};
  for (const [id, rawProvider] of Object.entries(input.providers as Record<string, unknown>)) {
    if (!PROVIDER_ID.test(id) || !AI_PROVIDER_IDS.has(id) || typeof rawProvider !== "object" || rawProvider === null || Array.isArray(rawProvider)) throw new Error("AI provider configuration is invalid");
    const defaults = DEFAULT_AI_PROVIDERS[id];
    const configured = rawProvider as Record<string, unknown>;
    const raw: Record<string, unknown> = {
      ...(defaults && configured.models === undefined && configured.defaultModel === undefined
        ? { models: defaults.models, defaultModel: defaults.defaultModel }
        : {}),
      ...(defaults && configured.capabilities === undefined ? { capabilities: defaults.capabilities } : {}),
      ...(defaults && configured.apiKeyEnv === undefined ? { apiKeyEnv: defaults.apiKeyEnv } : {}),
      ...configured,
    };
    const models = stringList(raw.models, "AI provider models", 100, 200);
    if (models.length === 0 || new Set(models).size !== models.length) throw new Error("AI provider models are invalid");
    if (typeof raw.defaultModel !== "string" || !models.includes(raw.defaultModel)) throw new Error("AI provider default model is invalid");
    if (raw.apiKey !== undefined && (typeof raw.apiKey !== "string" || !raw.apiKey.trim() || raw.apiKey.length > 8_192)) throw new Error("Saved AI API key is invalid");
    if (raw.apiKeyEnv !== undefined && (typeof raw.apiKeyEnv !== "string" || !ENVIRONMENT_NAME.test(raw.apiKeyEnv))) throw new Error("AI key environment variable is invalid");
    if (raw.consentAcceptedAt !== undefined && (typeof raw.consentAcceptedAt !== "number" || !Number.isSafeInteger(raw.consentAcceptedAt) || raw.consentAcceptedAt < 0)) throw new Error("AI consent record is invalid");
    const capabilities = stringList(raw.capabilities ?? [], "AI provider capabilities", 10, 40);
    if (capabilities.some((capability) => !AI_CAPABILITIES.has(capability)) || new Set(capabilities).size !== capabilities.length) throw new Error("AI provider capabilities are invalid");
    const endpoint = raw.endpoint === undefined ? undefined : validateAiEndpoint(raw.endpoint);
    if (id === "openai-compatible" && !endpoint) throw new Error("OpenAI-compatible endpoint is required");
    if (id !== "openai-compatible" && endpoint) throw new Error("Built-in AI providers cannot override their endpoint");
    providers[id] = { ...raw, models, defaultModel: raw.defaultModel, capabilities, ...(endpoint ? { endpoint } : {}), ...(typeof raw.apiKey === "string" ? { apiKey: raw.apiKey } : {}), ...(typeof raw.apiKeyEnv === "string" ? { apiKeyEnv: raw.apiKeyEnv } : {}), ...(typeof raw.consentAcceptedAt === "number" ? { consentAcceptedAt: raw.consentAcceptedAt } : {}) };
  }
  for (const [id, defaults] of Object.entries(DEFAULT_AI_PROVIDERS)) {
    providers[id] ??= { models: [...defaults.models], defaultModel: defaults.defaultModel, capabilities: [...defaults.capabilities], apiKeyEnv: defaults.apiKeyEnv };
  }
  const selectedProvider = typeof input.selectedProvider === "string" ? input.selectedProvider : undefined;
  if (selectedProvider && !providers[selectedProvider]) throw new Error("Selected AI provider is unavailable");
  for (const [id, model] of Object.entries(selectedModels)) {
    if (!providers[id]?.models.includes(model)) throw new Error("Selected AI model is unavailable");
  }
  return { ...input, enabled: input.enabled === true, ...(selectedProvider ? { selectedProvider } : {}), selectedModels, providers };
}

function summarizeAiDocument(ai: ParsedAiDocument, environment: NodeJS.ProcessEnv): AiConfigurationSummary {
  const providers = Object.entries(ai.providers).map(([id, provider]) => ({
    id,
    models: provider.models,
    defaultModel: provider.defaultModel,
    selectedModel: ai.selectedModels[id] ?? provider.defaultModel,
    ...(provider.endpoint ? { endpoint: provider.endpoint } : {}),
    capabilities: provider.capabilities,
    credential: provider.apiKey ? "saved" as const : provider.apiKeyEnv && environment[provider.apiKeyEnv]?.trim() ? "environment" as const : "missing" as const,
    consented: typeof provider.consentAcceptedAt === "number",
  }));
  return { enabled: ai.enabled, ...(ai.selectedProvider ? { selectedProvider: ai.selectedProvider } : {}), providers };
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} are invalid`);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!PROVIDER_ID.test(key) || typeof item !== "string" || !item || item.length > 200) throw new Error(`${label} are invalid`);
    result[key] = item;
  }
  return result;
}

function stringList(value: unknown, label: string, count: number, length: number): string[] {
  if (!Array.isArray(value) || value.length > count || value.some((item) => typeof item !== "string" || !item || item.length > length)) throw new Error(`${label} are invalid`);
  return value as string[];
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function writeConfigDocument(path: string, document: ConfigFile): void {
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  if (new TextEncoder().encode(serialized).byteLength > MAX_CONFIG_BYTES) {
    throw new Error("Leaflogue configuration must remain smaller than 64 KiB");
  }
  writeFileAtomically(path, serialized, 0o600);
}

function writeFileAtomically(path: string, contents: string | Uint8Array, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, contents, { flag: "wx", mode: 0o600, flush: true });
    chmodSync(temporaryPath, mode);
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function validateAiEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) throw new Error("AI provider endpoint is invalid");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("AI provider endpoint is invalid"); }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (!url.hostname || (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) || url.username || url.password || url.search || url.hash) {
    throw new Error("AI provider endpoint must be credential-free HTTPS, except loopback development");
  }
  return url.toString().replace(/\/$/u, "");
}

function readConfigDocument(path: string, platform: NodeJS.Platform): ConfigFile | undefined {
  // Every check runs on the opened file, not the path, so the file cannot be
  // swapped between checking and reading. A link to the file is still allowed
  // (dotfile managers use them); its target must pass the same checks.
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (platform === "win32" ? 0 : constants.O_NONBLOCK));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Leaflogue could not inspect its configuration file", { cause: error });
  }
  let text: string;
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) {
      throw new Error("Leaflogue configuration must be a regular file smaller than 64 KiB");
    }
    if (platform !== "win32" && (info.mode & 0o077) !== 0) {
      throw new Error("Leaflogue configuration permissions must be 0600");
    }
    if (platform !== "win32" && typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error("Leaflogue configuration must be owned by the current user");
    }
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let length = 0;
    for (let read = -1; read !== 0 && length <= MAX_CONFIG_BYTES;) {
      read = readSync(descriptor, buffer, length, buffer.length - length, null);
      length += read;
    }
    if (length > MAX_CONFIG_BYTES) throw new Error("Leaflogue configuration must be a regular file smaller than 64 KiB");
    text = buffer.subarray(0, length).toString("utf8");
  } finally {
    closeSync(descriptor);
  }

  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error("Leaflogue configuration is not valid JSON");
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new Error("Leaflogue configuration root must be an object");
  }
  const config = document as ConfigFile;
  if (config.version !== undefined && config.version !== 1) {
    throw new Error("Leaflogue configuration version is not supported");
  }
  return config;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function validatePostgresUrl(connectionString: string): URL {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("Database URL is invalid");
  }
  if ((url.protocol !== "postgres:" && url.protocol !== "postgresql:") || !url.hostname) {
    throw new Error("Database URL must be a PostgreSQL URL with a host");
  }
  // pg reads parameter names exactly as written, so `SSLMODE=require` would
  // pass a case-insensitive check yet connect without TLS. Require the spelling
  // pg actually reads.
  if ([...url.searchParams.keys()].some((key) => key !== key.toLocaleLowerCase("en"))) {
    throw new Error("PostgreSQL URL query parameter names must be lower case");
  }
  const securityParameters = [...url.searchParams.entries()];
  if (securityParameters.some(([key]) => key === "host" || key === "hostaddr" || key === "ssl")) {
    throw new Error("PostgreSQL URL query parameters must not override host or TLS settings");
  }
  // uselibpqcompat turns off certificate verification under sslmode=require;
  // client-certificate options make pg read and present local files.
  if (securityParameters.some(([key]) => ["uselibpqcompat", "sslcert", "sslkey", "sslpassword"].includes(key))) {
    throw new Error("PostgreSQL URL must not weaken TLS or load client certificates");
  }
  const sslModes = securityParameters.filter(([key]) => key === "sslmode").map(([, value]) => value.toLocaleLowerCase("en"));
  if (sslModes.length > 1) throw new Error("PostgreSQL URL must contain at most one sslmode parameter");
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  const sslMode = sslModes[0];
  if (!loopback && !isRequiredTlsMode(sslMode)) {
    throw new Error("Remote PostgreSQL URLs must require TLS with sslmode=require, verify-ca, or verify-full");
  }
  return url;
}

function isRequiredTlsMode(value: string | undefined): boolean {
  return value === "require" || value === "verify-ca" || value === "verify-full";
}

function validateConvexUrl(deploymentUrl: string): URL {
  let url: URL;
  try {
    url = new URL(deploymentUrl);
  } catch {
    throw new Error("Convex deployment URL is invalid");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (!url.hostname || (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))) {
    throw new Error("Convex deployment URL must use HTTPS unless it is local");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "" && url.pathname !== "/")) {
    throw new Error("Convex deployment URL must be a credential-free deployment origin");
  }
  return url;
}
