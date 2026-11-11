import { CalibreLibrary } from "./calibre";
import { CALIBRE_DESCRIBE_CHANNEL, CALIBRE_CHOOSE_CHANNEL, CALIBRE_SEARCH_CHANNEL, CALIBRE_LINK_CHANNEL, EPUB_UNLINK_CHANNEL } from "@leaflogue/contracts";
import { searchCatalog } from "@leaflogue/catalog";
import { CATALOG_SEARCH_CHANNEL } from "@leaflogue/contracts";
import { EPUB_ATTACH_CHANNEL, EPUB_OPEN_CHANNEL, EPUB_POSITION_CHANNEL } from "@leaflogue/contracts";
import { EpubStore } from "./epub";
import { mcpAccessEnabled, mcpAccessFile, saveMcpAccess } from "./mcp-access";
import { serveLocalMcp } from "./mcp-server";
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, normalize, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { lookupWord } from "./dictionary";
import { createHash, randomUUID } from "node:crypto";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  protocol,
  session,
  shell,
} from "electron";
import {
  LIBRARY_CREATE_CHANNEL,
  LIBRARY_UPDATE_METADATA_CHANNEL,
  LIBRARY_METADATA_SOURCE_CHANNEL,
  LIBRARY_CREATE_HIGHLIGHT_CHANNEL,
  LIBRARY_CREATE_NOTE_CHANNEL,
  LIBRARY_GET_CONTENTS_CHANNEL,
  LIBRARY_LIST_HIGHLIGHTS_CHANNEL,
  LIBRARY_EXPORT_CHANNEL,
  LIBRARY_LIST_CHANNEL,
  LIBRARY_LIST_READING_STATUS_CHANNEL,
  LIBRARY_MERGE_BOOKS_CHANNEL,
  LIBRARY_SET_BOOK_ARCHIVED_CHANNEL,
  LIBRARY_SET_COMPLETION_DATE_CHANNEL,
  LIBRARY_SET_READING_STATUS_CHANNEL,
  LIBRARY_UPDATE_HIGHLIGHT_CHANNEL,
  LIBRARY_UPDATE_NOTE_CHANNEL,
  LIBRARY_DELETE_HIGHLIGHT_CHANNEL,
  LIBRARY_DELETE_NOTE_CHANNEL,
  LIBRARY_HIGHLIGHT_SOURCE_CHANNEL,
  LIBRARY_RESET_HIGHLIGHT_CHANNEL,
  ORGANIZATION_LIST_COLLECTIONS_CHANNEL,
  ORGANIZATION_LIST_TAGS_CHANNEL,
  ORGANIZATION_GET_BOOK_CHANNEL,
  ORGANIZATION_CREATE_COLLECTION_CHANNEL,
  ORGANIZATION_UPDATE_COLLECTION_CHANNEL,
  ORGANIZATION_DELETE_COLLECTION_CHANNEL,
  ORGANIZATION_CREATE_TAG_CHANNEL,
  ORGANIZATION_UPDATE_TAG_CHANNEL,
  ORGANIZATION_DELETE_TAG_CHANNEL,
  ORGANIZATION_SET_BOOK_COLLECTION_CHANNEL,
  ORGANIZATION_SET_BOOK_TAG_CHANNEL,
  ORGANIZATION_SET_HIGHLIGHT_TAG_CHANNEL,
  THREAD_LIST_CHANNEL,
  THREAD_GET_CHANNEL,
  THREAD_GET_HIGHLIGHT_MEMBERSHIP_CHANNEL,
  THREAD_CREATE_CHANNEL,
  THREAD_UPDATE_CHANNEL,
  THREAD_DELETE_CHANNEL,
  THREAD_SET_HIGHLIGHT_MEMBERSHIP_CHANNEL,
  DAILY_GET_CHANNEL,
  DAILY_ENSURE_CHANNEL,
  IMPORT_CHOOSE_CHANNEL,
  IMPORT_CHOOSE_FOLDER_CHANNEL,
  IMPORT_READERS_LIST_CHANNEL,
  IMPORT_READER_CHOOSE_CHANNEL,
  IMPORT_READERS_CHANGED_CHANNEL,
  IMPORT_COMMIT_CHANNEL,
  IMPORT_CONFLICTS_LIST_CHANNEL,
  IMPORT_CONFLICT_RESOLVE_CHANNEL,
  SYNC_CONFLICTS_LIST_CHANNEL,
  SYNC_CONFLICT_RESOLVE_CHANNEL,
  SYNC_RUN_CHANNEL,
  SYNC_STATUS_CHANNEL,
  SYNC_STATUS_CHANGED_CHANNEL,
  BACKUP_CREATE_CHANNEL,
  UPDATES_CHECK_CHANNEL,
  LIBRARY_EXPORT_MARKDOWN_CHANNEL,
  LIBRARY_STATISTICS_CHANNEL,
  LIBRARY_DUPLICATES_CHANNEL,
  UPDATES_INSTALL_CHANNEL,
  UPDATES_DESCRIBE_CHANNEL,
  UPDATES_SET_AUTOMATIC_CHANNEL,
  DASHBOARDS_DESCRIBE_CHANNEL,
  DASHBOARDS_SAVE_CHANNEL,
  UPDATES_AVAILABLE_CHANNEL,
  BACKUP_RESTORE_CHANNEL,
  REMOTE_CHECK_CHANNEL,
  REMOTE_DESCRIBE_CHANNEL,
  REMOTE_INITIALIZE_CHANNEL,
  REMOTE_SAVE_CHANNEL,
  AI_DESCRIBE_CHANNEL,
  AI_SAVE_CHANNEL,
  AI_ACCEPT_TERMS_CHANNEL,
  AI_DESCRIBE_TASK_CHANNEL,
  AI_EXPLAIN_CHANNEL,
  AI_CANCEL_CHANNEL,
  APPEARANCE_DESCRIBE_CHANNEL,
  APPEARANCE_SAVE_CHANNEL,
  APPEARANCE_CHANGED_CHANNEL,
  APPEARANCE_EXPORT_THEME_CHANNEL,
  APPEARANCE_IMPORT_THEME_CHANNEL,
  APPEARANCE_OPEN_THEMES_FOLDER_CHANNEL,
  COVER_RESOLVE_CHANNEL,
  COVER_CANCEL_CHANNEL,
  SYSTEM_CAPABILITIES_CHANNEL,
  SYSTEM_COMPLETE_SETUP_CHANNEL,
  SYSTEM_OPEN_EXTERNAL_CHANNEL,
  DICTIONARY_LOOKUP_CHANNEL,
  MCP_DESCRIBE_CHANNEL,
  MCP_CONFIGURE_CHANNEL,
  MAX_NOTE_BYTES,
  type NewBook,
  type NewHighlight,
  type NewNote,
  type BookId,
  type HighlightId,
  type MergeBooks,
  type NoteId,
  type SetBookArchived,
  type UpdateHighlight,
  type UpdateNote,
  type UpdateBookMetadata,
  type DeleteHighlight,
  type DeleteNote,
  type ResetHighlightToSource,
  type BackupReceipt,
  type RestoreReceipt,
  type MarkdownExportReceipt,
  type LibraryExportReceipt,
  type RemoteConfigurationSummary,
  type RemoteDatabaseStatus,
  type AiConfigurationSummary,
  type AiTaskDisclosure,
  type ExplainPassageRequest,
  type PassageExplanation,
  type AppearanceConfiguration,
  type ThemeExportReceipt,
  type AppearanceSettingsInput,
  type ImportPreview,
  type ImportProvider,
  type PendingImport,
  type SystemCapabilities,
  type CollectionId,
  type TagId,
  type NewCollection,
  type NewTag,
  type UpdateCollection,
  type UpdateTag,
  type DeleteCollection,
  type DeleteTag,
  type SetBookCollectionMembership,
  type SetBookTagMembership,
  type SetHighlightTagMembership,
  type ThreadId,
  type WidgetExportReceipt,
  type WidgetImportReceipt,
  CUSTOM_WIDGET_FILE_EXTENSION,
  WIDGET_LIMITS,
  WIDGETS_DELETE_CHANNEL,
  WIDGETS_EVALUATE_CHANNEL,
  WIDGETS_EXPORT_CHANNEL,
  WIDGETS_IMPORT_CHANNEL,
  WIDGETS_SAVE_CHANNEL,
} from "@leaflogue/contracts";
import { evaluateWidget, findLibraryDuplicates, libraryStatistics, parseCustomWidget, widgetDataset } from "@leaflogue/domain";
import { assertSafeExportDestination, createLibraryExport, writeLibraryExport } from "./library-export";
import { exportableThemeManifest } from "@leaflogue/appearance";
import { applyNativeAppearance, nativeAppearanceBackground } from "./native-appearance";
import { createAppearanceWatcher } from "./appearance-watcher";
import { AppearanceLiveState } from "./appearance-live-state";
import { migrateLegacyDesktopFiles, prepareDesktopDirectories, resolveDesktopPaths } from "./desktop-paths";
import {
  extractKoboDatabase,
  extractPocketBookDatabase,
  isPocketBookDatabase,
  looksLikeBooxExport,
  looksLikeTolinoNotes,
  MAX_KOBO_FILE_BYTES,
  parseBooxExport,
  parseBooxExports,
  parseKindleClippings,
  parseKOReaderSidecars,
  parsePortableJson,
  parseTolinoNotes,
  type ReadonlyDatabase,
} from "@leaflogue/importers";
import { collectBooxExports, collectKOReaderSidecars } from "./reader-folders";
import { LocalLibrary, recoverInterruptedFileReplacement, replaceFileWithRollback, validateLibraryBackup } from "@leaflogue/storage";
import { CURRENT_SETUP_VERSION, ConvexSyncTransport, acceptAiProviderTerms, assertCompatibleConvexDeployment, canonicalConfigPath, checkConvex, checkPostgres, createPostgresClient, ensureConvexLibrary, explainPassageDisclosure, explainPassageRequest, generateAiText, type CompanionInput, companionInScope, companionNeedsScopeCheck, companionOutOfScope, companionRequest, companionScopeRequest, parseCompanionAnswer, validateCompanionInput, importThemeFile, loadUpdatePreferences, writeUpdatePreferences, loadDashboardLayouts, writeDashboardLayout, writeCustomWidget, deleteCustomWidget, importCustomWidgetFiles, writeCustomWidgetExport, initializePostgres, loadAiRuntimeProvider, parseExplanation, loadAppearanceConfig, loadRemoteConfig, prepareConvexLibrary, resolveAppearanceFiles, setupCompletedVersion, summarizeAiConfig, summarizeRemoteConfig, writeAiConfig, writeAppearanceConfig, writeRemoteConfig, writeSetupCompletion, writeThemeExport } from "@leaflogue/remote";
import { readingStatusHistoryPage, registerTrustedHandler, validateAiSettings, validateCommitImport, validateConflictResolution, validateDailyRequest, validateExternalUrl, validateHighlightQuery, validateNoteOrigin, validateSetBookCompletionDate, validateSetBookReadingStatus, validateSyncConflictResolution, validateSyncRunOptions, validateThreadCreate, validateThreadDelete, validateThreadMembership, validateThreadUpdate } from "./ipc-security";
import { applicationMenuTemplate } from "./application-menu";
import { CoverCache } from "./cover-cache";
import { fetchPublicCover } from "./public-cover-fetch";
import { AiDisclosureLedger } from "./ai-disclosures";
import type { ExplainPassageDisclosure } from "@leaflogue/remote";
import { createDesktopSyncService } from "./desktop-sync-service";
import { createSyncStatusTracker } from "./sync-status";
import { rendererContentPolicyForRequest, validateDevelopmentRendererUrl } from "./content-policy";
import { TRUSTED_UPDATE_KEYS } from "./update-keys";
import { DesktopUpdater } from "./update-service";
import { installNativeUpdate, nativeUpdateUnavailable } from "./update-native";
import { scheduleAutomaticUpdateChecks } from "./update-scheduler";
import { writeMarkdownExport } from "./markdown-export";
import { mountRoots, watchConnectedReaders, type DetectedReader } from "./connected-readers";
import { createUpdateTransport } from "./update-transport";

// The renderer loads local resources only. Optional network integrations use
// privileged Node transports; Chromium must not discover proxies or phone home.
app.commandLine.appendSwitch("no-proxy-server");
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "leaflogue",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
    },
  },
]);

