
import { Select, SelectItem } from "@leaflogue/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArchiveRestore, Download, FolderOpen, LogOut, Network, Palette, RefreshCw, Save, Sparkles, Upload, UserRound } from "../components/icons";
import { BUILT_IN_THEMES } from "@leaflogue/appearance";
import { TitleRow } from "@leaflogue/ui";
import type {
  AiConfigurationSummary,
  McpConfiguration,
  AppearanceConfiguration,
  AppearanceMode,
  RemoteConfigurationSummary,
  ThemeDefinition,
  RemoteDatabaseStatus,
  SystemCapabilities,
  UpdateStatus,
} from "@leaflogue/contracts";
import { activateAppearance } from "../appearance";
import { useDesktop, useHost } from "../host";
import { setNavigationBlocker } from "../router";
import { focusSetting, settingAnchor, settingRequests, settingsSections } from "../palette/settings-index";
import { APPEARANCE_SAVED_EVENT } from "../palette/actions";
import { describeSyncProgress, describeSyncResult, describeSyncStatus, useSyncStatus } from "../sync-status";
import { useConfirm } from "./Confirm";
import { ExportLibrary } from "./Library";
import { countOf, InlineError, Loading } from "./shared";
import styles from "./settings.module.css";

function providerName(id: string): string {
  const names: Readonly<Record<string, string>> = {
    openai: "OpenAI",
    anthropic: "Anthropic",
    gemini: "Google Gemini",
    mistral: "Mistral",
    xai: "xAI",
    deepseek: "DeepSeek",
    "openai-compatible": "OpenAI-compatible",
  };
  return names[id] ?? id;
}

/** Stands in for a saved secret, which the interface never receives. */
const SAVED_SECRET = "•••••••••••••••• Saved — leave blank to keep";

function credentialLabel(credential: "saved" | "environment" | "missing" | undefined): string {
  if (credential === "saved") return "saved in protected config";
  if (credential === "environment") return "provided by environment";
  return "not configured";
}

