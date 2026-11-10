import type { SystemHost } from "@leaflogue/contracts";
import { href, navigate, parseRoute } from "../router";
import { createChannel } from "./intents";

/**
 * Every control on the Settings page, in page order. The page marks each
 * control with `settingAnchor(id)`, which only accepts these ids, and the
 * palette lists them from here, so the two cannot drift apart.
 */
export const SETTINGS_SECTIONS = [
  { id: "settings-appearance", label: "Appearance" },
  { id: "settings-sync", label: "Sync", host: "desktop" },
  { id: "settings-account", label: "Account", host: "web" },
  { id: "settings-mcp", label: "Agent access", host: "desktop" },
  { id: "settings-ai", label: "Optional AI" },
  { id: "settings-data", label: "Backups and your data", host: "desktop" },
] as const satisfies readonly { readonly id: string; readonly label: string; readonly host?: SystemHost["kind"] }[];

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

interface SettingDefinition {
  readonly id: string;
  readonly label: string;
  readonly section: SettingsSectionId;
  readonly keywords?: string;
  /** Shown only in some states (say, once a provider is chosen); the jump falls back to its section. */
  readonly conditional?: boolean;
  /** Only the desktop app, or only the web app, has it. Absent: both do. */
  readonly host?: SystemHost["kind"];
}

export const SETTINGS = [
  { id: "appearance-mode", label: "Light or dark mode", section: "settings-appearance", keywords: "appearance mode light dark system follow device night" },
  { id: "theme", label: "Theme", section: "settings-appearance", keywords: "colours colors palette look" },
  { id: "themes-folder", label: "Themes folder", section: "settings-appearance", keywords: "custom theme json open folder", host: "desktop" },
  { id: "theme-import", label: "Import a theme", section: "settings-appearance", keywords: "theme file share", host: "desktop" },
  { id: "theme-export", label: "Export the theme in use", section: "settings-appearance", keywords: "theme file share", host: "desktop" },
  { id: "sync-provider", label: "Sync database", section: "settings-sync", keywords: "remote library provider postgres postgresql convex server", host: "desktop" },
  { id: "sync-url", label: "Sync connection URL", section: "settings-sync", keywords: "remote server address deployment database url", host: "desktop" },
  { id: "sync-key", label: "Convex sync key", section: "settings-sync", keywords: "secret password LEAFLOGUE_SYNC_KEY", conditional: true, host: "desktop" },
  { id: "sync-location", label: "Where sync settings are saved", section: "settings-sync", keywords: "config file location directory", host: "desktop" },
  { id: "sync-check", label: "Check sync connection", section: "settings-sync", keywords: "test remote server", host: "desktop" },
  { id: "sync-now", label: "Sync now", section: "settings-sync", keywords: "synchronise synchronize remote", conditional: true, host: "desktop" },
  { id: "sign-out", label: "Sign out", section: "settings-account", keywords: "account log out leave", host: "web" },
  { id: "change-deployment", label: "Use a different deployment", section: "settings-account", keywords: "account convex server switch", conditional: true, host: "web" },
  { id: "mcp-enabled", label: "Enable local MCP access", section: "settings-mcp", keywords: "agent assistant tools read only citations", conditional: true, host: "desktop" },
  { id: "ai-enabled", label: "Enable AI features", section: "settings-ai", keywords: "ai artificial intelligence explain passage companion", conditional: true },
  { id: "ai-provider", label: "AI provider", section: "settings-ai", keywords: "openai anthropic gemini mistral", conditional: true },
  { id: "ai-model", label: "AI model", section: "settings-ai", conditional: true },
  { id: "ai-key", label: "AI API key", section: "settings-ai", keywords: "secret token credential", conditional: true, host: "desktop" },
  { id: "backup-create", label: "Create a backup", section: "settings-data", keywords: "save copy library", host: "desktop" },
  { id: "backup-restore", label: "Restore a backup", section: "settings-data", keywords: "replace library recover", host: "desktop" },
  { id: "export", label: "Export your library", section: "settings-data", keywords: "markdown json obsidian download", host: "desktop" },
  { id: "updates-check", label: "Check for updates", section: "settings-data", keywords: "version upgrade release new", host: "desktop" },
  { id: "updates-automatic", label: "Check for updates automatically", section: "settings-data", keywords: "daily version upgrade", host: "desktop" },
  { id: "storage-locations", label: "Storage locations", section: "settings-data", keywords: "config library cache state paths files folders", host: "desktop" },
] as const satisfies readonly SettingDefinition[];