const legacyUserDataDirectory = app.getPath("userData");
const desktopPaths = resolveDesktopPaths({
  platform: process.platform,
  homeDirectory: app.getPath("home"),
  legacyUserDataDirectory,
});
if (process.platform === "linux") {
  prepareDesktopDirectories(desktopPaths);
  app.setPath("userData", desktopPaths.dataDirectory);
  app.setPath("sessionData", desktopPaths.cacheDirectory);
  app.setPath("crashDumps", desktopPaths.crashDumpsDirectory);
  app.setAppLogsPath(desktopPaths.logsDirectory);
}
const mcpMode = process.argv.includes("--mcp");
if (!mcpMode && !app.requestSingleInstanceLock()) app.quit();
// A second launch hands over to the window already open instead of exiting unseen.
app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

let mainWindow: BrowserWindow | undefined;
let library: LocalLibrary | undefined;
let libraryPath: string | undefined;
const applicationDirectory = dirname(fileURLToPath(import.meta.url));
const pendingImports = new Map<string, PendingImport & { readonly pathHintHash: string }>();
const committingImports = new Set<string>();
let fileOperationInProgress = false;
const appearanceState = new AppearanceLiveState();
let stopAppearanceWatcher: (() => void) | undefined;
let stopAutomaticUpdateChecks: (() => void) | undefined;
let stopReaderWatch: (() => void) | undefined;
const coverCache = new CoverCache(desktopPaths.cacheDirectory, {
  fetcher: fetchPublicCover,
  accentFromImage: dominantCoverAccent,
});
const syncService = createDesktopSyncService({
  getLibrary: () => library,
  readConfig: () => readRemoteConfig(),
  createPostgresClient,
  createConvexTransport: async (config, deviceId, runOptions, signal) => {
    if (!config.syncKey) throw Object.assign(new Error("Save the Convex sync key before synchronizing"), { code: "LEAFLOGUE_SYNC_KEY_UNCONFIGURED" });
    const { mutationContractVersion } = await assertCompatibleConvexDeployment(config.deploymentUrl, { releaseVersion: app.getVersion(), signal });
    const options = { deploymentUrl: config.deploymentUrl, syncKey: config.syncKey, mutationContractVersion };
    const libraryId = await ensureConvexLibrary(options, signal);
    const migration = await prepareConvexLibrary(options, libraryId, {
      ...(runOptions.confirmDetachNoteId ? { confirmDetachNoteId: runOptions.confirmDetachNoteId } : {}),
    }, signal);
    return {
      migration,
      transport: new ConvexSyncTransport({ ...options, session: { libraryId, deviceId } }),
    };
  },
});
const syncTracker = createSyncStatusTracker({
  run: (options) => syncService.run(options),
  isConfigured: syncConfigured,
  publish: (status) => { mainWindow?.webContents.send(SYNC_STATUS_CHANGED_CHANNEL, status); },
});
const developmentRendererUrl = app.isPackaged
  ? undefined
  : validateDevelopmentRendererUrl(process.env.ELECTRON_RENDERER_URL);

function dominantCoverAccent(bytes: Uint8Array): string | undefined {
  const image = nativeImage.createFromBuffer(Buffer.from(bytes));
  if (image.isEmpty()) throw new Error("Cover image could not be decoded");
  const bitmap = image.resize({ width: 32, height: 32, quality: "good" }).toBitmap();
  let red = 0;
  let green = 0;
  let blue = 0;
  let weight = 0;
  for (let index = 0; index + 3 < bitmap.length; index += 4) {
    const b = bitmap[index] ?? 0;
    const g = bitmap[index + 1] ?? 0;
    const r = bitmap[index + 2] ?? 0;
    const alpha = bitmap[index + 3] ?? 0;
    const maximum = Math.max(r, g, b);
    const minimum = Math.min(r, g, b);
    const lightness = (maximum + minimum) / 510;
    const saturation = maximum === 0 ? 0 : (maximum - minimum) / maximum;
    if (alpha < 128 || saturation < 0.16 || lightness < 0.12 || lightness > 0.88) continue;
    const pixelWeight = saturation * (0.8 + Math.abs(lightness - 0.5));
    red += r * pixelWeight;
    green += g * pixelWeight;
    blue += b * pixelWeight;
    weight += pixelWeight;
  }
  // Nothing colourful enough to borrow: the active theme's placeholder-cover
  // colour stays in charge rather than a colour from one particular palette.
  if (weight === 0) return undefined;
  return `rgb(${Math.round(red / weight)} ${Math.round(green / weight)} ${Math.round(blue / weight)})`;
}

function createWindow(): void {
  const appearance = describeAppearance();
  const backgroundColor = applyNativeAppearance(appearance, nativeTheme);
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 390,
    minHeight: 640,
    backgroundColor,
    autoHideMenuBar: true,
    show: false,
    title: "Leaflogue",
    // On macOS the app's own header is the title bar, so the window takes the
    // theme's colours instead of the system's grey strip. The traffic lights
    // are centred in the 44px header (each button is 14px tall, so 22 - 7);
    // the renderer leaves room for them.
    ...(process.platform === "darwin" ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 18, y: 15 } } : {}),
    webPreferences: {
      preload: join(applicationDirectory, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      // Set this on construction: disabling the session after app readiness is
      // too late to prevent Linux Chromium from starting a Hunspell download.
      spellcheck: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.once("closed", () => { mainWindow = undefined; });

  void mainWindow.loadURL(developmentRendererUrl ?? "leaflogue://app/index.html");
}

function installContentPolicy(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [rendererContentPolicyForRequest(
          app.isPackaged,
          developmentRendererUrl,
          details.url,
        )],
      },
    });
  });
}

function installApplicationProtocol(): void {
  const rendererRoot = normalize(join(applicationDirectory, "../renderer"));
  protocol.handle("leaflogue", (request) => {
    const url = new URL(request.url);
    if (url.hostname === "cover") {
      const key = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const cached = coverCache.read(key);
      if (!cached) return new Response("Not found", { status: 404 });
      return new Response(new Uint8Array(readFileSync(cached.path)), {
        headers: { "Content-Type": cached.contentType, "Cache-Control": "private, max-age=31536000, immutable" },
      });
    }
    if (url.hostname !== "app") return new Response("Not found", { status: 404 });
    const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    const candidate = normalize(join(rendererRoot, relativePath));
    if (candidate !== rendererRoot && !candidate.startsWith(`${rendererRoot}${sep}`)) {
      return new Response("Not found", { status: 404 });
    }
    return net.fetch(pathToFileURL(candidate).toString());
  });
}

function capabilities(): SystemCapabilities {
  const platform = process.platform;
  if (platform !== "linux" && platform !== "darwin" && platform !== "win32") {
    throw new Error("Unsupported desktop platform");
  }
  return {
    appVersion: app.getVersion(),
    databaseSchemaVersion: library?.schemaVersion ?? 0,
    features: { ai: false, metadata: false, sync: true },
    persistenceAvailable: library !== undefined,
    setupRequired: requiresSetup(),
    platform,
    storagePaths: {
      configFile: canonicalConfigPath(activeConfigPath()),
      libraryFile: desktopPaths.libraryFile,
      cacheDirectory: desktopPaths.cacheDirectory,
      stateDirectory: desktopPaths.stateDirectory,
    },
  };
}

function requiresSetup(): boolean {
  try {
    return setupCompletedVersion({ defaultConfigPath: remoteConfigPath() }) !== CURRENT_SETUP_VERSION;
  } catch {
    // A malformed config is surfaced by the relevant Settings section. Keep
    // system paths available and let first-run repair or replace it explicitly.
    return true;
  }
}

// Electron creates the Hunspell service as part of Session construction, before
// app readiness. Clear the default language in the synchronous creation event
// so its queued loader cannot reach Chromium's dictionary CDN.
app.on("session-created", (createdSession) => {
  createdSession.setSpellCheckerLanguages([]);
  createdSession.setSpellCheckerEnabled(false);
});

