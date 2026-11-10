import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { _electron, expect, type ElectronApplication, type Page } from "@playwright/test";

const repositoryRoot = resolve(__dirname, "../..");
const mainEntry = join(repositoryRoot, "apps/desktop/out/main/index.js");
const rendererRoot = join(repositoryRoot, "apps/desktop/out/renderer");
const electronExecutable = createRequire(__filename)("electron") as string;

/**
 * One throwaway installation. Every path Leaflogue or Chromium might write to
 * is inside `root`, so a run can neither read nor change a real library.
 */
export interface Profile {
  readonly root: string;
  /** Where test files are generated and where stubbed dialogs point. */
  readonly files: string;
  launches: number;
}

export function createProfile(): Profile {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "leaflogue-e2e-")));
  for (const directory of ["home", "files", "tmp", "xdg-config", "xdg-data", "xdg-cache", "xdg-state"]) {
    mkdirSync(join(root, directory), { recursive: true, mode: 0o700 });
  }
  return { root, files: join(root, "files"), launches: 0 };
}

export function isolatedProfileEnvironment(profile: Profile): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Inherited Electron switches (for example ELECTRON_RUN_AS_NODE from an
    // editor) or a LEAFLOGUE_* override would change what is being tested.
    if (value === undefined || key.startsWith("ELECTRON_") || key.startsWith("LEAFLOGUE_")) continue;
    environment[key] = value;
  }
  Object.assign(environment, {
    HOME: join(profile.root, "home"),
    TMPDIR: join(profile.root, "tmp"),
    XDG_CONFIG_HOME: join(profile.root, "xdg-config"),
    XDG_DATA_HOME: join(profile.root, "xdg-data"),
    XDG_CACHE_HOME: join(profile.root, "xdg-cache"),
    XDG_STATE_HOME: join(profile.root, "xdg-state"),
  });
  return environment;
}

const running = new Set<ElectronApplication>();

/**
 * Close any app a failed step left open, then delete the profile. Assertions
 * belong to `Session.close`; this only guarantees nothing outlives the test.
 */
export async function removeProfile(profile: Profile): Promise<void> {
  for (const app of running) {
    running.delete(app);
    await app.close().catch(() => app.process().kill("SIGKILL"));
  }
  rmSync(profile.root, { recursive: true, force: true });
}

type DialogKind = "open" | "save";
type DialogResponse = { readonly canceled: boolean; readonly filePaths?: readonly string[]; readonly filePath?: string };