export function SettingsPage({ capabilities, onLibraryReplaced, onConfigLocationChanged }: {
  readonly capabilities?: SystemCapabilities;
  readonly onLibraryReplaced: () => void;
  readonly onConfigLocationChanged: () => void;
}) {
  const host = useHost();
  const desktop = host.kind === "desktop";
  const [aiDirty, setAiDirty] = useState(false);
  const [remoteDirty, setRemoteDirty] = useState(false);
  const dirty = aiDirty || remoteDirty;
  useEffect(() => {
    if (!dirty) return;
    const message = "Leave Settings? Your unsaved changes will be discarded.";
    const clearBlocker = setNavigationBlocker(() => window.confirm(message));
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      clearBlocker();
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [dirty]);
  // The palette asks for a control by name; bring it into view and focus it.
  const cancelFocus = useRef<() => void>(undefined);
  settingRequests.useReceiver((request) => {
    cancelFocus.current?.();
    cancelFocus.current = focusSetting(request);
  });
  return (
    <div className={styles.page}>
      <TitleRow title="Settings" meta={desktop ? "Saved to your config file on this computer. You can also edit it by hand." : "Saved with your library, wherever you sign in."} />
      <div className={styles.layout}>
        <nav className={`ui-panel ${styles.nav}`} aria-label="Settings sections">
          {settingsSections(host).map(({ id, label }) => (
            <button key={id} type="button" className="ui-facet" aria-pressed={false} onClick={() => document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "smooth" })}>
              <span>{label}</span><span />
            </button>
          ))}
        </nav>
        <div className={styles.sections}>
          <AppearancePanel configFile={capabilities?.storagePaths.configFile} />
          {desktop
            ? <div id="settings-sync"><RemoteSection onConfigLocationChanged={onConfigLocationChanged} onDirtyChange={setRemoteDirty} /></div>
            : <AccountPanel />}
          {desktop && <McpPanel />}
          <div id="settings-ai"><AiSection onDirtyChange={setAiDirty} /></div>
          {desktop && (
            <section id="settings-data" className={`ui-panel ${styles.dataPanel}`} aria-labelledby="settings-data-title">
              <div className="ui-panel-head"><h2 id="settings-data-title" className="ui-label">Backups and your data</h2></div>
              <div className={styles.grid}>
                <BackupPanel onLibraryReplaced={onLibraryReplaced} />
                <section className={styles.panel}><Download size={20} aria-hidden="true" /><div {...settingAnchor("export")}><h2>Your data</h2><ExportLibrary /></div></section>
                {capabilities && <UpdatesPanel currentVersion={capabilities.appVersion} />}
              </div>
              {capabilities && (
                <details className={`ll-disclosure ${styles.storage}`} {...settingAnchor("storage-locations")}>
                  <summary>Storage locations</summary>
                  <dl>
                    <div><dt>Config</dt><dd><code>{capabilities.storagePaths.configFile}</code></dd></div>
                    <div><dt>Library</dt><dd><code>{capabilities.storagePaths.libraryFile}</code></dd></div>
                    <div><dt>Cache</dt><dd><code>{capabilities.storagePaths.cacheDirectory}</code></dd></div>
                    <div><dt>State</dt><dd><code>{capabilities.storagePaths.stateDirectory}</code></dd></div>
                  </dl>
                </details>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

/** The web app's signed-in account, and the way out of it. */
function AccountPanel() {
  const host = useHost();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const account = host.kind === "web" ? host.account : undefined;
  const deployment = host.kind === "web" && host.deployment ? new URL(host.deployment).host : undefined;
  const session = window.leaflogue.session;
  return (
    <section id="settings-account" className={`ui-panel ${styles.account}`} aria-labelledby="settings-account-title">
      <div className="ui-panel-head"><h2 id="settings-account-title" className="ui-label"><UserRound size={13} aria-hidden="true" /> Account</h2></div>
      <div className={styles.row}>
        <div>
          <span>{account ? `Signed in as ${account}.` : "Signed in."}</span>
          {deployment && <span className="ui-sub">Your library is on {deployment}.</span>}
        </div>
        <div className={styles.inline}>
          <button type="button" {...settingAnchor("sign-out")} className="ll-button-secondary" disabled={pending || !session} onClick={async () => {
            setPending(true); setMessage("");
            try { await session?.signOut(); }
            catch { setMessage("Leaflogue could not sign you out. Try again."); setPending(false); }
          }}><LogOut size={15} aria-hidden="true" />{pending ? "Signing out…" : "Sign out"}</button>
          {session?.changeDeployment && (
            <button type="button" {...settingAnchor("change-deployment")} className="ll-button-secondary" disabled={pending} onClick={async () => {
              setPending(true); setMessage("");
              try { await session.changeDeployment?.(); }
              catch { setMessage("Leaflogue could not sign you out. Try again."); setPending(false); }
            }}>Use a different deployment</button>
          )}
        </div>
      </div>
      {message && <div className={styles.row}><p className="ll-inline-error" role="alert">{message}</p></div>}
    </section>
  );
}

const BUILT_IN_IDS: ReadonlySet<string> = new Set(BUILT_IN_THEMES.map(({ id }) => id));

/** A theme as two small swatches, dark beside light, drawn in its own colours. */
function ThemeSwatch({ theme }: { readonly theme: ThemeDefinition }) {
  return (
    <span className={styles.swatch} aria-hidden="true">
      {(["dark", "light"] as const).map((mode) => (
        <span key={mode} style={{ background: theme[mode].paper }}>
          <i style={{ background: theme[mode].ink, width: "58%" }} />
          <i style={{ background: theme[mode].chart ?? theme[mode].pen, width: "38%" }} />
          <i style={{ background: theme[mode].highlighter, width: "24%" }} />
          <b style={{ background: theme[mode].ruled, borderColor: theme[mode].controlBorder }} />
        </span>
      ))}
    </span>
  );
}

/** The appearance problem split into the reasons the theme folder's files were skipped, and anything else. */
function splitProblems(problem: string | undefined): { readonly skipped: readonly string[]; readonly other: readonly string[] } {
  const parts = problem ? problem.split("; ") : [];
  return {
    skipped: parts.filter((part) => part.startsWith("Skipped ") || part.startsWith("Only the first ")),
    other: parts.filter((part) => !part.startsWith("Skipped ") && !part.startsWith("Only the first ")),
  };
}

function AppearancePanel({ configFile }: { readonly configFile?: string }) {
  const desktop = useDesktop();
  const [appearance, setAppearance] = useState<AppearanceConfiguration | null>();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    window.leaflogue.appearance.describe().then((result) => {
      if (!active) return;
      setAppearance(result);
      setMessage(result.problem ?? "");
    }, () => {
      if (!active) return;
      setAppearance(null);
      setMessage("Leaflogue could not read the appearance configuration. The current safe theme was kept.");
    });
    const stop = window.leaflogue.appearance.onChanged((result) => {
      setAppearance(result);
      setMessage(result.problem ?? "Appearance reloaded from the protected configuration.");
    });
    // A theme or mode chosen from the palette while Settings is open.
    const saved = (event: Event) => setAppearance((event as CustomEvent<AppearanceConfiguration>).detail);
    window.addEventListener(APPEARANCE_SAVED_EVENT, saved);
    return () => { active = false; stop(); window.removeEventListener(APPEARANCE_SAVED_EVENT, saved); };
  }, []);

  async function save(themeId: string, mode: AppearanceMode) {
    setPending(true);
    setMessage("");
    try {
      const result = await window.leaflogue.appearance.save({ themeId, mode });
      setAppearance(result);
      activateAppearance(result);
      setMessage(desktop ? "Appearance saved to the protected configuration file." : "Appearance saved.");
    } catch {
      setMessage("Leaflogue could not save that appearance. The current theme was kept.");
    } finally {
      setPending(false);
    }
  }

  async function transfer(action: "import" | "export") {
    if (!appearance) return;
    setPending(true);
    setMessage("");
    try {
      if (action === "export") {
        const receipt = await window.leaflogue.appearance.exportTheme(appearance.themeId);
        if (receipt) setMessage(`Exported ${receipt.themeName} to ${receipt.fileName}.`);
      } else {
        const result = await window.leaflogue.appearance.importTheme();
        if (result) {
          setAppearance(result);
          activateAppearance(result);
          const name = result.themes.find(({ id }) => id === result.themeId)?.name ?? "the theme";
          setMessage(result.problem ?? `Imported ${name} and made it your theme.`);
        }
      }
    } catch {
      setMessage(action === "export"
        ? "Leaflogue could not export that theme. No file was written."
        : "That theme could not be imported. It must be a complete Leaflogue theme with readable contrast. Your current theme was kept.");
    } finally {
      setPending(false);
    }
  }

  const problems = splitProblems(appearance?.problem);
  const themesFolder = configFile ? configFile.replace(/[^/\\]+$/u, "themes") : "the themes folder beside your config file";
  const fromFolder = appearance?.themes.filter(({ id }) => !BUILT_IN_IDS.has(id)).length ?? 0;
  async function openFolder() {
    try {
      await window.leaflogue.appearance.openThemesFolder();
    } catch {
      setMessage("Leaflogue could not open the themes folder.");
    }
  }
  return (
    <section id="settings-appearance" className={`ui-panel ${styles.appearance}`} aria-labelledby="settings-appearance-title">
      <div className="ui-panel-head">
        <h2 id="settings-appearance-title" className="ui-label"><Palette size={13} aria-hidden="true" /> Appearance</h2>
      </div>
      {appearance === undefined ? (
        <div className={styles.row}><Loading>Reading appearance…</Loading></div>
      ) : appearance === null ? (
        <div className={styles.row}><p role="alert" className="ll-inline-error">{message}</p></div>
      ) : (
        <>
          <div className={styles.row}>
            <div><label htmlFor="settings-mode">Mode</label></div>
            <Select id="settings-mode" {...settingAnchor("appearance-mode")} className="ll-field" aria-label="Appearance mode" value={appearance.mode} disabled={pending} onValueChange={(value) => void save(appearance.themeId, value as AppearanceMode)}>
              <SelectItem value="system">Follow this device</SelectItem>
              <SelectItem value="light">Light</SelectItem>
              <SelectItem value="dark">Dark</SelectItem>
            </Select>
          </div>
          {desktop && (
          <div className={styles.row}>
            <div>
              <span>Themes folder</span>
              <span className="ui-sub">Put a theme&apos;s .json file here and it appears below straight away.</span>
            </div>
            <div className={styles.inline}>
              <code className={styles.path}>{themesFolder}</code>
              <button type="button" {...settingAnchor("themes-folder")} className="ll-button-secondary" onClick={() => void openFolder()}><FolderOpen size={15} aria-hidden="true" />Open folder</button>
            </div>
          </div>
          )}
          <fieldset className={styles.themes} disabled={pending} {...settingAnchor("theme")}>
            <legend className="ui-label">Theme <span className={styles.legendNote}>{desktop ? `${countOf(appearance.themes.length, "theme")} · ${BUILT_IN_IDS.size} built in, ${fromFolder} from your folder · watching for changes` : countOf(appearance.themes.length, "theme")}</span></legend>
            <div className={styles.themeGrid}>
              {appearance.themes.map((theme) => {
                const current = theme.id === appearance.themeId;
                return (
                  <label key={theme.id} className={styles.themeCard} data-current={current ? "" : undefined}>
                    <input type="radio" name="Theme" aria-label={theme.name} value={theme.id} checked={current} onChange={() => void save(theme.id, appearance.mode)} />
                    <ThemeSwatch theme={theme} />
                    <span className={styles.themeName}>
                      <strong>{theme.name}</strong>
                      {current && <span className="ui-chip" data-tone="accent">In use</span>}
                    </span>
                    <span className="ui-sub">{BUILT_IN_IDS.has(theme.id) ? "Built in" : "From your folder"}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          {problems.skipped.length > 0 && (
            <div className={styles.skipped} role="alert">
              <span className="ui-chip" data-tone="mark">Skipped</span>
              <ul>{problems.skipped.map((line) => <li key={line}>{line.replace(/^Skipped /u, "")}</li>)}</ul>
              <p className="ui-sub">Theme files must be private to you (<code>chmod 600</code>), under 32 KB, not a link, and readable in both light and dark.</p>
            </div>
          )}
          {desktop && <div className={styles.row}>
            <div>
              <span>Share a theme</span>
              <span className="ui-sub">Save the theme in use as a file, or bring one in from another computer.</span>
            </div>
            <div className={styles.inline}>
              <button type="button" {...settingAnchor("theme-import")} className="ll-button-secondary" disabled={pending} onClick={() => void transfer("import")}><Upload size={15} aria-hidden="true" />Import theme</button>
              <button type="button" {...settingAnchor("theme-export")} className="ll-button-secondary" disabled={pending} onClick={() => void transfer("export")}><Download size={15} aria-hidden="true" />Export theme</button>
            </div>
          </div>}
        </>
      )}
      {appearance && problems.other.length > 0 && (
        <div className={styles.row}><p className="ll-inline-error" role="alert">{problems.other.join(" ")}</p></div>
      )}
      {appearance && message && message !== appearance.problem && (
        <div className={styles.row}><p className={styles.status} role="status">{message}</p></div>
      )}
    </section>
  );
}

function BackupPanel({ onLibraryReplaced }: { readonly onLibraryReplaced: () => void }) {
  const [confirm, confirmDialog] = useConfirm();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  return (
    <section className={styles.panel}>
      <ArchiveRestore size={20} aria-hidden="true" />
      <div>
        <h2>Backups</h2>
                <div className={styles.buttons}>
          <button {...settingAnchor("backup-create")} className="ll-button-secondary" disabled={pending} onClick={async () => {
            setPending(true); setMessage(""); setError("");
            try {
              const result = await window.leaflogue.backups.create();
              if (result) setMessage(`Backup saved as ${result.fileName}.`);
            } catch { setError("Leaflogue could not create that backup."); }
            finally { setPending(false); }
          }}><Save size={16} aria-hidden="true" />Create backup</button>
          <button {...settingAnchor("backup-restore")} className="ll-button-secondary" disabled={pending} onClick={async () => {
            if (!await confirm({ title: "Restore this backup?", message: "This replaces your local library with the selected backup. Leaflogue validates it first and keeps the current library if validation fails.", confirmLabel: "Choose backup", destructive: true })) return;
            setPending(true); setMessage(""); setError("");
            try {
              const result = await window.leaflogue.backups.restore();
              if (result) {
                setMessage(`Restored ${countOf(result.booksRestored, "book")} from ${result.fileName}.`);
                onLibraryReplaced();
              }
            } catch { setError("That backup could not be restored. Your current library was kept."); }
            finally { setPending(false); }
          }}><ArchiveRestore size={16} aria-hidden="true" />Restore backup</button>
        </div>
        <p role="status" className={styles.status}>{message}</p>
        <InlineError>{error}</InlineError>
        {confirmDialog}
      </div>
    </section>
  );
}

const RELEASES_URL = "https://github.com/Ka1Thakkar/leaflogue/releases";

function updateMessage(status: UpdateStatus): string {
  switch (status.state) {
    case "up-to-date": return `Leaflogue ${status.currentVersion} is the latest version.`;
    case "available": return `Leaflogue ${status.version} is available.`;
    case "failed": return status.problem === "network"
      ? "Leaflogue could not reach GitHub to check for updates. Try again later."
      : "An update was found, but it did not pass Leaflogue's signature check, so it was not used.";
    case "unavailable":
      if (status.reason === "flatpak") return "Your software centre keeps Leaflogue up to date.";
      if (status.reason === "not-appimage") return "This copy cannot update itself. Download new versions from the releases page.";
      if (status.reason === "unsupported-installation") return "For in-app updates, move Leaflogue to Applications on Mac or use the Windows installer. Portable archives use manual updates.";
      if (status.reason === "development") return "Updates are turned off in development builds.";
      return "This build cannot check for updates.";
  }
}

/** Manual, signed updates (ADR 0007): nothing is checked or downloaded until the reader asks. */
function UpdatesPanel({ currentVersion }: { readonly currentVersion: string }) {
  const [confirm, confirmDialog] = useConfirm();
  const [status, setStatus] = useState<UpdateStatus>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [automatic, setAutomatic] = useState<boolean>();
  useEffect(() => {
    let active = true;
    window.leaflogue.updates.describe().then((settings) => {
      if (!active) return;
      setAutomatic(settings.automaticCheck);
      if (settings.availableVersion) {
        setStatus({ state: "available", currentVersion, version: settings.availableVersion, releasedAt: "", notesUrl: `${RELEASES_URL}/tag/v${settings.availableVersion}` });
      }
    }, () => undefined);
    return () => { active = false; };
  }, [currentVersion]);
  return (
    <section className={styles.panel}>
      <RefreshCw size={20} aria-hidden="true" />
      <div>
        <h2>Updates</h2>
        <p className={styles.status}>Version {currentVersion}</p>
        {automatic !== undefined && (
          <label className={styles.checkRow}>
            <input type="checkbox" {...settingAnchor("updates-automatic")} checked={automatic} onChange={async (event) => {
              const enabled = event.target.checked;
              setError("");
              try { setAutomatic((await window.leaflogue.updates.setAutomaticCheck(enabled)).automaticCheck); }
              catch { setError("Leaflogue could not save that setting."); }
            }} />
            Check for updates automatically once a day
          </label>
        )}
        <div className={styles.buttons}>
          <button {...settingAnchor("updates-check")} className="ll-button-secondary" disabled={pending} onClick={async () => {
            setPending(true); setError("");
            try { setStatus(await window.leaflogue.updates.check()); }
            catch { setError("Leaflogue could not check for updates."); }
            finally { setPending(false); }
          }}><RefreshCw size={16} aria-hidden="true" />Check for updates</button>
          {status?.state === "available" && (
            <button className="ll-button-secondary" disabled={pending} onClick={async () => {
              if (!await confirm({
                title: `Install Leaflogue ${status.version}?`,
                message: "Leaflogue downloads the update, checks that it was signed by Leaflogue, and restarts. Your library stays in its data folder. A newer version may upgrade its format; back up first.",
                confirmLabel: "Install and restart",
              })) return;
              setPending(true); setError("");
              try { await window.leaflogue.updates.install(); }
              catch { setError("The update could not be installed. Your current version is unchanged."); setPending(false); }
            }}><Download size={16} aria-hidden="true" />Install and restart</button>
          )}
          {(status?.state === "available" || (status?.state === "unavailable" && status.reason === "not-appimage")) && (
            <button className="ll-button-secondary" onClick={() => {
              void window.leaflogue.system.openExternal(status.state === "available" ? status.notesUrl : RELEASES_URL).catch(() => undefined);
            }}>{status.state === "available" ? "What's new" : "Open releases"}</button>
          )}
        </div>
        <p role="status" className={styles.status}>{pending && status?.state === "available" ? "Downloading and checking the update…" : status ? updateMessage(status) : ""}</p>
        <InlineError>{error}</InlineError>
        {confirmDialog}
      </div>
    </section>
  );
}

function AiSection({ onDirtyChange }: { readonly onDirtyChange: (dirty: boolean) => void }) {
  // On the web, provider keys live in the server's environment, never in a browser.
  const desktop = useDesktop();
  const [confirm, confirmDialog] = useConfirm();
  const [config, setConfig] = useState<AiConfigurationSummary>();
  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [clearSavedKey, setClearSavedKey] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const apply = useCallback((result: AiConfigurationSummary) => {
    const providerId = result.selectedProvider ?? result.providers[0]?.id ?? "";
    setConfig(result);
    setEnabled(result.enabled);
    setProvider(providerId);
    setModel(result.providers.find(({ id }) => id === providerId)?.selectedModel ?? "");
  }, []);
  useEffect(() => {
    void window.leaflogue.ai.describe().then(apply, () => {
      setConfig({ enabled: false, providers: [] });
      setMessage("Leaflogue could not read the AI provider catalog.");
    });
  }, [apply]);
  const selected = config?.providers.find(({ id }) => id === provider);
  useEffect(() => {
    const configuredProvider = config?.selectedProvider ?? config?.providers[0]?.id ?? "";
    const configuredModel = config?.providers.find(({ id }) => id === provider)?.selectedModel ?? "";
    onDirtyChange(Boolean(apiKey || clearSavedKey || (config && (
      enabled !== config.enabled || provider !== configuredProvider || model !== configuredModel
    ))));
    return () => onDirtyChange(false);
  }, [apiKey, clearSavedKey, config, enabled, model, onDirtyChange, provider]);
  return (
    <details className={styles.section}>
      <summary className={styles.sectionHeading}>
        <Sparkles size={20} aria-hidden="true" />
        <div><h2 id="ai-settings-title">Optional AI</h2></div>
      </summary>
      <div className={styles.sectionBody} aria-labelledby="ai-settings-title">
      {config === undefined ? (
        <Loading>Reading configuration…</Loading>
      ) : config.providers.length === 0 ? (
        <p className="ll-muted">{desktop
          ? "No provider catalog is configured. Add validated providers and visible models to the protected config file before enabling AI."
          : "This server has no AI provider set up. Whoever runs it can add a provider key to its environment."}</p>
      ) : (
        <form className={styles.form} onSubmit={async (event) => {
          event.preventDefault();
          if (!selected) return;
          if (enabled && provider === "gemini" && !await confirm({
            title: "Use Gemini?",
            message: "Google may use free-tier Gemini prompts and responses to improve its products, and free-tier requests are rate limited.",
            confirmLabel: "Continue with Gemini",
          })) return;
          setPending(true); setMessage("");
          try {
            const result = await window.leaflogue.ai.save({
              enabled,
              selectedProvider: provider,
              selectedModel: model,
              ...(apiKey.trim() ? { apiKey } : {}),
              ...(clearSavedKey ? { clearSavedApiKey: true } : {}),
            });
            setConfig(result);
            window.dispatchEvent(new Event("leaflogue:ai-saved"));
            setApiKey("");
            setClearSavedKey(false);
            setMessage(desktop ? "AI preferences saved. The API key was not returned to the interface." : "AI preferences saved.");
          } catch {
            setMessage("Leaflogue could not save those AI settings. Check the provider catalog and key.");
          } finally { setPending(false); }
        }}>
          <label className={styles.switchRow}>
            <span><strong>Enable AI features</strong><small>Adds one action: explaining a passage you choose. Nothing is sent until you ask for it.</small></span>
            <input type="checkbox" role="switch" {...settingAnchor("ai-enabled")} aria-label="Enable AI features" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          </label>
          <div className={styles.fields}>
            <label className="ll-label">Provider<Select className="ll-field" {...settingAnchor("ai-provider")} aria-label="AI provider" value={provider} onValueChange={(value) => {
              const next = config.providers.find(({ id }) => id === value);
              setProvider(value);
              setModel(next?.selectedModel ?? "");
              setApiKey("");
              setClearSavedKey(false);
            }}>{config.providers.map((item) => <SelectItem value={item.id} key={item.id}>{providerName(item.id)}</SelectItem>)}</Select></label>
            <label className="ll-label">Model<Select className="ll-field" {...settingAnchor("ai-model")} aria-label="AI model" value={model} onValueChange={(value) => setModel(value)}>{selected?.models.map((item) => <SelectItem value={item} key={item}>{item}</SelectItem>)}</Select></label>
            {desktop && <label className="ll-label">API key <span className="ll-muted">({credentialLabel(selected?.credential)})</span><input className="ll-field" {...settingAnchor("ai-key")} aria-label="AI API key" type="password" value={apiKey} autoComplete="off" spellCheck={false} placeholder={selected?.credential === "missing" ? "Paste a key" : selected?.credential === "saved" ? SAVED_SECRET : "Replace with your own key"} onChange={(event) => { setApiKey(event.target.value); setClearSavedKey(false); }} /></label>}
          </div>
          <div className={styles.formActions}>
            {desktop && selected?.credential === "saved" && <label className={styles.checkRow}><input type="checkbox" checked={clearSavedKey} disabled={Boolean(apiKey)} onChange={(event) => setClearSavedKey(event.target.checked)} />Remove saved key</label>}
            <button className="ll-button-secondary" disabled={pending || !provider || !model || (clearSavedKey && Boolean(apiKey))}>Save AI settings</button>
          </div>
        </form>
      )}
      {message && <p className={styles.status} role="status">{message}</p>}
      {confirmDialog}
      </div>
    </details>
  );
}

function RemoteSection({ onConfigLocationChanged, onDirtyChange }: {
  readonly onConfigLocationChanged: () => void;
  readonly onDirtyChange: (dirty: boolean) => void;
}) {
  const [confirm, confirmDialog] = useConfirm();
  const [config, setConfig] = useState<RemoteConfigurationSummary>();
  const [status, setStatus] = useState<RemoteDatabaseStatus>();
  const [pending, setPending] = useState(false);
  const [provider, setProvider] = useState<"postgres" | "convex">("postgres");
  const [value, setValue] = useState("");
  const [location, setLocation] = useState<"default" | "choose">("default");
  const [message, setMessage] = useState("");
  const [syncKey, setSyncKey] = useState("");
  const syncStatus = useSyncStatus();
  const syncing = syncStatus?.state === "syncing";
  const progress = syncStatus?.progress ? describeSyncProgress(syncStatus.progress) : undefined;
  useEffect(() => {
    void window.leaflogue.remote.describe().then((result) => {
      setConfig(result);
      if (result.provider) setProvider(result.provider);
    }, () => setConfig({ configured: false, problem: "Leaflogue could not read its remote configuration." }));
  }, []);
  const savedProviderSelected = config?.configured === true && config.provider === provider && value.trim() === "";
  useEffect(() => {
    onDirtyChange(Boolean(value.trim()) || Boolean(syncKey.trim()) || Boolean(config?.configured && config.provider !== provider));
    return () => onDirtyChange(false);
  }, [config, onDirtyChange, provider, syncKey, value]);
  const convexSaved = savedProviderSelected && provider === "convex";
  const keyNeeded = provider === "convex" && !(config?.provider === "convex" && config.syncKeySaved);
  const failed = (problem: string): RemoteDatabaseStatus => ({ ...config, configured: config?.configured ?? false, reachable: false, initialized: false, problem });
  return (
    <details className={styles.section}>
      <summary className={styles.sectionHeading}>
        <Network size={20} aria-hidden="true" />
        <div><h2 id="remote-library-title">Remote library</h2>{config?.configured && <p className="ll-muted">{config.provider === "convex" ? "Convex" : "PostgreSQL"} · {config.host}</p>}{syncing && <p className="ll-muted">{progress ? `${progress.phase} ${progress.counts}` : "Syncing…"}</p>}</div>
      </summary>
      <div className={styles.sectionBody} aria-labelledby="remote-library-title">
      {config?.configured && syncStatus && <section className={styles.syncProgress} aria-label="Synchronization status">
        <strong>{syncing ? progress?.phase ?? "Syncing…" : describeSyncStatus(syncStatus).label}</strong>
        {syncing && <progress aria-label="Sync progress" />}
        <p role="status">{syncing ? progress?.counts ?? "Waiting for the sync provider…" : describeSyncStatus(syncStatus).detail}</p>
        {syncing && <small className="ll-muted">The remote total is not known yet; received changes update as each batch finishes.</small>}
      </section>}
      {config === undefined ? (
        <Loading>Reading configuration…</Loading>
      ) : config.configured ? (
        <dl className={styles.record}>
          <div><dt>Server</dt><dd>{config.host}</dd></div>
          <div><dt>{config.provider === "convex" ? "Deployment" : "Database"}</dt><dd>{config.provider === "convex" ? config.deployment : config.database || "Default database"}</dd></div>
          <div><dt>Loaded from</dt><dd>{config.source === "environment" ? "Environment" : "Protected config file"}</dd></div>
          <div><dt>Transport</dt><dd>{config.transport === "tls" ? "TLS requested" : "Database URL setting"}</dd></div>
        </dl>
      ) : (
        null
      )}
      <form className={styles.form} onSubmit={async (event) => {
        event.preventDefault();
        setPending(true); setStatus(undefined); setMessage("");
        try {
          const result = await window.leaflogue.remote.save(provider === "postgres"
            ? { provider: "postgres", databaseUrl: value, location }
            : { provider: "convex", deploymentUrl: value, location,
                ...(syncKey.trim() ? { syncKey } : {}) });
          if (result) {
            setConfig(result);
            onConfigLocationChanged();
            setValue("");
            setSyncKey("");
            setMessage(result.previousConfigRetained
              ? "Connection and shared settings saved at the new location. The previous protected config file remains in place for recovery; remove it manually when it is no longer needed."
              : "Connection saved. Credentials are never returned to the interface.");
          }
        } catch { setMessage("Leaflogue could not save that connection. Check the URL and chosen location."); }
        finally { setPending(false); }
      }}>
        <div className={styles.fields}>
          <label className="ll-label">Database provider<Select className="ll-field" {...settingAnchor("sync-provider")} value={provider} onValueChange={(value) => { setProvider(value as "postgres" | "convex"); setValue(""); setStatus(undefined); }}><SelectItem value="postgres">PostgreSQL</SelectItem><SelectItem value="convex">Convex</SelectItem></Select></label>
          <label className={`ll-label ${styles.wide}`}>{provider === "postgres" ? "PostgreSQL connection URL" : "Convex deployment URL"}<input className="ll-field" {...settingAnchor("sync-url")} type={provider === "postgres" ? "password" : "url"} value={value} required={!savedProviderSelected} autoComplete="off" spellCheck={false} placeholder={savedProviderSelected ? SAVED_SECRET : provider === "postgres" ? "postgresql://…" : "https://…convex.cloud"} onChange={(event) => setValue(event.target.value)} /></label>
          {provider === "convex" && (
            <label className={`ll-label ${styles.wide}`}>Sync key<input className="ll-field" {...settingAnchor("sync-key")} type="password" value={syncKey} required={keyNeeded} minLength={32} autoComplete="off" spellCheck={false} placeholder={keyNeeded ? "The value of LEAFLOGUE_SYNC_KEY" : SAVED_SECRET} onChange={(event) => setSyncKey(event.target.value)} /></label>
          )}
        </div>
        <fieldset className={styles.choices} {...settingAnchor("sync-location")}>
          <legend className="ll-label">Save configuration</legend>
          <label className={styles.checkRow}><input type="radio" name="config-location" checked={location === "default"} onChange={() => setLocation("default")} />Leaflogue configuration directory</label>
          <label className={styles.checkRow}><input type="radio" name="config-location" checked={location === "choose"} onChange={() => setLocation("choose")} />Choose another file</label>
        </fieldset>
        <div className={styles.formActions}><button className="ll-button-secondary" disabled={pending || !(value.trim() || (convexSaved && syncKey.trim()))}>Save connection</button></div>
      </form>
      {message && <p className={styles.status} role="status">{message}</p>}
      {provider === "convex" && (
        <div className={styles.workflow}>
          <h3>Convex setup</h3>
          <ol>
            <li>Download and verify the Convex backend bundle attached to the GitHub release that matches this desktop.</li>
            <li>Extract it and run <code>./leaflogue-convex-VERSION/deploy.sh</code> (add <code>--production</code> for production).</li>
            <li>Create the sync key once with <code>npx convex env set LEAFLOGUE_SYNC_KEY "$(openssl rand -base64 32)"</code>. Add <code>--prod</code> to the environment commands for production.</li>
            <li>Paste the deployment URL and that key above, save, and choose <strong>Check connection</strong>, then <strong>Sync now</strong>. Use the same URL and key on every desktop.</li>
          </ol>
          <p className="ll-muted">The key lets a desktop sync this library and run Leaflogue's bounded compatibility steps. Deploying code, arbitrary functions, and environment changes stay with the Convex CLI. To cut off a lost device, set a new key and enter it on the desktops you keep.</p>
        </div>
      )}
      {(config?.problem || status?.problem) && <p className="ll-inline-error" role="alert">{status?.problem ?? config?.problem}</p>}
      {status?.reachable && !status.problem && (
        <p className={styles.status} role="status">
          {status.initialized ? `Connected. Leaflogue schema ${status.schemaVersion} is ready.` : "Connected. This database has not been initialized for Leaflogue."}
        </p>
      )}
      <div className={styles.formActions}>
        <button {...settingAnchor("sync-check")} className="ll-button-secondary" disabled={pending || !savedProviderSelected} onClick={async () => {
          setPending(true); setStatus(undefined);
          try { setStatus(await window.leaflogue.remote.check()); }
          catch { setStatus(failed("Leaflogue could not check the remote database.")); }
          finally { setPending(false); }
        }}>Check connection</button>
        {provider === "postgres" && (
          <button className="ll-button" disabled={pending || !savedProviderSelected} onClick={async () => {
            if (!await confirm({ title: "Initialize schema?", message: "This creates versioned tables inside the leaflogue schema of this PostgreSQL database.", confirmLabel: "Initialize schema" })) return;
            setPending(true); setStatus(undefined);
            try { setStatus(await window.leaflogue.remote.initialize()); }
            catch { setStatus(failed("Leaflogue could not initialize the remote database.")); }
            finally { setPending(false); }
          }}>Initialize schema</button>
        )}
        {(provider === "postgres" || (convexSaved && config?.syncKeySaved)) && (
          <button {...settingAnchor("sync-now")} className="ll-button" disabled={pending || syncing || !savedProviderSelected} onClick={async () => {
            setPending(true); setStatus(undefined); setMessage("");
            try {
              let result = await window.leaflogue.sync.run();
              if (result.status === "migration-review-required") {
                const reason = result.migration.reviewReason === "oversized"
                  ? "This legacy attached note is larger than Leaflogue's current sync limit."
                  : "This passage has more attached notes than Leaflogue can safely sync.";
                if (await confirm({ title: "Keep as a standalone note?", message: `${reason} Keep its complete text as a standalone note and continue?`, confirmLabel: "Keep and continue" })) {
                  result = await window.leaflogue.sync.run({ confirmDetachNoteId: result.migration.reviewNoteId });
                }
              }
              setMessage(describeSyncResult(result));
            } catch { setMessage("Leaflogue could not start synchronization."); }
            finally { setPending(false); }
          }}>{syncing ? "Syncing…" : "Sync now"}</button>
        )}
      </div>
      {confirmDialog}
      </div>
    </details>
  );
}



function McpPanel() {
  const [configuration, setConfiguration] = useState<McpConfiguration>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const supported = !!window.leaflogue.system.describeMcp && !!window.leaflogue.system.configureMcp;
  useEffect(() => {
    if (!supported) return;
    let active = true;
    void window.leaflogue.system.describeMcp!().then(value => { if (active) setConfiguration(value); }, () => { if (active) setError("Could not read MCP settings."); });
    return () => { active = false; };
  }, [supported]);
  if (!supported) return null;
  return <details id="settings-mcp" className={styles.section}>
    <summary className={styles.sectionHeading}><Network size={18} aria-hidden="true" /><span>Local MCP · Agent access</span></summary>
    <div className={styles.sectionBody}>
      <h2>Connect an agent to your reading</h2>
      <p>Allow local MCP clients to search your passages and read books, notes, and threads. Access is read-only and off by default.</p>
      <p>A cloud-based agent may send returned passages and notes to its provider. Enable this only for clients you trust. Disabling blocks further reads, but cannot retract information already returned.</p>
      <label><input type="checkbox" role="switch" {...settingAnchor("mcp-enabled")} aria-label="Enable local MCP access" checked={configuration?.enabled ?? false} disabled={pending || !configuration} onChange={event => {
        const enabled = event.target.checked;
        const previous = configuration;
        setConfiguration(current => current ? { ...current, enabled } : current);
        setPending(true); setError("");
        void window.leaflogue.system.configureMcp!(enabled).then(setConfiguration, () => { setConfiguration(previous); setError("Could not save MCP settings."); }).finally(() => setPending(false));
      }} /> Enable local MCP access</label>
      {configuration && <>
        <p role="status">{pending ? "Saving MCP access…" : configuration.enabled ? "Read-only agent access is enabled." : "Agent access is disabled."}</p>
        <label>Client configuration<textarea aria-label="MCP client configuration" readOnly rows={10} value={configuration.clientConfiguration} style={{ width: "100%", fontFamily: "var(--font-mono)", fontSize: 12 }} /></label>
        <p>Copy this entry into your client's MCP settings, then restart or reconnect the client. It launches this installation using stdio; no network listener or separate server is required.</p>
      </>}
      <InlineError>{error}</InlineError>
    </div>
  </details>;
}