void app.whenReady().then(async () => {
  if (mcpMode) {
    app.dock?.hide();
    try {
      await serveLocalMcp(desktopPaths.libraryFile, mcpAccessFile(desktopPaths.configDirectory), app.getVersion(), () => app.quit());
    } catch {
      console.error("Leaflogue MCP could not start. Enable MCP in Settings and open the library in the matching desktop app first.");
      app.exit(1);
    }
    return;
  }

  const menu = applicationMenuTemplate(process.platform);
  Menu.setApplicationMenu(menu ? Menu.buildFromTemplate(menu) : null);
  installApplicationProtocol();
  installContentPolicy();
  // Chromium otherwise downloads language dictionaries behind the product's
  // back. Leaflogue's local-only mode must not create implicit network traffic.
  session.defaultSession.setSpellCheckerLanguages([]);
  session.defaultSession.setSpellCheckerEnabled(false);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);

  try {
    if (process.platform === "linux") await migrateLegacyDesktopFiles(desktopPaths);
    libraryPath = desktopPaths.libraryFile;
    recoverInterruptedRestore(libraryPath);
    library = new LocalLibrary(libraryPath);
  } catch {
    console.error("Leaflogue could not open its local library.");
  }

  const describeMcp = () => ({
    enabled: mcpAccessEnabled(mcpAccessFile(desktopPaths.configDirectory)),
    clientConfiguration: JSON.stringify({ mcpServers: { leaflogue: {
      command: app.isPackaged && process.platform === "linux" && process.env.APPIMAGE ? process.env.APPIMAGE : process.execPath,
      args: [...(app.isPackaged ? [] : [join(applicationDirectory, "index.js")]), "--mcp", `--user-data-dir=${desktopPaths.legacyUserDataDirectory}`],
      // Keep the client's stdio pipes instead of attaching to its console.
      ...(process.platform === "win32" ? { env: { ELECTRON_NO_ATTACH_CONSOLE: "1" } } : {}),
      ...(process.platform === "linux" ? { env: {
        XDG_CONFIG_HOME: dirname(desktopPaths.configDirectory), XDG_DATA_HOME: dirname(desktopPaths.dataDirectory),
        XDG_CACHE_HOME: dirname(desktopPaths.cacheDirectory), XDG_STATE_HOME: dirname(desktopPaths.stateDirectory),
      } } : {}),
    } } }, null, 2),
  });
  registerTrustedHandler(ipcMain, CATALOG_SEARCH_CHANNEL, () => app.isPackaged, (query: unknown) => {
    if (typeof query !== "string") throw new Error("Enter a title, author, or ISBN.");
    return searchCatalog(query);
  });
  const epubStore = () => {
    if (!libraryPath) throw new Error("Local library unavailable");
    return new EpubStore(`${libraryPath}.epubs`, (reference) => calibre().resolve(reference));
  };
  const epubBook = (id: unknown) => {
    if (!library || typeof id !== "string" || !isUuid(id) || !library.getBookContents(id as BookId)) throw new Error("Book request is invalid");
    return id as BookId;
  };
  const calibre = () => {
    if (!libraryPath) throw new Error("Local library unavailable");
    return new CalibreLibrary(`${libraryPath}.calibre.json`);
  };
  registerTrustedHandler(ipcMain, CALIBRE_DESCRIBE_CHANNEL, () => app.isPackaged, () => calibre().describe());
  registerTrustedHandler(ipcMain, CALIBRE_CHOOSE_CHANNEL, () => app.isPackaged, async () => {
    const service = calibre();
    const selected = await dialog.showOpenDialog({ title: "Choose your Calibre library folder", properties: ["openDirectory"] });
    return selected.canceled || !selected.filePaths[0] ? undefined : service.connect(selected.filePaths[0]);
  });
  registerTrustedHandler(ipcMain, CALIBRE_SEARCH_CHANNEL, () => app.isPackaged, (id: unknown, query: unknown) => {
    const bookId = epubBook(id);
    if (typeof query !== "string") throw new Error("Invalid Calibre search.");
    return calibre().search(query, library!.getBookContents(bookId)!.book);
  });
  registerTrustedHandler(ipcMain, CALIBRE_LINK_CHANNEL, () => app.isPackaged, async (id: unknown, uuid: unknown) => {
    const bookId = epubBook(id); const store = epubStore(); const service = calibre();
    if (typeof uuid !== "string") throw new Error("Choose a Calibre book.");
    const linked = await service.reference(uuid);
    return store.attach(bookId, linked.path, linked.reference);
  });
  registerTrustedHandler(ipcMain, EPUB_UNLINK_CHANNEL, () => app.isPackaged, (id: unknown) => epubStore().unlink(epubBook(id)));
  registerTrustedHandler(ipcMain, EPUB_OPEN_CHANNEL, () => app.isPackaged, (id: unknown) => epubStore().open(epubBook(id)));
  registerTrustedHandler(ipcMain, EPUB_ATTACH_CHANNEL, () => app.isPackaged, async (id: unknown) => {
    const bookId = epubBook(id);
    const store = epubStore();
    const chosen = await dialog.showOpenDialog({ title: "Attach a local DRM-free EPUB", properties: ["openFile"], filters: [{ name: "EPUB books", extensions: ["epub"] }] });
    if (chosen.canceled || !chosen.filePaths[0]) return undefined;
    const path = chosen.filePaths[0];
    if (statSync(path).size > 50 * 1024 * 1024) throw new Error("EPUB exceeds the 50 MB limit.");
    return store.attach(bookId, path);
  });
  registerTrustedHandler(ipcMain, EPUB_POSITION_CHANNEL, () => app.isPackaged, (id: unknown, hash: unknown, chapter: unknown, paragraph: unknown, offset: unknown) => epubStore().savePosition(epubBook(id), hash, chapter, paragraph, offset));
  registerTrustedHandler(ipcMain, MCP_DESCRIBE_CHANNEL, () => app.isPackaged, describeMcp);
  registerTrustedHandler(ipcMain, MCP_CONFIGURE_CHANNEL, () => app.isPackaged, (enabled: unknown) => {
    if (typeof enabled !== "boolean") throw new Error("MCP access must be enabled or disabled");
    saveMcpAccess(mcpAccessFile(desktopPaths.configDirectory), enabled);
    return describeMcp();
  });
  registerTrustedHandler(ipcMain, DICTIONARY_LOOKUP_CHANNEL, () => app.isPackaged, (word: unknown) => lookupWord(word));
  registerTrustedHandler(ipcMain, SYSTEM_CAPABILITIES_CHANNEL, () => app.isPackaged, () => {
    return capabilities();
  });
  registerTrustedHandler(ipcMain, SYSTEM_COMPLETE_SETUP_CHANNEL, () => app.isPackaged, () => {
    writeSetupCompletion(activeConfigPath());
    return capabilities();
  });
  registerTrustedHandler(ipcMain, SYSTEM_OPEN_EXTERNAL_CHANNEL, () => app.isPackaged, (url: unknown) => {
    return openExternalLink(url);
  });
  registerTrustedHandler(ipcMain, COVER_RESOLVE_CHANNEL, () => app.isPackaged, async (sourceUrl: unknown, requestId: unknown) => {
    if (typeof sourceUrl !== "string" || typeof requestId !== "string") throw new Error("Cover request is invalid");
    try {
      const cover = await coverCache.resolve(sourceUrl, requestId);
      return { url: `leaflogue://cover/${cover.key}`, ...(cover.accent ? { accent: cover.accent } : {}) };
    } catch {
      // A cover is optional metadata. Invalid, private, unreachable, or
      // unsupported image URLs use the themed placeholder without producing an
      // unhandled IPC rejection in the desktop logs.
      return undefined;
    }
  });
  registerTrustedHandler(ipcMain, COVER_CANCEL_CHANNEL, () => app.isPackaged, (requestId: unknown) => {
    if (typeof requestId !== "string") throw new Error("Cover request is invalid");
    coverCache.cancel(requestId);
  });
  registerTrustedHandler(ipcMain, LIBRARY_LIST_CHANNEL, () => app.isPackaged, (options: unknown) => {
    if (!library) throw new Error("Local library unavailable");
    if (options !== undefined && (typeof options !== "object" || options === null || Array.isArray(options) ||
      !("includeArchived" in options) || typeof (options as { includeArchived: unknown }).includeArchived !== "boolean")) {
      throw new Error("Library filter is invalid");
    }
    return library.listBooks(options as { includeArchived?: boolean } | undefined);
  });
  registerTrustedHandler(ipcMain, LIBRARY_CREATE_CHANNEL, () => app.isPackaged, (input: unknown) => {
    if (!library) throw new Error("Local library unavailable");
    return library.createBook(validateNewBook(input));
  });
  registerTrustedHandler(ipcMain, LIBRARY_UPDATE_METADATA_CHANNEL, () => app.isPackaged, (input: unknown) => {
    if (!library) throw new Error("Local library unavailable");
    return library.updateBookMetadata(validateUpdateBookMetadata(input));
  });
  registerTrustedHandler(ipcMain, LIBRARY_METADATA_SOURCE_CHANNEL, () => app.isPackaged, (id: unknown) => {
    if (!library || typeof id !== "string" || !isUuid(id)) throw new Error("Book request is invalid");
    return library.getMetadataSource(id as BookId);
  });
  registerTrustedHandler(ipcMain, LIBRARY_GET_CONTENTS_CHANNEL, () => app.isPackaged, (id: unknown) => {
    if (!library || typeof id !== "string" || !isUuid(id)) {
      throw new Error("Book request is invalid");
    }
    return library.getBookContents(id as BookId);
  });
  registerTrustedHandler(ipcMain, LIBRARY_LIST_HIGHLIGHTS_CHANNEL, () => app.isPackaged, (query: unknown) => {
    if (!library) throw new Error("Local library unavailable");
    return library.listHighlights(validateHighlightQuery(query));
  });
  registerTrustedHandler(ipcMain, LIBRARY_CREATE_HIGHLIGHT_CHANNEL, () => app.isPackaged, (input: unknown) => {
    if (!library) throw new Error("Local library unavailable");
    return library.createHighlight(validateNewHighlight(input));
  });
  registerTrustedHandler(ipcMain, LIBRARY_UPDATE_HIGHLIGHT_CHANNEL, () => app.isPackaged, (input: unknown) => {
    if (!library) throw new Error("Local library unavailable");
    return library.updateHighlight(validateUpdateHighlight(input));
  });
  registerTrustedHandler(ipcMain, LIBRARY_CREATE_NOTE_CHANNEL, () => app.isPackaged, (input: unknown) => {
    if (!library) throw new Error("Local library unavailable");
    return library.createNote(validateNewNote(input));
  });
  registerTrustedHandler(ipcMain, LIBRARY_UPDATE_NOTE_CHANNEL, () => app.isPackaged, (input: unknown) => {
    if (!library) throw new Error("Local library unavailable");
    return library.updateNote(validateUpdateNote(input));
  });
  registerTrustedHandler(ipcMain, LIBRARY_DELETE_HIGHLIGHT_CHANNEL, () => app.isPackaged, (input: unknown) => {
    if (!library) throw new Error("Local library unavailable");
    return library.deleteHighlight(validateDeleteAnnotation(input) as DeleteHighlight);
  });
  registerTrustedHandler(ipcMain, LIBRARY_DELETE_NOTE_CHANNEL, () => app.isPackaged, (input: unknown) => {
    if (!library) throw new Error("Local library unavailable");
    return library.deleteNote(validateDeleteAnnotation(input) as DeleteNote);
  });
  registerTrustedHandler(ipcMain, LIBRARY_HIGHLIGHT_SOURCE_CHANNEL, () => app.isPackaged, (bookId: unknown, highlightId: unknown) => {
    if (!library || typeof bookId !== "string" || !isUuid(bookId) || typeof highlightId !== "string" || !isUuid(highlightId)) {
      throw new Error("Highlight request is invalid");
    }
    return library.getHighlightSource(bookId as BookId, highlightId as HighlightId);
  });
  registerTrustedHandler(ipcMain, LIBRARY_RESET_HIGHLIGHT_CHANNEL, () => app.isPackaged, (input: unknown) => {
    if (!library) throw new Error("Local library unavailable");
    return library.resetHighlightToSource(validateResetHighlight(input));
  });
  registerTrustedHandler(ipcMain, LIBRARY_SET_BOOK_ARCHIVED_CHANNEL, () => app.isPackaged, (input: unknown) => {
    if (!library) throw new Error("Local library unavailable");
    return library.setBookArchived(validateSetBookArchived(input));
  });
  registerTrustedHandler(ipcMain, LIBRARY_LIST_READING_STATUS_CHANNEL, () => app.isPackaged, (id: unknown) => {
    if (!library || typeof id !== "string" || !isUuid(id)) throw new Error("Book request is invalid");
    return readingStatusHistoryPage(library.listReadingStatusHistory(id as BookId, { limit: 101 }));
  });
  registerTrustedHandler(ipcMain, LIBRARY_SET_READING_STATUS_CHANNEL, () => app.isPackaged, (input: unknown) => {
    if (!library) throw new Error("Local library unavailable");
    return library.setBookReadingStatus(validateSetBookReadingStatus(input));
  });
  registerTrustedHandler(ipcMain, LIBRARY_SET_COMPLETION_DATE_CHANNEL, () => app.isPackaged, (input: unknown) => {
    if (!library) throw new Error("Local library unavailable");
    return library.setBookCompletionDate(validateSetBookCompletionDate(input));
  });
  registerTrustedHandler(ipcMain, LIBRARY_MERGE_BOOKS_CHANNEL, () => app.isPackaged, (input: unknown) => {
    if (!library) throw new Error("Local library unavailable");
    return library.mergeBooks(validateMergeBooks(input));
  });
  registerTrustedHandler(ipcMain, ORGANIZATION_LIST_COLLECTIONS_CHANNEL, () => app.isPackaged, () => {
    if (!library) throw new Error("Local library unavailable");
    return library.listCollections();
  });
  registerTrustedHandler(ipcMain, ORGANIZATION_LIST_TAGS_CHANNEL, () => app.isPackaged, () => {
    if (!library) throw new Error("Local library unavailable");
    return library.listTags();
  });
  registerTrustedHandler(ipcMain, ORGANIZATION_GET_BOOK_CHANNEL, () => app.isPackaged, (id: unknown) => {
    if (!library || typeof id !== "string" || !isUuid(id)) throw new Error("Book request is invalid");
    return library.getBookOrganization(id as BookId);
  });
  registerTrustedHandler(ipcMain, ORGANIZATION_CREATE_COLLECTION_CHANNEL, () => app.isPackaged, (input: unknown) => {
    if (!library) throw new Error("Local library unavailable");
    return library.createCollection(validateCollection(input));
  });
  registerTrustedHandler(ipcMain, ORGANIZATION_UPDATE_COLLECTION_CHANNEL, () => app.isPackaged, (input: unknown) => {
    if (!library) throw new Error("Local library unavailable");
    return library.updateCollection(validateCollectionUpdate(input));
  });
  registerTrustedHandler(ipcMain, ORGANIZATION_DELETE_COLLECTION_CHANNEL, () => app.isPackaged, (input: unknown) => {
    if (!library) throw new Error("Local library unavailable");
    return library.deleteCollection(validateOrganizationDelete(input, "collection") as DeleteCollection);
  });
  registerTrustedHandler(ipcMain, ORGANIZATION_CREATE_TAG_CHANNEL, () => app.isPackaged, (input: unknown) => {
    if (!library) throw new Error("Local library unavailable");
    return library.createTag(validateTag(input));
  });
  registerTrustedHandler(ipcMain, ORGANIZATION_UPDATE_TAG_CHANNEL, () => app.isPackaged, (input: unknown) => {
    if (!library) throw new Error("Local library unavailable");
    return library.updateTag(validateTagUpdate(input));
  });
  registerTrustedHandler(ipcMain, ORGANIZATION_DELETE_TAG_CHANNEL, () => app.isPackaged, (input: unknown) => {
    if (!library) throw new Error("Local library unavailable");
    return library.deleteTag(validateOrganizationDelete(input, "tag") as DeleteTag);
  });
  registerTrustedHandler(ipcMain, ORGANIZATION_SET_BOOK_COLLECTION_CHANNEL, () => app.isPackaged, (input: unknown) => {
    if (!library) throw new Error("Local library unavailable");
    return library.setBookCollectionMembership(validateMembership(input, "collection") as SetBookCollectionMembership);
  });
  registerTrustedHandler(ipcMain, ORGANIZATION_SET_BOOK_TAG_CHANNEL, () => app.isPackaged, (input: unknown) => {
    if (!library) throw new Error("Local library unavailable");
    return library.setBookTagMembership(validateMembership(input, "tag") as SetBookTagMembership);
  });
  registerTrustedHandler(ipcMain, ORGANIZATION_SET_HIGHLIGHT_TAG_CHANNEL, () => app.isPackaged, (input: unknown) => {
    if (!library) throw new Error("Local library unavailable");
    return library.setHighlightTagMembership(validateHighlightMembership(input));
  });
  registerTrustedHandler(ipcMain, THREAD_LIST_CHANNEL, () => app.isPackaged, () => {
    if (!library) throw new Error("Local library unavailable");
    return library.listThreads();
  });
  registerTrustedHandler(ipcMain, THREAD_GET_CHANNEL, () => app.isPackaged, (id: unknown) => {
    if (!library || typeof id !== "string" || !isUuid(id)) throw new Error("Thread request is invalid");
    return library.getThread(id as ThreadId);
  });
  registerTrustedHandler(ipcMain, THREAD_GET_HIGHLIGHT_MEMBERSHIP_CHANNEL, () => app.isPackaged, (value: unknown) => {
    if (!library) throw new Error("Local library unavailable");
    const input = annotationRecord(value);
    return library.getHighlightThreadIds(uuidField(input, "bookId") as BookId, uuidField(input, "highlightId") as HighlightId);
  });
  registerTrustedHandler(ipcMain, THREAD_CREATE_CHANNEL, () => app.isPackaged, (input: unknown) => {
    if (!library) throw new Error("Local library unavailable");
    return library.createThread(validateThreadCreate(input));
  });
  registerTrustedHandler(ipcMain, THREAD_UPDATE_CHANNEL, () => app.isPackaged, (input: unknown) => {
    if (!library) throw new Error("Local library unavailable");
    return library.updateThread(validateThreadUpdate(input));
  });
  registerTrustedHandler(ipcMain, THREAD_DELETE_CHANNEL, () => app.isPackaged, (input: unknown) => {
    if (!library) throw new Error("Local library unavailable");
    return library.deleteThread(validateThreadDelete(input));
  });
  registerTrustedHandler(ipcMain, THREAD_SET_HIGHLIGHT_MEMBERSHIP_CHANNEL, () => app.isPackaged, (input: unknown) => {
    if (!library) throw new Error("Local library unavailable");
    return library.setHighlightThreadMembership(validateThreadMembership(input));
  });
  registerTrustedHandler(ipcMain, DAILY_GET_CHANNEL, () => app.isPackaged, (timezone: unknown) => {
    if (!library) throw new Error("Local library unavailable");
    return library.getDailyHighlight(validateDailyRequest({ timezone }).timezone);
  });
  registerTrustedHandler(ipcMain, DAILY_ENSURE_CHANNEL, () => app.isPackaged, (input: unknown) => {
    if (!library) throw new Error("Local library unavailable");
    return library.ensureDailyHighlight(validateDailyRequest(input));
  });
  registerTrustedHandler(ipcMain, IMPORT_CHOOSE_CHANNEL, () => app.isPackaged, async () => {
    return chooseImportFile();
  });
  registerTrustedHandler(ipcMain, IMPORT_CHOOSE_FOLDER_CHANNEL, () => app.isPackaged, async () => {
    return chooseImportFolder();
  });
  // Plugged-in Kobo and Kindle readers: only the mount folders are listed,
  // and the renderer sees an ID and the drive's name, never its path.
  const readerWatch = watchConnectedReaders({
    roots: mountRoots(process.platform, process.env.USER, process.getuid?.()),
    onChange: (readers) => { mainWindow?.webContents.send(IMPORT_READERS_CHANGED_CHANNEL, readers.map(publicReader)); },
  });
  stopReaderWatch = () => readerWatch.stop();
  registerTrustedHandler(ipcMain, IMPORT_READERS_LIST_CHANNEL, () => app.isPackaged, () => readerWatch.current().map(publicReader));
  registerTrustedHandler(ipcMain, IMPORT_READER_CHOOSE_CHANNEL, () => app.isPackaged, async (id: unknown) => {
    if (typeof id !== "string" || !/^[0-9a-f]{32}$/u.test(id)) throw new Error("Reader is invalid");
    const reader = readerWatch.current().find((candidate) => candidate.id === id);
    if (!reader) throw new Error("That reader is no longer connected");
    return reader.kind === "koreader" || reader.kind === "boox" ? prepareFolderImport(reader.path) : prepareImport(reader.path);
  });
  registerTrustedHandler(ipcMain, IMPORT_COMMIT_CHANNEL, () => app.isPackaged, (value: unknown) => {
    const input = validateCommitImport(value);
    const pending = pendingImports.get(input.token);
    if (!pending || !library) throw new Error("Import review has expired");
    const existingSource = pending.sourceProfiles.find(({ id }) => id === input.sourceId);
    if (!existingSource && input.sourceId !== pending.newSourceId) throw new Error("Import source was not reviewed");
    if (!existingSource && !input.newSourceName) throw new Error("Import source name is required");
    if (committingImports.has(input.token)) throw new Error("Import is already being committed");
    committingImports.add(input.token);
    try {
      const receipt = library.importDocument({
        document: pending.preview.document,
        fileName: pending.fileName,
        provider: pending.provider,
        source: {
          id: input.sourceId,
          ...(!existingSource && input.newSourceName ? { name: input.newSourceName } : {}),
          pathHintHash: pending.pathHintHash,
        },
        warnings: pending.preview.warnings,
      });
      pendingImports.delete(input.token);
      return receipt;
    } finally {
      committingImports.delete(input.token);
    }
  });
  registerTrustedHandler(ipcMain, IMPORT_CONFLICTS_LIST_CHANNEL, () => app.isPackaged, () => {
    if (!library) throw new Error("Local library unavailable");
    return library.listImportConflicts();
  });
  registerTrustedHandler(ipcMain, IMPORT_CONFLICT_RESOLVE_CHANNEL, () => app.isPackaged, (value: unknown) => {
    if (!library) throw new Error("Local library unavailable");
    if (!library.resolveImportConflict(validateConflictResolution(value))) {
      throw new Error("Import conflict changed; review the refreshed values");
    }
  });
  registerTrustedHandler(ipcMain, SYNC_CONFLICTS_LIST_CHANNEL, () => app.isPackaged, () => {
    if (!library) throw new Error("Local library unavailable");
    return library.listSyncConflicts();
  });
  registerTrustedHandler(ipcMain, SYNC_CONFLICT_RESOLVE_CHANNEL, () => app.isPackaged, (value: unknown) => {
    if (!library) throw new Error("Local library unavailable");
    if (!library.resolveSyncConflict(validateSyncConflictResolution(value))) {
      throw new Error("This item changed; review the refreshed version");
    }
  });
  registerTrustedHandler(ipcMain, SYNC_RUN_CHANNEL, () => app.isPackaged, (input: unknown) => {
    if (fileOperationInProgress) throw new Error("Wait for the library file operation to finish before synchronizing");
    return syncTracker.run(validateSyncRunOptions(input));
  });
  registerTrustedHandler(ipcMain, SYNC_STATUS_CHANNEL, () => app.isPackaged, () => syncTracker.current());
  registerTrustedHandler(ipcMain, BACKUP_CREATE_CHANNEL, () => app.isPackaged, async () => {
    return runExclusiveFileOperation(createBackup);
  });
  registerTrustedHandler(ipcMain, BACKUP_RESTORE_CHANNEL, () => app.isPackaged, async () => {
    return runExclusiveFileOperation(restoreBackup);
  });
  registerTrustedHandler(ipcMain, LIBRARY_EXPORT_CHANNEL, () => app.isPackaged, async () => {
    return runExclusiveFileOperation(exportLibrary);
  });
  registerTrustedHandler(ipcMain, LIBRARY_STATISTICS_CHANNEL, () => app.isPackaged, () => {
    if (!library) throw new Error("Local library unavailable");
    return libraryStatistics(createLibraryExport(library));
  });
  registerTrustedHandler(ipcMain, LIBRARY_DUPLICATES_CHANNEL, () => app.isPackaged, () => {
    if (!library) throw new Error("Local library unavailable");
    return findLibraryDuplicates(createLibraryExport(library));
  });
  registerTrustedHandler(ipcMain, LIBRARY_EXPORT_MARKDOWN_CHANNEL, () => app.isPackaged, async (options: unknown) => {
    if (typeof options !== "object" || options === null || Array.isArray(options) ||
        Object.keys(options).join() !== "includeArchived" || typeof (options as { includeArchived: unknown }).includeArchived !== "boolean") {
      throw new Error("Markdown export options are invalid");
    }
    const { includeArchived } = options as { includeArchived: boolean };
    return runExclusiveFileOperation(() => exportMarkdown(includeArchived));
  });
  // Update checks run only when the reader asks (ADR 0007).
  const nativeUpdateOptions = { platform: process.platform, executable: process.execPath, args: process.argv.slice(1), quit: () => app.quit() };
  const updater = new DesktopUpdater({
    currentVersion: app.getVersion(),
    architecture: process.arch,
    platform: process.platform === "darwin" ? "mac" : process.platform === "win32" ? "windows" : "linux",
    channel: app.getVersion().includes("-") ? "beta" : "stable",
    temporaryDirectory: app.getPath("temp"),
    nativeUnavailableReason: process.platform === "linux" ? undefined : () => nativeUpdateUnavailable(nativeUpdateOptions),
    installNative: (download, manifest) => installNativeUpdate(download, manifest, nativeUpdateOptions),
    appImagePath: process.env.APPIMAGE,
    packaged: app.isPackaged,
    flatpak: Boolean(process.env.FLATPAK_ID) || existsSync("/.flatpak-info"),
    trustedKeys: TRUSTED_UPDATE_KEYS,
    transport: createUpdateTransport(app.getVersion()),
    relaunch: (appImagePath) => {
      // quit() rather than exit() so the library closes before the restart.
      app.relaunch({ execPath: appImagePath, args: process.argv.slice(1) });
      app.quit();
    },
  });
  let availableVersion: string | undefined;
  const checkForUpdates = async () => {
    const status = await updater.check();
    availableVersion = status.state === "available" ? status.version : undefined;
    return status;
  };
  const automaticCheck = () => {
    try {
      return loadUpdatePreferences({ defaultConfigPath: remoteConfigPath() }).automaticCheck;
    } catch {
      return false;
    }
  };
  const describeUpdates = () => ({ automaticCheck: automaticCheck(), ...(availableVersion ? { availableVersion } : {}) });
  stopAutomaticUpdateChecks = scheduleAutomaticUpdateChecks({
    enabled: () => !updater.unavailableReason() && automaticCheck(),
    check: checkForUpdates,
    onAvailable: (version) => { mainWindow?.webContents.send(UPDATES_AVAILABLE_CHANNEL, version); },
  });
  registerTrustedHandler(ipcMain, UPDATES_CHECK_CHANNEL, () => app.isPackaged, () => checkForUpdates());
  registerTrustedHandler(ipcMain, UPDATES_DESCRIBE_CHANNEL, () => app.isPackaged, () => describeUpdates());
  registerTrustedHandler(ipcMain, UPDATES_SET_AUTOMATIC_CHANNEL, () => app.isPackaged, (enabled: unknown) => {
    if (typeof enabled !== "boolean") throw new Error("Update preference is invalid");
    writeUpdatePreferences(activeConfigPath(), { automaticCheck: enabled });
    return describeUpdates();
  });
  registerTrustedHandler(ipcMain, DASHBOARDS_DESCRIBE_CHANNEL, () => app.isPackaged, () => {
    return loadDashboardLayouts({ defaultConfigPath: remoteConfigPath() });
  });
  registerTrustedHandler(ipcMain, DASHBOARDS_SAVE_CHANNEL, () => app.isPackaged, (dashboard: unknown, layout: unknown) => {
    if (dashboard !== "library" && dashboard !== "statistics") throw new Error("Dashboard is unknown");
    return writeDashboardLayout(activeConfigPath(), dashboard, layout);
  });
  registerTrustedHandler(ipcMain, WIDGETS_SAVE_CHANNEL, () => app.isPackaged, (widget: unknown) => {
    return writeCustomWidget(activeConfigPath(), widget);
  });
  registerTrustedHandler(ipcMain, WIDGETS_DELETE_CHANNEL, () => app.isPackaged, (id: unknown) => {
    return deleteCustomWidget(activeConfigPath(), id);
  });
  registerTrustedHandler(ipcMain, WIDGETS_EVALUATE_CHANNEL, () => app.isPackaged, (widgets: unknown) => {
    if (!library) throw new Error("Local library unavailable");
    if (!Array.isArray(widgets) || widgets.length === 0 || widgets.length > WIDGET_LIMITS.evaluate) throw new Error("Widgets to count are invalid");
    const recipes = widgets.map((widget: unknown) => parseCustomWidget(widget));
    // One snapshot for the whole batch, counted in this computer's time zone.
    const dataset = widgetDataset(createLibraryExport(library));
    const { timeZone } = Intl.DateTimeFormat().resolvedOptions();
    return recipes.map((recipe) => evaluateWidget(dataset, recipe, { timeZone }));
  });
  registerTrustedHandler(ipcMain, WIDGETS_EXPORT_CHANNEL, () => app.isPackaged, (id: unknown) => {
    return exportWidget(id);
  });
  registerTrustedHandler(ipcMain, WIDGETS_IMPORT_CHANNEL, () => app.isPackaged, () => {
    return importWidgets();
  });
  // Not while a backup, restore, or sync is writing: the update restarts the app.
  registerTrustedHandler(ipcMain, UPDATES_INSTALL_CHANNEL, () => app.isPackaged, async () => {
    return runExclusiveFileOperation(() => updater.install());
  });
  registerTrustedHandler(ipcMain, REMOTE_DESCRIBE_CHANNEL, () => app.isPackaged, () => {
    return describeRemote();
  });
  registerTrustedHandler(ipcMain, REMOTE_SAVE_CHANNEL, () => app.isPackaged, async (input: unknown) => {
    const summary = await saveRemote(input);
    syncTracker.configurationChanged();
    return summary;
  });
  registerTrustedHandler(ipcMain, REMOTE_CHECK_CHANNEL, () => app.isPackaged, async () => {
    return checkRemote();
  });
  registerTrustedHandler(ipcMain, REMOTE_INITIALIZE_CHANNEL, () => app.isPackaged, async () => {
    return initializeRemote();
  });
  registerTrustedHandler(ipcMain, AI_DESCRIBE_CHANNEL, () => app.isPackaged, () => {
    return describeAi();
  });
  registerTrustedHandler(ipcMain, AI_SAVE_CHANNEL, () => app.isPackaged, (input: unknown) => {
    return saveAi(input);
  });
  registerTrustedHandler(ipcMain, AI_ACCEPT_TERMS_CHANNEL, () => app.isPackaged, (providerId: unknown) => {
    return acceptAiProviderTerms(activeConfigPath(), validateProviderId(providerId));
  });
  registerTrustedHandler(ipcMain, AI_DESCRIBE_TASK_CHANNEL, () => app.isPackaged, (bookId: unknown, highlightId: unknown, includeNotes: unknown) => {
    return describeExplainTask(validateExplainTarget(bookId, highlightId, includeNotes));
  });
  registerTrustedHandler(ipcMain, AI_EXPLAIN_CHANNEL, () => app.isPackaged, async (input: unknown) => {
    return explainPassage(validateExplainRequest(input));
  });
  registerTrustedHandler(ipcMain, AI_CANCEL_CHANNEL, () => app.isPackaged, (requestId: unknown) => {
    if (typeof requestId !== "string" || !isUuid(requestId)) throw new Error("AI request is invalid");
    aiRequests.get(requestId)?.abort();
  });
  registerTrustedHandler(ipcMain, APPEARANCE_DESCRIBE_CHANNEL, () => app.isPackaged, () => {
    return describeAppearance();
  });
  registerTrustedHandler(ipcMain, APPEARANCE_SAVE_CHANNEL, () => app.isPackaged, (input: unknown) => {
    return saveAppearance(input);
  });
  registerTrustedHandler(ipcMain, APPEARANCE_EXPORT_THEME_CHANNEL, () => app.isPackaged, (themeId: unknown) => {
    return exportTheme(themeId);
  });
  registerTrustedHandler(ipcMain, APPEARANCE_IMPORT_THEME_CHANNEL, () => app.isPackaged, () => {
    return importTheme();
  });
  registerTrustedHandler(ipcMain, APPEARANCE_OPEN_THEMES_FOLDER_CHANNEL, () => app.isPackaged, async () => {
    // The folder sits beside the protected config, so it inherits that trust
    // root; it is created owner-only, like the config directory.
    const folder = join(dirname(canonicalConfigPath(activeConfigPath())), "themes");
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const problem = await shell.openPath(folder);
    if (problem) throw new Error("Leaflogue could not open the themes folder");
    return folder;
  });

  createWindow();
  // Catch up with the reader's other devices once the window has painted.
  setTimeout(() => {
    if (library && !fileOperationInProgress && syncTracker.current().state === "idle") void syncTracker.run().catch(() => undefined);
  }, 2_000);
  restartAppearanceWatcher();
  nativeTheme.on("updated", () => {
    const appearance = describeAppearance();
    if (appearance.mode === "system") {
      mainWindow?.setBackgroundColor(nativeAppearanceBackground(appearance, nativeTheme.shouldUseDarkColors));
    }
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch(() => {
  console.error("Leaflogue could not finish starting.");
  app.quit();
});

async function runExclusiveFileOperation<Result>(operation: () => Promise<Result>): Promise<Result> {
  if (syncService.isRunning) throw new Error("Wait for synchronization to finish before replacing library files");
  if (fileOperationInProgress) throw new Error("A backup or restore operation is already in progress");
  fileOperationInProgress = true;
  try {
    return await operation();
  } finally {
    fileOperationInProgress = false;
  }
}

app.on("window-all-closed", () => {
  if (!mcpMode && process.platform !== "darwin") app.quit();
});

let shutdownReady = false;
app.on("before-quit", (event) => {
  if (syncService.isRunning && !shutdownReady) {
    event.preventDefault();
    void syncService.shutdown().finally(() => {
      shutdownReady = true;
      app.quit();
    });
    return;
  }
  coverCache.close();
  stopAppearanceWatcher?.();
  stopAppearanceWatcher = undefined;
  stopAutomaticUpdateChecks?.();
  stopAutomaticUpdateChecks = undefined;
  stopReaderWatch?.();
  stopReaderWatch = undefined;
  library?.close();
  library = undefined;
});

function validateNewBook(value: unknown): NewBook {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Book details are invalid");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 1_000) {
    throw new Error("Book title is invalid");
  }
  if (
    input.authors !== undefined &&
    (!Array.isArray(input.authors) ||
      input.authors.length > 30 ||
      !input.authors.every((author) => typeof author === "string" && author.length <= 300))
  ) {
    throw new Error("Book authors are invalid");
  }
  if (input.isbn13 !== undefined && (typeof input.isbn13 !== "string" || input.isbn13.length > 40)) {
    throw new Error("Book ISBN is invalid");
  }
  return {
    title: input.title,
    ...(Array.isArray(input.authors) ? { authors: input.authors as string[] } : {}),
    ...(typeof input.isbn13 === "string" && input.isbn13.trim() ? { isbn13: input.isbn13 } : {}),
  };
}

function validateNewHighlight(value: unknown): NewHighlight {
  const input = annotationRecord(value);
  const sourceLocation = optionalTextField(input, "sourceLocation", 2_000);
  const noteMarkdown = optionalNoteField(input, "noteMarkdown");
  return {
    bookId: uuidField(input, "bookId") as BookId,
    text: textField(input, "text", 100_000),
    ...(sourceLocation ? { sourceLocation } : {}),
    ...(noteMarkdown ? { noteMarkdown } : {}),
  };
}

function validateUpdateHighlight(value: unknown): UpdateHighlight {
  const input = annotationRecord(value);
  const sourceLocation = optionalTextField(input, "sourceLocation", 2_000);
  return {
    id: uuidField(input, "id") as HighlightId,
    bookId: uuidField(input, "bookId") as BookId,
    text: textField(input, "text", 100_000),
    ...(sourceLocation ? { sourceLocation } : {}),
    expectedRevision: revisionField(input),
  };
}

function validateNewNote(value: unknown): NewNote {
  const input = annotationRecord(value);
  const highlightId = input.highlightId === undefined ? undefined : uuidField(input, "highlightId") as HighlightId;
  return {
    bookId: uuidField(input, "bookId") as BookId,
    ...(highlightId ? { highlightId } : {}),
    markdown: noteField(input, "markdown"),
    ...(input.origin === undefined ? {} : { origin: validateNoteOrigin(input.origin) }),
  };
}


function validateUpdateNote(value: unknown): UpdateNote {
  const input = annotationRecord(value);
  return {
    id: uuidField(input, "id") as NoteId,
    bookId: uuidField(input, "bookId") as BookId,
    markdown: noteField(input, "markdown"),
    expectedRevision: revisionField(input),
  };
}

const METADATA_KEYS = new Set(["id", "expectedRevision", "title", "authors", "description", "publisher", "series", "seriesNumber", "language", "isbn13", "coverUrl"]);

function validateUpdateBookMetadata(value: unknown): UpdateBookMetadata {
  const input = annotationRecord(value);
  if (Object.keys(input).some((key) => !METADATA_KEYS.has(key))) throw new Error("Book metadata is invalid");
  if (typeof input.title !== "string" || input.title.length > 1_000) throw new Error("Book metadata is invalid");
  if (!Array.isArray(input.authors) || input.authors.length > 50 ||
      input.authors.some((author) => typeof author !== "string" || author.length > 500)) {
    throw new Error("Book metadata is invalid");
  }
  const optional = (key: string, maximum: number) => {
    const field = input[key];
    if (field === undefined) return {};
    if (typeof field !== "string" || field.length > maximum) throw new Error("Book metadata is invalid");
    return { [key]: field };
  };
  return {
    id: uuidField(input, "id") as BookId,
    expectedRevision: revisionField(input),
    title: input.title,
    authors: input.authors as string[],
    ...optional("description", 20_000),
    ...optional("publisher", 500),
    ...optional("series", 500),
    ...optional("seriesNumber", 40),
    ...optional("language", 35),
    ...optional("isbn13", 40),
    ...optional("coverUrl", 2_048),
  };
}

function validateDeleteAnnotation(value: unknown): { readonly id: string; readonly bookId: BookId; readonly expectedRevision: number } {
  const input = annotationRecord(value);
  if (Object.keys(input).some((key) => key !== "id" && key !== "bookId" && key !== "expectedRevision")) {
    throw new Error("Annotation details are invalid");
  }
  return {
    id: uuidField(input, "id"),
    bookId: uuidField(input, "bookId") as BookId,
    expectedRevision: revisionField(input),
  };
}

function validateResetHighlight(value: unknown): ResetHighlightToSource {
  const input = annotationRecord(value);
  if (Object.keys(input).some((key) => !["id", "bookId", "expectedRevision", "resetToken"].includes(key)) ||
      typeof input.resetToken !== "string" || !/^[0-9a-f]{64}$/u.test(input.resetToken)) {
    throw new Error("Passage reset details are invalid");
  }
  return {
    id: uuidField(input, "id") as HighlightId,
    bookId: uuidField(input, "bookId") as BookId,
    expectedRevision: revisionField(input),
    resetToken: input.resetToken,
  };
}

function validateSetBookArchived(value: unknown): SetBookArchived {
  const input = annotationRecord(value);
  if (typeof input.archived !== "boolean") throw new Error("Archive state is invalid");
  return {
    id: uuidField(input, "id") as BookId,
    archived: input.archived,
    expectedRevision: revisionField(input),
  };
}

function validateMergeBooks(value: unknown): MergeBooks {
  const input = annotationRecord(value);
  const expectedSourceRevision = input.expectedSourceRevision;
  const expectedTargetRevision = input.expectedTargetRevision;
  if (typeof expectedSourceRevision !== "number" || !Number.isSafeInteger(expectedSourceRevision) || expectedSourceRevision < 1 ||
      typeof expectedTargetRevision !== "number" || !Number.isSafeInteger(expectedTargetRevision) || expectedTargetRevision < 1) {
    throw new Error("Book merge revision is invalid");
  }
  return {
    sourceBookId: uuidField(input, "sourceBookId") as BookId,
    targetBookId: uuidField(input, "targetBookId") as BookId,
    expectedSourceRevision,
    expectedTargetRevision,
  };
}

function validateCollection(value: unknown): NewCollection {
  const input = organizationRecord(value);
  const description = organizationOptionalField(input, "description", 2_000);
  return { name: organizationNameField(input, "name", 120), ...(description ? { description } : {}) };
}

function validateCollectionUpdate(value: unknown): UpdateCollection {
  const input = organizationRecord(value);
  return {
    id: organizationIdField(input, "id") as CollectionId,
    ...validateCollection(input),
    expectedRevision: organizationRevisionField(input),
  };
}

function validateTag(value: unknown): NewTag {
  const input = organizationRecord(value);
  const color = organizationOptionalField(input, "color", 32);
  return { name: organizationNameField(input, "name", 80), ...(color ? { color } : {}) };
}

function validateTagUpdate(value: unknown): UpdateTag {
  const input = organizationRecord(value);
  return {
    id: organizationIdField(input, "id") as TagId,
    ...validateTag(input),
    expectedRevision: organizationRevisionField(input),
  };
}

function validateOrganizationDelete(value: unknown, kind: "collection" | "tag"): DeleteCollection | DeleteTag {
  const input = organizationRecord(value);
  const expectedRevision = organizationRevisionField(input);
  const id = organizationIdField(input, "id");
  return kind === "collection"
    ? { id: id as CollectionId, expectedRevision }
    : { id: id as TagId, expectedRevision };
}

function validateMembership(value: unknown, kind: "collection" | "tag"): SetBookCollectionMembership | SetBookTagMembership {
  const input = organizationRecord(value);
  if (typeof input.included !== "boolean") throw new Error("Organisation membership state is invalid");
  const containerKey = kind === "collection" ? "collectionId" : "tagId";
  return {
    bookId: organizationIdField(input, "bookId") as BookId,
    [containerKey]: organizationIdField(input, containerKey) as CollectionId & TagId,
    included: input.included,
  } as unknown as SetBookCollectionMembership | SetBookTagMembership;
}

function validateHighlightMembership(value: unknown): SetHighlightTagMembership {
  const input = organizationRecord(value);
  if (typeof input.included !== "boolean") throw new Error("Organisation membership state is invalid");
  return {
    bookId: organizationIdField(input, "bookId") as BookId,
    highlightId: organizationIdField(input, "highlightId") as HighlightId,
    tagId: organizationIdField(input, "tagId") as TagId,
    included: input.included,
  };
}

function organizationRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Organisation details are invalid");
  }
  return value as Record<string, unknown>;
}