export interface Session {
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly profile: Profile;
  /** The live library file the app reports; XDG data on Linux, userData elsewhere. */
  readonly libraryFile: string;
  /** Answer the next native open-file dialog with this path. */
  chooseFile(path: string): Promise<void>;
  /** Cancel the next native open-file dialog, as a reader closing the picker. */
  cancelNextFileDialog(): Promise<void>;
  /** Answer the next native save-file dialog with this path. */
  saveFileAs(path: string): Promise<void>;
  /** Resize the content area as a reader would drag the window edge. */
  resize(width: number, height: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * Launch the built desktop app against `profile`. On Linux the XDG variables
 * select the profile; elsewhere Leaflogue keeps its files in Electron's
 * userData, which `--user-data-dir` redirects. The launch refuses to continue
 * if the app reports any storage path outside the profile.
 */
export async function launch(profile: Profile): Promise<Session> {
  if (!existsSync(mainEntry)) {
    throw new Error("Build the desktop app first: npm run build --workspace @leaflogue/desktop");
  }
  profile.launches += 1;
  const netLog = join(profile.root, `net-log-${profile.launches}.json`);
  const environment = isolatedProfileEnvironment(profile);
  const app = await _electron.launch({
    executablePath: electronExecutable,
    args: [
      mainEntry,
      `--user-data-dir=${join(profile.root, "user-data")}`,
      `--log-net-log=${netLog}`,
      // Hosted Linux runners forbid the unprivileged namespaces Chromium's
      // sandbox needs. Only CI opts out; local runs keep the sandbox.
      ...(process.env.LEAFLOGUE_E2E_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
    ],
    env: environment,
    cwd: profile.root,
  });
  running.add(app);

  // Deny, and remember, every request that is not the app's own renderer.
  // Chromium's net log below covers the moments before this guard exists.
  await app.evaluate(({ session, dialog }, allowedFileRoot) => {
    const state = {
      blocked: [] as string[],
      unexpectedDialogs: [] as string[],
      queue: { open: [] as unknown[], save: [] as unknown[] },
    };
    (globalThis as { __leaflogueE2E?: unknown }).__leaflogueE2E = state;
    const allowed = (url: string) => {
      if (/^(leaflogue|data|blob|devtools):/u.test(url)) return true;
      if (!url.startsWith("file://")) return false;
      return decodeURIComponent(new URL(url).pathname).startsWith(allowedFileRoot);
    };
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      if (allowed(details.url)) return callback({});
      state.blocked.push(details.url);
      callback({ cancel: true });
    });
    const answer = (kind: "open" | "save", title: string | undefined) => {
      const next = state.queue[kind].shift();
      if (next) return next;
      state.unexpectedDialogs.push(`${kind}: ${title ?? "untitled"}`);
      return kind === "open" ? { canceled: true, filePaths: [] } : { canceled: true, filePath: "" };
    };
    const title = (args: unknown[]) => (args.find((arg) => typeof arg === "object" && arg !== null && "title" in arg) as { title?: string } | undefined)?.title;
    Object.assign(dialog, {
      showOpenDialog: async (...args: unknown[]) => answer("open", title(args)),
      showSaveDialog: async (...args: unknown[]) => answer("save", title(args)),
      showMessageBox: async (...args: unknown[]) => {
        state.unexpectedDialogs.push(`message: ${JSON.stringify(args.at(-1))}`);
        return { response: 1, checkboxChecked: false };
      },
      showErrorBox: (heading: string) => { state.unexpectedDialogs.push(`error: ${heading}`); },
    });
  }, `${rendererRoot}${sep}`);

  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  // Leaflogue confirms through in-app dialogs (answered with
  // steps.confirmDialog). A native `window.confirm` would be a regression, and
  // Electron's message box for it cannot be driven from the test, so any call
  // is declined here and reported when the session closes.
  await page.evaluate(() => {
    const state = { expected: [] as string[], unexpected: [] as string[] };
    (window as unknown as { __leaflogueConfirms: typeof state }).__leaflogueConfirms = state;
    window.confirm = (message?: string) => {
      const text = String(message ?? "");
      const expected = state.expected.shift();
      if (expected !== undefined && new RegExp(expected, "u").test(text)) return true;
      state.unexpected.push(text);
      return false;
    };
  });

  const capabilities = await page.evaluate(() => window.leaflogue.system.getCapabilities());
  for (const path of Object.values(capabilities.storagePaths)) {
    // Some of these do not exist yet; the profile root is already a real path.
    expect(path.startsWith(`${profile.root}${sep}`), `${path} is outside the test profile`).toBe(true);
  }

  const queue = async (kind: DialogKind, response: DialogResponse) => {
    await app.evaluate((_electron, { kind: target, response: value }) => {
      (globalThis as unknown as { __leaflogueE2E: { queue: Record<string, unknown[]> } }).__leaflogueE2E.queue[target]!.push(value);
    }, { kind, response });
  };

  return {
    app,
    page,
    profile,
    libraryFile: capabilities.storagePaths.libraryFile,
    chooseFile: (path) => queue("open", { canceled: false, filePaths: [path] }),
    cancelNextFileDialog: () => queue("open", { canceled: true, filePaths: [] }),
    saveFileAs: (path) => queue("save", { canceled: false, filePath: path }),
    resize: async (width, height) => {
      await app.evaluate(({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0];
        window?.setContentSize(size.width, size.height);
      }, { width, height });
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
    },
    close: async () => {
      const state = await app.evaluate(() => {
        const value = (globalThis as unknown as { __leaflogueE2E: { blocked: string[]; unexpectedDialogs: string[]; queue: Record<string, unknown[]> } }).__leaflogueE2E;
        return { blocked: value.blocked, unexpectedDialogs: value.unexpectedDialogs, unused: value.queue.open!.length + value.queue.save!.length };
      });
      const confirms = await page.evaluate(() => (window as unknown as { __leaflogueConfirms: { expected: string[]; unexpected: string[] } }).__leaflogueConfirms);
      running.delete(app);
      await app.close();
      expect(state.blocked, "requests left the app").toEqual([]);
      expect(state.unexpectedDialogs, "native dialogs the test did not answer").toEqual([]);
      expect(state.unused, "stubbed dialogs that were never shown").toBe(0);
      expect(confirms.unexpected, "confirmations the test did not expect").toEqual([]);
      expect(confirms.expected, "expected confirmations that never appeared").toEqual([]);
      expect(networkActivity(netLog), "network activity in Chromium's net log").toEqual([]);
    },
  };
}

/**
 * Every URL request, host resolution, or socket in a Chromium net log. The app
 * serves its renderer through a custom protocol that never reaches the network
 * stack, so for a local-only session this list must be empty.
 */
export function networkActivity(path: string): string[] {
  const text = readFileSync(path, "utf8");
  let log: { constants: { logEventTypes: Record<string, number> }; events: { type: number; params?: Record<string, unknown> }[] };
  try {
    log = JSON.parse(text) as typeof log;
  } catch {
    // A net log is only terminated on a clean shutdown; close the array so a
    // crashed run still reports what it did.
    log = JSON.parse(`${text.replace(/,\s*$/u, "")}]}`) as typeof log;
  }
  const names = new Map(Object.entries(log.constants.logEventTypes).map(([name, id]) => [id, name]));
  const activity = new Set<string>();
  for (const event of log.events) {
    const name = names.get(event.type) ?? String(event.type);
    const target = event.params?.url ?? event.params?.host ?? event.params?.address;
    if (typeof target === "string" && /^(URL_REQUEST|REQUEST_ALIVE|HOST_RESOLVER|TCP_|UDP_|SOCKET|SSL_|QUIC_SESSION|HTTP_STREAM|CORS_REQUEST)/u.test(name)) {
      activity.add(`${name} ${target}`);
    }
  }
  return [...activity];
}