export type SettingId = (typeof SETTINGS)[number]["id"];
export type Setting = (typeof SETTINGS)[number];

/** Whether this interface has it: some settings exist only in the desktop app, some only on the web. */
export function onHost(item: { readonly id: string; readonly host?: SystemHost["kind"] }, host: SystemHost): boolean {
  return !item.host || item.host === host.kind;
}

/** The Settings page's sections where it runs. */
export function settingsSections(host: SystemHost): readonly (typeof SETTINGS_SECTIONS)[number][] {
  return SETTINGS_SECTIONS.filter((section) => onHost(section, host));
}

/** Every setting the Settings page shows where it runs. */
export function settingsFor(host: SystemHost): readonly Setting[] {
  return SETTINGS.filter((setting) => onHost(setting, host));
}

export function sectionLabel(section: SettingsSectionId): string {
  return SETTINGS_SECTIONS.find(({ id }) => id === section)!.label;
}

/** Spread onto a Settings control so the palette can find it. */
export function settingAnchor(id: SettingId): { readonly "data-setting": SettingId } {
  return { "data-setting": id };
}

export interface SettingRequest {
  readonly id: SettingId;
  /** Press the control once it is in view, as an action does. */
  readonly activate?: boolean;
}

export const settingRequests = createChannel<SettingRequest>();

/** Open Settings at this control, focus it, and optionally press it. */
export function openSetting(request: SettingRequest): void {
  settingRequests.send(request);
  if (parseRoute(window.location.hash).name !== "settings") navigate(href.settings());
}

const FOCUSABLE = "input:not([type='hidden']):not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), a[href], summary, [tabindex]:not([tabindex='-1'])";
const FLASH_MS = 1_600;
const GIVE_UP_MS = 3_000;

function reveal(element: Element): void {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement && !parent.open) parent.open = true;
  }
}

function flash(element: HTMLElement): void {
  element.setAttribute("data-setting-flash", "");
  setTimeout(() => element.removeAttribute("data-setting-flash"), FLASH_MS);
}

/**
 * Bring a setting into view and focus it. Sections read their configuration
 * as they open, so a control may appear a moment later; until then the
 * section is shown. Returns a cancel function.
 */
export function focusSetting({ id, activate = false }: SettingRequest, root: ParentNode = document): () => void {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = () => {
    const anchor = root.querySelector<HTMLElement>(`[data-setting="${id}"]`);
    if (!anchor) {
      if (Date.now() - started < GIVE_UP_MS) {
        timer = setTimeout(attempt, 50);
        return;
      }
      const setting = SETTINGS.find((candidate) => candidate.id === id);
      const section = setting ? document.getElementById(setting.section) : null;
      if (section) {
        reveal(section);
        section.querySelector("details")?.setAttribute("open", "");
        section.scrollIntoView?.({ block: "start" });
      }
      return;
    }
    reveal(anchor);
    if (anchor instanceof HTMLDetailsElement) anchor.open = true;
    const target = anchor.matches(FOCUSABLE)
      ? anchor
      : anchor.querySelector<HTMLElement>("input:checked") ?? anchor.querySelector<HTMLElement>(FOCUSABLE);
    anchor.scrollIntoView?.({ block: "center" });
    if (target) target.focus({ preventScroll: true });
    if (!target || document.activeElement !== target) {
      // A disabled control cannot take focus; the place it sits can.
      if (!anchor.hasAttribute("tabindex")) anchor.tabIndex = -1;
      anchor.focus({ preventScroll: true });
    }
    // A checkbox or field inside a label is easier to see marked with its label.
    flash(anchor.matches("input, select") ? anchor.closest<HTMLElement>("label") ?? anchor : anchor);
    if (activate && target && document.activeElement === target) target.click();
  };
  // After the page has settled: opening a page scrolls it to the top first.
  timer = setTimeout(attempt, 0);
  return () => clearTimeout(timer);
}