function organizationIdField(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !isUuid(value)) throw new Error("Organisation identifier is invalid");
  return value;
}

function organizationNameField(input: Record<string, unknown>, key: string, maximum: number): string {
  const value = input[key];
  if (typeof value !== "string") throw new Error("Organisation name is invalid");
  const name = value.trim().replace(/\s+/gu, " ");
  if (!name || name.length > maximum) throw new Error("Organisation name is invalid");
  return name;
}

function organizationOptionalField(input: Record<string, unknown>, key: string, maximum: number): string | undefined {
  const value = input[key];
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new Error("Organisation detail is invalid");
  const text = value.trim();
  if (text.length > maximum) throw new Error("Organisation detail is invalid");
  return text || undefined;
}

function organizationRevisionField(input: Record<string, unknown>): number {
  const value = input.expectedRevision;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("Organisation revision is invalid");
  }
  return value;
}

function annotationRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Annotation details are invalid");
  }
  return value as Record<string, unknown>;
}

function uuidField(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !isUuid(value)) throw new Error("Annotation identifier is invalid");
  return value;
}

function textField(input: Record<string, unknown>, key: string, maximum: number): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error("Annotation text is invalid");
  }
  return value;
}

function noteField(input: Record<string, unknown>, key: string): string {
  const value = textField(input, key, 100_000);
  if (new TextEncoder().encode(value.trim()).byteLength > MAX_NOTE_BYTES) throw new Error("Annotation text is invalid");
  return value;
}

function optionalNoteField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === "") return undefined;
  return noteField(input, key);
}

function optionalTextField(input: Record<string, unknown>, key: string, maximum: number): string | undefined {
  const value = input[key];
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.length > maximum) throw new Error("Annotation location is invalid");
  return value;
}

function revisionField(input: Record<string, unknown>): number {
  const value = input.expectedRevision;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("Annotation revision is invalid");
  }
  return value;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function publicReader({ id, kind, label }: DetectedReader) {
  return { id, kind, label };
}

async function chooseImportFile(): Promise<PendingImport | undefined> {
  if (!mainWindow) throw new Error("Application window unavailable");
  const selected = await dialog.showOpenDialog(mainWindow, {
    title: "Choose reading annotations",
    buttonLabel: "Review import",
    properties: Array.of(`open${"File"}`),
    filters: [
      { name: "Reading annotations", extensions: ["sqlite", "db", "txt", "json", "lua"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  const selectedPath = selected.filePaths[0];
  if (selected.canceled || !selectedPath) return undefined;
  return prepareImport(selectedPath);
}

async function chooseImportFolder(): Promise<PendingImport | undefined> {
  if (!mainWindow) throw new Error("Application window unavailable");
  const selected = await dialog.showOpenDialog(mainWindow, {
    title: "Choose a folder with KOReader or Boox highlights",
    buttonLabel: "Review import",
    properties: ["openDirectory"],
  });
  const selectedPath = selected.filePaths[0];
  if (selected.canceled || !selectedPath) return undefined;
  return prepareFolderImport(selectedPath);
}

/** Copy, inspect, and hold an import file for review; shared by the file dialog and connected readers. */
async function prepareImport(selectedPath: string): Promise<PendingImport> {
  // Check before copying, so a huge or special file is refused without first
  // being duplicated into the temp directory. The copy is checked again below.
  const selectedInfo = statSync(selectedPath);
  if (!selectedInfo.isFile()) throw new Error("Choose a regular file");
  if (selectedInfo.size > MAX_KOBO_FILE_BYTES) throw new Error("That file is too large to import");
  const directory = mkdtempSync(join(app.getPath("temp"), "leaflogue-import-"));
  const copyPath = join(directory, `source${extname(selectedPath).toLocaleLowerCase("en")}`);
  try {
    copyFileSync(selectedPath, copyPath);
    copyWriteAheadLog(selectedPath, copyPath);
    const info = statSync(copyPath);
    if (!info.isFile()) throw new Error("Choose a regular file");
    const { provider, preview } = await inspectImportCopy(copyPath, info.size, selectedPath);
    return holdImport(provider, preview, selectedPath);
  } catch {
    throw new Error("Leaflogue could not safely read that file");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * A folder or device: every KOReader sidecar under it or, failing that, the
 * Boox exports directly inside it. Files are read in place without copying.
 */
async function prepareFolderImport(folder: string): Promise<PendingImport> {
  try {
    if (!statSync(folder).isDirectory()) throw new Error("Choose a folder");
    const sidecars = collectKOReaderSidecars(folder);
    if (sidecars.length > 0) return holdImport("koreader", await parseKOReaderSidecars(sidecars), folder);
    return holdImport("boox", await parseBooxExports(collectBooxExports(folder, looksLikeBooxExport)), folder);
  } catch {
    throw new Error("Leaflogue could not find highlights in that folder");
  }
}

function holdImport(provider: ImportProvider, preview: ImportPreview, selectedPath: string): PendingImport {
  if (!library) throw new Error("Local library unavailable");
  const token = randomUUID();
  const pathHintHash = createHash("sha256").update(realpathSync(selectedPath)).digest("hex");
  const storedProfiles = library.listImportSources(provider);
  const sourceProfiles = storedProfiles.map(({ id, provider: sourceProvider, name, lastImportedAt }) => ({
    id,
    provider: sourceProvider,
    name,
    lastImportedAt,
  }));
  const suggestedSourceId = storedProfiles.find((profile) => profile.pathHintHash === pathHintHash)?.id;
  const pending: PendingImport & { readonly pathHintHash: string } = {
    token,
    fileName: basename(selectedPath),
    provider,
    preview,
    sourceProfiles,
    newSourceId: randomUUID(),
    ...(suggestedSourceId ? { suggestedSourceId } : {}),
    suggestedSourceName: suggestedImportSourceName(provider, selectedPath),
    pathHintHash,
  };
  pendingImports.set(token, pending);
  const expiry = setTimeout(() => pendingImports.delete(token), 10 * 60 * 1_000);
  expiry.unref();
  return {
    token,
    fileName: pending.fileName,
    provider,
    preview,
    sourceProfiles,
    newSourceId: pending.newSourceId,
    ...(suggestedSourceId ? { suggestedSourceId } : {}),
    suggestedSourceName: pending.suggestedSourceName,
  };
}

const IMPORT_PROVIDER_NAMES: Record<ImportProvider, string> = {
  kobo: "Kobo",
  kindle: "Kindle",
  koreader: "KOReader",
  pocketbook: "PocketBook",
  tolino: "Tolino",
  boox: "Boox",
  portable: "Portable",
};

function suggestedImportSourceName(provider: PendingImport["provider"], path: string): string {
  const fileStem = basename(path, extname(path)).trim();
  const providerName = IMPORT_PROVIDER_NAMES[provider];
  return fileStem && fileStem.toLocaleLowerCase("en") !== providerName.toLocaleLowerCase("en")
    ? `${providerName} — ${fileStem}`.slice(0, 200)
    : `${providerName} library`;
}

async function inspectImportCopy(path: string, size: number, originalPath: string): Promise<{ provider: ImportProvider; preview: ImportPreview }> {
  const extension = extname(path).toLocaleLowerCase("en");
  if (extension === ".txt") {
    if (size > 16 * 1024 * 1024) throw new Error("Text file exceeds 16 MiB");
    const source = readFileSync(path, "utf8");
    // Kindle's separator is a line of ten "=", Tolino's and Boox's are dashes.
    if (/^={10}\s*$/mu.test(source)) return { provider: "kindle", preview: await parseKindleClippings(source) };
    if (looksLikeBooxExport(source)) return { provider: "boox", preview: await parseBooxExport(source) };
    if (looksLikeTolinoNotes(source)) return { provider: "tolino", preview: await parseTolinoNotes(source) };
    return { provider: "kindle", preview: await parseKindleClippings(source) };
  }
  if (extension === ".json") {
    if (size > 16 * 1024 * 1024) throw new Error("Portable file exceeds 16 MiB");
    return { provider: "portable", preview: parsePortableJson(readFileSync(path, "utf8")) };
  }
  if (extension === ".lua") {
    if (size > 8 * 1024 * 1024) throw new Error("KOReader sidecar exceeds 8 MiB");
    // The sidecar's own folder name ("Title.sdr") is the title when the file has none.
    const sidecarPath = join(basename(dirname(originalPath)), basename(originalPath));
    return { provider: "koreader", preview: await parseKOReaderSidecars([{ path: sidecarPath, source: readFileSync(path, "utf8") }]) };
  }
  if (size < 100 || size > MAX_KOBO_FILE_BYTES) throw new Error("Database size is invalid");
  // A copied write-ahead log holds the reader's latest changes. Opening the
  // private copy read-write lets SQLite fold it in; queries stay read-only.
  const hasLog = existsSync(`${path}-wal`);
  const database = new DatabaseSync(path, { readOnly: !hasLog });
  try {
    database.exec("PRAGMA query_only = ON");
    const readonlyDatabase = database as unknown as ReadonlyDatabase;
    if (isPocketBookDatabase(readonlyDatabase)) {
      return { provider: "pocketbook", preview: await extractPocketBookDatabase(readonlyDatabase) };
    }
    return { provider: "kobo", preview: extractKoboDatabase(readonlyDatabase) };
  } finally {
    database.close();
  }
}

/**
 * Copy a database's `-wal` file beside its private copy when the reader left
 * one (PocketBook keeps recent highlights there until it checkpoints). The
 * log is refused unless it is a regular file within the same size limit.
 */
function copyWriteAheadLog(selectedPath: string, copyPath: string): void {
  const log = `${selectedPath}-wal`;
  let info;
  try {
    info = lstatSync(log);
  } catch {
    return;
  }
  if (!info.isFile() || info.size === 0 || info.size > MAX_KOBO_FILE_BYTES) return;
  copyFileSync(log, `${copyPath}-wal`);
}

async function createBackup(): Promise<BackupReceipt | undefined> {
  if (!mainWindow || !library || !libraryPath) throw new Error("Local library unavailable");
  const date = new Date().toISOString().slice(0, 10);
  const selected = await dialog.showSaveDialog(mainWindow, {
    title: "Back up Leaflogue",
    buttonLabel: "Save backup",
    defaultPath: `Leaflogue-backup-${date}.sqlite`,
    filters: [{ name: "Leaflogue backup", extensions: ["sqlite"] }],
  });
  if (selected.canceled || !selected.filePath) return undefined;
  assertSafeExportDestination(selected.filePath, libraryPath);
  const temporaryPath = `${selected.filePath}.${randomUUID()}.tmp`;
  try {
    await library.backupTo(temporaryPath);
    chmodSync(temporaryPath, 0o600);
    // Windows requires a writable handle for FlushFileBuffers/fsync.
    const descriptor = openSync(temporaryPath, "r+");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporaryPath, selected.filePath);
    return { fileName: basename(selected.filePath) };
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

async function exportLibrary(): Promise<LibraryExportReceipt | undefined> {
  if (!mainWindow || !library || !libraryPath) throw new Error("Local library unavailable");
  const date = new Date().toISOString().slice(0, 10);
  const selected = await dialog.showSaveDialog(mainWindow, {
    title: "Export Leaflogue library",
    buttonLabel: "Export library",
    defaultPath: `Leaflogue-library-${date}.json`,
    filters: [{ name: "Leaflogue library export", extensions: ["json"] }],
  });
  if (selected.canceled || !selected.filePath) return undefined;
  assertSafeExportDestination(selected.filePath, libraryPath);
  const counts = writeLibraryExport(selected.filePath, library);
  return { fileName: basename(selected.filePath), ...counts };
}

async function exportMarkdown(includeArchived: boolean): Promise<MarkdownExportReceipt | undefined> {
  if (!mainWindow || !library || !libraryPath) throw new Error("Local library unavailable");
  const selected = await dialog.showOpenDialog(mainWindow, {
    title: "Choose where to save the Markdown export",
    buttonLabel: "Export here",
    properties: ["openDirectory", "createDirectory"],
  });
  const parent = selected.filePaths[0];
  if (selected.canceled || !parent) return undefined;
  if (!statSync(parent).isDirectory()) throw new Error("Choose a folder");
  if (normalize(parent) === normalize(dirname(libraryPath))) throw new Error("Choose a folder outside Leaflogue's data folder");
  const document = createLibraryExport(library);
  return writeMarkdownExport(parent, includeArchived ? document : { ...document, books: document.books.filter(({ book }) => !book.archived) });
}

async function restoreBackup(): Promise<RestoreReceipt | undefined> {
  if (!mainWindow || !libraryPath) throw new Error("Local library unavailable");
  const liveLibraryPath = libraryPath;
  const selected = await dialog.showOpenDialog(mainWindow, {
    title: "Restore a Leaflogue backup",
    buttonLabel: "Restore backup",
    properties: ["openFile"],
    filters: [{ name: "Leaflogue backup", extensions: ["sqlite", "db"] }],
  });
  const selectedPath = selected.filePaths[0];
  if (selected.canceled || !selectedPath) return undefined;
  assertSafeExportDestination(selectedPath, liveLibraryPath);
  const info = statSync(selectedPath);
  if (!info.isFile() || info.size < 100 || info.size > 2 * 1024 * 1024 * 1024) {
    throw new Error("Backup file size is invalid");
  }

  const stagedPath = `${liveLibraryPath}.restore`;
  const previousPath = `${liveLibraryPath}.previous`;
  const journalPath = `${liveLibraryPath}.restore-state.json`;
  recoverInterruptedRestore(liveLibraryPath);
  copyFileSync(selectedPath, stagedPath);
  chmodSync(stagedPath, 0o600);
  try {
    validateLibraryBackup(stagedPath);
  } catch (error) {
    rmSync(stagedPath, { force: true });
    throw error;
  }

  library?.close();
  library = undefined;
  try {
    rmSync(`${liveLibraryPath}-wal`, { force: true });
    rmSync(`${liveLibraryPath}-shm`, { force: true });
    library = replaceFileWithRollback({
      targetPath: liveLibraryPath,
      stagedPath,
      recoveryPath: previousPath,
      journalPath,
      activate: () => {
        const restored = new LocalLibrary(liveLibraryPath);
        restored.resetSyncStateAfterRestore();
        return restored;
      },
    });
    const receipt = {
      fileName: basename(selectedPath),
      booksRestored: library.listBooks({ includeArchived: true }).length,
      databaseSchemaVersion: library.schemaVersion,
    } satisfies RestoreReceipt;
    pendingImports.clear();
    return receipt;
  } catch (error) {
    library?.close();
    library = undefined;
    if (!(error instanceof AggregateError) && existsSync(liveLibraryPath)) {
      library = new LocalLibrary(liveLibraryPath);
    }
    throw error;
  } finally {
    rmSync(stagedPath, { force: true });
  }
}

function recoverInterruptedRestore(liveLibraryPath: string): void {
  recoverInterruptedFileReplacement({
    targetPath: liveLibraryPath,
    stagedPath: `${liveLibraryPath}.restore`,
    recoveryPath: `${liveLibraryPath}.previous`,
    journalPath: `${liveLibraryPath}.restore-state.json`,
  });
}

function readRemoteConfig() {
  return loadRemoteConfig({ defaultConfigPath: remoteConfigPath() });
}

/** Sync is set up once a provider can be reached without asking the reader for anything. */
function syncConfigured(): boolean {
  try {
    const config = readRemoteConfig();
    return config?.provider === "postgres" || (config?.provider === "convex" && Boolean(config.syncKey));
  } catch {
    // A broken configuration still counts, so its error shows when sync runs.
    return true;
  }
}

function remoteConfigPath(): string {
  const defaultPath = desktopPaths.defaultConfigFile;
  if (process.env.LEAFLOGUE_CONFIG_FILE?.trim()) return defaultPath;
  const locatorPath = desktopPaths.configLocatorFile;
  try {
    const candidate = JSON.parse(readFileSync(locatorPath, "utf8")) as unknown;
    if (typeof candidate === "object" && candidate !== null && "path" in candidate) {
      const path = (candidate as { path: unknown }).path;
      if (typeof path === "string" && path.length <= 4_096 && isAbsolute(path) && !path.includes("\0")) return path;
    }
  } catch {
    // A missing or invalid locator falls back to the platform configuration directory.
  }
  return defaultPath;
}

async function saveRemote(value: unknown): Promise<RemoteConfigurationSummary | undefined> {
  if (syncService.isRunning) throw new Error("Wait for synchronization to finish before changing the remote connection");
  if (!mainWindow || typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Remote setup is invalid");
  }
  const input = value as Record<string, unknown>;
  if ((input.provider !== "postgres" && input.provider !== "convex") ||
      (input.location !== "default" && input.location !== "choose")) {
    throw new Error("Remote setup is invalid");
  }
  let setup: Parameters<typeof writeRemoteConfig>[1];
  if (input.provider === "postgres") {
    if (typeof input.databaseUrl !== "string" || !input.databaseUrl.trim() || input.databaseUrl.length > 8_192) {
      throw new Error("PostgreSQL URL is invalid");
    }
    setup = { provider: "postgres", databaseUrl: input.databaseUrl };
  } else {
    if (typeof input.deploymentUrl !== "string" || input.deploymentUrl.length > 2_048) {
      throw new Error("Convex deployment URL is invalid");
    }
    // A blank URL keeps the saved deployment, so a key can be replaced on its own.
    const saved = input.deploymentUrl.trim() ? undefined : readRemoteConfig();
    if (!input.deploymentUrl.trim() && saved?.provider !== "convex") throw new Error("Convex deployment URL is invalid");
    const deploymentUrl = saved?.provider === "convex" ? saved.deploymentUrl : input.deploymentUrl;
    if (input.syncKey !== undefined && (typeof input.syncKey !== "string" || input.syncKey.length > 512)) {
      throw new Error("Convex sync key is invalid");
    }
    setup = { provider: "convex", deploymentUrl,
      ...(typeof input.syncKey === "string" && input.syncKey.trim() ? { syncKey: input.syncKey } : {}) };
  }

  // Sync sends the whole library to this server, so a new server is confirmed
  // in a native dialog the renderer cannot answer for the reader.
  if (!await confirmSyncServer(setup)) return undefined;

  const platformPath = desktopPaths.defaultConfigFile;
  const environmentPath = process.env.LEAFLOGUE_CONFIG_FILE?.trim();
  const activePath = environmentPath || remoteConfigPath();
  let targetPath = environmentPath || platformPath;
  if (input.location === "choose") {
    if (environmentPath) {
      throw new Error("Configuration location is controlled by LEAFLOGUE_CONFIG_FILE");
    }
    const selected = await dialog.showSaveDialog(mainWindow, {
      title: "Choose Leaflogue configuration location",
      buttonLabel: "Save configuration",
      defaultPath: "leaflogue-config.json",
      filters: [{ name: "JSON configuration", extensions: ["json"] }],
    });
    if (selected.canceled || !selected.filePath) return undefined;
    targetPath = selected.filePath;
  }
  const previousConfigRetained = normalize(activePath) !== normalize(targetPath) && existsSync(activePath);
  const publishConfigLocation = environmentPath ? undefined : () => {
    const locatorPath = desktopPaths.configLocatorFile;
    if (normalize(targetPath) === normalize(platformPath)) {
      rmSync(locatorPath, { force: true });
    } else {
      const temporaryPath = `${locatorPath}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporaryPath, `${JSON.stringify({ path: targetPath })}\n`, { mode: 0o600, flag: "wx" });
        chmodSync(temporaryPath, 0o600);
        renameSync(temporaryPath, locatorPath);
      } finally {
        rmSync(temporaryPath, { force: true });
      }
    }
  };
  const config = writeRemoteConfig(targetPath, setup, { sourcePath: activePath, activate: publishConfigLocation });
  restartAppearanceWatcher();
  return { ...summarizeRemoteConfig(config), ...(previousConfigRetained ? { previousConfigRetained: true } : {}) };
}

function syncServerHost(provider: "postgres" | "convex", url: string): string | undefined {
  try {
    return `${provider}:${new URL(url).host}`;
  } catch {
    return undefined;
  }
}

/** Ask before pointing sync at a different provider or host; re-saving the same one asks nothing. */
async function confirmSyncServer(setup: Parameters<typeof writeRemoteConfig>[1]): Promise<boolean> {
  const nextUrl = setup.provider === "postgres" ? setup.databaseUrl : setup.deploymentUrl;
  const next = syncServerHost(setup.provider, nextUrl);
  // An unparseable URL is rejected by validation when it is written.
  if (!next || !mainWindow) return true;
  let current: string | undefined;
  try {
    const saved = readRemoteConfig();
    if (saved) current = syncServerHost(saved.provider, saved.provider === "postgres" ? saved.connectionString : saved.deploymentUrl);
  } catch {
    current = undefined;
  }
  if (current === next) return true;
  const host = new URL(nextUrl).host;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "question",
    title: "Sync with a new server?",
    message: `Sync your library with ${host}?`,
    detail: "When you choose Sync now, Leaflogue sends your books, passages, and notes to this server and receives changes from it. Continue only if you set this server up yourself.",
    buttons: ["Use this server", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  return response === 0;
}

function describeRemote(): RemoteConfigurationSummary {
  try {
    return summarizeRemoteConfig(readRemoteConfig());
  } catch (error) {
    return {
      configured: false,
      problem: error instanceof Error ? error.message : "Leaflogue could not read its remote configuration.",
    };
  }
}

function describeAi(): AiConfigurationSummary {
  return summarizeAiConfig({ defaultConfigPath: remoteConfigPath() });
}

function saveAi(value: unknown): AiConfigurationSummary {
  const configPath = process.env.LEAFLOGUE_CONFIG_FILE?.trim() || remoteConfigPath();
  return writeAiConfig(configPath, validateAiSettings(value));
}

const AI_PROVIDER_NAMES: Readonly<Record<string, string>> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  mistral: "Mistral",
  xai: "xAI",
  deepseek: "DeepSeek",
  "openai-compatible": "OpenAI-compatible",
};
/** Providers whose free tier may use what is sent to improve their products. */
const AI_FREE_TIER_TRAINING = new Set(["gemini"]);
const MAX_ACTIVE_AI_REQUESTS = 4;
const aiRequests = new Map<string, AbortController>();
const aiDisclosures = new AiDisclosureLedger<ExplainPassageDisclosure>();

interface ExplainTarget {
  readonly bookId: BookId;
  readonly highlightId: HighlightId;
  readonly includeNotes: boolean;
}

function validateProviderId(value: unknown): string {
  if (typeof value !== "string" || !Object.hasOwn(AI_PROVIDER_NAMES, value)) throw new Error("AI provider is invalid");
  return value;
}

function validateExplainTarget(bookId: unknown, highlightId: unknown, includeNotes: unknown): ExplainTarget {
  if (typeof bookId !== "string" || !isUuid(bookId) || typeof highlightId !== "string" || !isUuid(highlightId) ||
      typeof includeNotes !== "boolean") {
    throw new Error("AI request is invalid");
  }
  return { bookId: bookId as BookId, highlightId: highlightId as HighlightId, includeNotes };
}

function validateExplainRequest(value: unknown): ExplainPassageRequest {
  const input = annotationRecord(value);
  if (Object.keys(input).some((key) => !["requestId", "disclosureId", "followUp"].includes(key)) ||
      typeof input.requestId !== "string" || !isUuid(input.requestId) ||
      typeof input.disclosureId !== "string" || !isUuid(input.disclosureId)) {
    throw new Error("AI request is invalid");
  }
  if (input.followUp === undefined) return { requestId: input.requestId, disclosureId: input.disclosureId };
  const followUp = annotationRecord(input.followUp);
  if (Object.keys(followUp).some((key) => !["question", "history"].includes(key)) ||
      typeof followUp.question !== "string" || !Array.isArray(followUp.history)) {
    throw new Error("AI request is invalid");
  }
  const history = followUp.history.map((entry: unknown) => {
    const message = annotationRecord(entry);
    if (Object.keys(message).some((key) => !["role", "text"].includes(key)) ||
        (message.role !== "reader" && message.role !== "companion") || typeof message.text !== "string") {
      throw new Error("AI request is invalid");
    }
    return { role: message.role, text: message.text } as const;
  });
  validateCompanionInput({ prompt: followUp.question, history });
  return { requestId: input.requestId, disclosureId: input.disclosureId, followUp: { question: followUp.question, history } };
}

/**
 * Collect exactly what an explanation would transmit. The renderer supplies
 * only identifiers, so no text can reach a provider that is not already a
 * passage of the reader's own library.
 */
function explainMaterial(request: ExplainTarget): ExplainPassageDisclosure {
  if (!library) throw new Error("Local library unavailable");
  const contents = library.getBookContents(request.bookId);
  const highlight = contents?.highlights.find(({ id }) => id === request.highlightId);
  if (!contents || !highlight) throw new Error("That passage is no longer in your library");
  return explainPassageDisclosure({
    passage: highlight.text,
    bookTitle: contents.book.title,
    authors: contents.book.authors,
    ...(contents.book.series ? { series: contents.book.series } : {}),
    ...(contents.book.seriesNumber ? { seriesNumber: contents.book.seriesNumber } : {}),
    ...(contents.book.publisher ? { publisher: contents.book.publisher } : {}),
    ...(contents.book.description ? { description: contents.book.description } : {}),
    ...(request.includeNotes ? { notes: highlight.notes.map(({ markdown }) => markdown) } : {}),
  });
}

function describeExplainTask(request: ExplainTarget): AiTaskDisclosure {
  const summary = describeAi();
  if (!summary.enabled) throw new Error("AI features are disabled");
  const providerId = summary.selectedProvider ?? summary.providers[0]?.id;
  const provider = summary.providers.find(({ id }) => id === providerId);
  if (!provider) throw new Error("An AI provider has not been configured");
  if (provider.credential === "missing") throw new Error("The selected AI provider has no key yet");
  const disclosure = explainMaterial(request);
  const disclosureId = aiDisclosures.issue({
    providerId: provider.id,
    model: provider.selectedModel,
    material: disclosure,
  });
  return {
    disclosureId,
    providerId: provider.id,
    providerName: AI_PROVIDER_NAMES[provider.id] ?? provider.id,
    model: provider.selectedModel,
    trainsOnFreeTier: AI_FREE_TIER_TRAINING.has(provider.id),
    consented: provider.consented,
    bookTitle: disclosure.bookTitle,
    authors: disclosure.authors,
    ...(disclosure.series ? { series: disclosure.series } : {}),
    ...(disclosure.seriesNumber ? { seriesNumber: disclosure.seriesNumber } : {}),
    ...(disclosure.publisher ? { publisher: disclosure.publisher } : {}),
    ...(disclosure.description ? { description: disclosure.description } : {}),
    passage: disclosure.passage,
    notes: disclosure.notes,
  };
}

async function explainPassage(request: ExplainPassageRequest): Promise<PassageExplanation> {
  if (aiRequests.has(request.requestId)) throw new Error("That AI request is already running");
  if (aiRequests.size >= MAX_ACTIVE_AI_REQUESTS) throw new Error("Too many AI requests are already running");
  // Resolving the provider enforces enabled, credential, and accepted terms
  // before any material is prepared.
  const provider = loadAiRuntimeProvider({ defaultConfigPath: remoteConfigPath() });
  const bound = aiDisclosures.resolveFor(request.disclosureId, provider.id, provider.model);
  const controller = new AbortController();
  aiRequests.set(request.requestId, controller);
  try {
    if (!request.followUp) {
      const response = await generateAiText(provider, { ...explainPassageRequest(bound.material), signal: controller.signal });
      return { providerId: response.provider, model: response.model, explanation: parseExplanation(response.text), saveable: true };
    }
    // Follow-ups reuse the web companion's bounded prompts, so both apps hold
    // the same conversation. Only the disclosed passage and book details go out.
    const { passage, bookTitle, authors, series, seriesNumber, publisher, description } = bound.material;
    const input: CompanionInput = {
      primary: { passage, bookTitle, authors, ...(series ? { series } : {}), ...(seriesNumber ? { seriesNumber } : {}), ...(publisher ? { publisher } : {}), ...(description ? { description } : {}) },
      prompt: request.followUp.question,
      history: request.followUp.history,
    };
    if (companionNeedsScopeCheck(input)) {
      const verdict = await generateAiText(provider, { ...companionScopeRequest(input), signal: controller.signal });
      if (!companionInScope(verdict.text)) return { providerId: verdict.provider, model: verdict.model, explanation: companionOutOfScope(input), saveable: false };
    }
    const response = await generateAiText(provider, { ...companionRequest(input), signal: controller.signal });
    return { providerId: response.provider, model: response.model, explanation: parseCompanionAnswer(response.text), saveable: true };
  } finally {
    aiRequests.delete(request.requestId);
  }
}

function activeConfigPath(): string {
  return process.env.LEAFLOGUE_CONFIG_FILE?.trim() || remoteConfigPath();
}

function restartAppearanceWatcher(): void {
  stopAppearanceWatcher?.();
  const configPath = canonicalConfigPath(activeConfigPath());
  stopAppearanceWatcher = createAppearanceWatcher({
    configPath,
    resolveThemePath: () => resolveAppearanceFiles({ defaultConfigPath: remoteConfigPath() }).themePath,
    themesDirectory: join(dirname(configPath), "themes"),
    onChange: reloadAppearance,
  });
}

function readAppearance(): AppearanceConfiguration {
  return loadAppearanceConfig({ defaultConfigPath: remoteConfigPath() });
}

function describeAppearance(): AppearanceConfiguration {
  return appearanceState.describe(readAppearance());
}

function reloadAppearance(): void {
  const transition = appearanceState.reload(readAppearance());
  if (transition.activate) applyNativeAppearance(transition.configuration, nativeTheme, mainWindow);
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(APPEARANCE_CHANGED_CHANNEL, transition.configuration);
  }
}

async function openExternalLink(value: unknown): Promise<boolean> {
  if (!mainWindow) throw new Error("Application window unavailable");
  const url = validateExternalUrl(value);
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "question",
    buttons: ["Open link", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: "Open this link in your browser?",
    detail: url.href,
  });
  if (response !== 0) return false;
  await shell.openExternal(url.href);
  return true;
}

async function exportTheme(themeId: unknown): Promise<ThemeExportReceipt | undefined> {
  if (!mainWindow) throw new Error("Application window unavailable");
  const theme = typeof themeId === "string" ? describeAppearance().themes.find(({ id }) => id === themeId) : undefined;
  if (!theme) throw new Error("Theme is unavailable");
  const manifest = exportableThemeManifest(theme);
  const selected = await dialog.showSaveDialog(mainWindow, {
    title: "Export Leaflogue theme",
    buttonLabel: "Export theme",
    defaultPath: `${manifest.id}.json`,
    filters: [{ name: "Leaflogue theme", extensions: ["json"] }],
  });
  if (selected.canceled || !selected.filePath) return undefined;
  const configPath = canonicalConfigPath(activeConfigPath());
  if (normalize(selected.filePath) === normalize(configPath)) throw new Error("Choose a location other than the protected configuration file");
  writeThemeExport(selected.filePath, manifest);
  return { fileName: basename(selected.filePath), themeName: manifest.name };
}

async function exportWidget(id: unknown): Promise<WidgetExportReceipt | undefined> {
  if (!mainWindow) throw new Error("Application window unavailable");
  const widget = typeof id === "string" ? loadDashboardLayouts({ defaultConfigPath: remoteConfigPath() }).widgets?.find((entry) => entry.id === id) : undefined;
  if (!widget) throw new Error("Custom widget is unavailable");
  const selected = await dialog.showSaveDialog(mainWindow, {
    title: "Export widget",
    buttonLabel: "Export widget",
    defaultPath: `${widget.id}${CUSTOM_WIDGET_FILE_EXTENSION}`,
    filters: [{ name: "Leaflogue widget", extensions: ["json"] }],
  });
  if (selected.canceled || !selected.filePath) return undefined;
  const filePath = selected.filePath.toLowerCase().endsWith(".json") ? selected.filePath : `${selected.filePath}${CUSTOM_WIDGET_FILE_EXTENSION}`;
  const configPath = canonicalConfigPath(activeConfigPath());
  if (normalize(filePath) === normalize(configPath)) throw new Error("Choose a location other than the protected configuration file");
  writeCustomWidgetExport(filePath, widget);
  return { fileName: basename(filePath), title: widget.title };
}

async function importWidgets(): Promise<WidgetImportReceipt | undefined> {
  if (!mainWindow) throw new Error("Application window unavailable");
  const selected = await dialog.showOpenDialog(mainWindow, {
    title: "Import widgets",
    buttonLabel: "Import",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Leaflogue widget", extensions: ["json"] }],
  });
  if (selected.canceled || selected.filePaths.length === 0) return undefined;
  return importCustomWidgetFiles(activeConfigPath(), selected.filePaths);
}

async function importTheme(): Promise<AppearanceConfiguration | undefined> {
  if (!mainWindow) throw new Error("Application window unavailable");
  const selected = await dialog.showOpenDialog(mainWindow, {
    title: "Import a Leaflogue theme",
    buttonLabel: "Import theme",
    properties: ["openFile"],
    filters: [{ name: "Leaflogue theme", extensions: ["json"] }],
  });
  const sourcePath = selected.filePaths[0];
  if (selected.canceled || !sourcePath) return undefined;
  const appearance = importThemeFile(activeConfigPath(), sourcePath);
  appearanceState.save(appearance);
  applyNativeAppearance(appearance, nativeTheme, mainWindow);
  return appearance;
}

function saveAppearance(value: unknown): AppearanceConfiguration {
  const configPath = activeConfigPath();
  const appearance = writeAppearanceConfig(configPath, value as AppearanceSettingsInput);
  appearanceState.save(appearance);
  applyNativeAppearance(appearance, nativeTheme, mainWindow);
  return appearance;
}

async function checkRemote(): Promise<RemoteDatabaseStatus> {
  let config;
  try {
    config = readRemoteConfig();
  } catch {
    return { ...describeRemote(), reachable: false, initialized: false };
  }
  if (!config) {
    return {
      configured: false,
      reachable: false,
      initialized: false,
      problem: "Add a protected config file or LEAFLOGUE_DATABASE_URL first.",
    };
  }
  if (config.provider === "convex") {
    return { ...summarizeRemoteConfig(config), ...(await checkConvex(config.deploymentUrl, { releaseVersion: app.getVersion() })) };
  }
  return { ...summarizeRemoteConfig(config), ...(await checkPostgres(config.connectionString)) };
}

async function initializeRemote(): Promise<RemoteDatabaseStatus> {
  if (syncService.isRunning) throw new Error("Wait for synchronization to finish before changing the remote schema");
  let config;
  try {
    config = readRemoteConfig();
  } catch {
    return { ...describeRemote(), reachable: false, initialized: false };
  }
  if (!config) {
    return {
      configured: false,
      reachable: false,
      initialized: false,
      problem: "Add a protected config file or LEAFLOGUE_DATABASE_URL first.",
    };
  }
  if (config.provider === "convex") {
    return {
      ...summarizeRemoteConfig(config),
      reachable: false,
      initialized: false,
      problem: "Deploy the Convex schema with the CLI, then use Check connection in Leaflogue.",
    };
  }
  return { ...summarizeRemoteConfig(config), ...(await initializePostgres(config.connectionString)) };
}
