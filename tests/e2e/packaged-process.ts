import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { isolatedProfileEnvironment, type Profile } from "./harness";

/** Shared lifecycle for opt-in packaged Electron checks. */
export async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((onReady, onError) => {
    server.once("error", onError);
    server.listen(0, "127.0.0.1", onReady);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((onClose, onError) => server.close((error) => error ? onError(error) : onClose()));
  if (port === 0) throw new Error("Could not reserve a packaged-app debugging port");
  return port;
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export async function waitForExit(child: ChildProcess, timeout: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolveExit(false);
    }, timeout);
    const onExit = () => {
      clearTimeout(timer);
      resolveExit(true);
    };
    child.once("exit", onExit);
  });
}

export async function stopPackagedProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalProcessTree(child, "SIGTERM");
  if (await waitForExit(child, 5_000)) return;
  signalProcessTree(child, "SIGKILL");
  if (!(await waitForExit(child, 5_000))) throw new Error("Packaged Leaflogue did not exit after SIGKILL");
}

export interface PackagedApp {
  readonly child: ChildProcess;
  readonly browser: Browser;
  readonly page: Page;
  /** Chromium's net log, for proving the app stayed offline. */
  readonly netLog: string;
  stderr(): string;
  /** Close the window the way a reader would, then make sure the process is gone. */
  quit(): Promise<void>;
}

/**
 * Start a packaged executable against an isolated profile and attach to its
 * renderer over Chromium's local debugging port. Production fuses block Node
 * inspection and Playwright's Electron driver, but not this renderer channel.
 */
export async function launchPackagedApp(executable: string, profile: Profile): Promise<PackagedApp> {
  const port = await unusedLoopbackPort();
  const netLog = join(profile.root, "packaged-net-log.json");
  const child = spawn(executable, [
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${join(profile.root, "user-data")}`,
    `--log-net-log=${netLog}`,
    ...(process.env.LEAFLOGUE_E2E_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
  ], {
    cwd: profile.root,
    env: isolatedProfileEnvironment(profile),
    detached: process.platform !== "win32",
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_000); });
  try {
    const endpoint = `http://127.0.0.1:${port}`;
    await expect.poll(async () => fetch(`${endpoint}/json/version`).then((response) => response.ok, () => false), {
      message: "packaged Leaflogue did not expose its local automation endpoint",
      timeout: 30_000,
    }).toBe(true);
    const browser = await chromium.connectOverCDP(endpoint);
    const page = browser.contexts()[0]?.pages()[0];
    if (!page) throw new Error(`Packaged Leaflogue opened no page. stderr: ${stderr}`);
    return {
      child,
      browser,
      page,
      netLog,
      stderr: () => stderr,
      quit: async () => {
        const session = await browser.newBrowserCDPSession();
        void session.send("Browser.close").catch(() => undefined);
        if (!(await waitForExit(child, 10_000))) await stopPackagedProcess(child);
      },
    };
  } catch (error) {
    await stopPackagedProcess(child);
    throw error;
  }
}

/** Finish first-run setup as a local-only library. */
export async function completeLocalSetup(page: Page): Promise<void> {
  const welcome = page.getByRole("dialog", { name: "Your library starts on this computer." });
  await expect(welcome).toBeVisible();
  await welcome.getByRole("button", { name: "Continue" }).click();
  const storage = page.getByRole("dialog", { name: "Would you like a remote library?" });
  await expect(storage.getByRole("radio", { name: /Local only/u })).toBeChecked();
  await storage.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("dialog", { name: "Ready for your library." }).getByRole("button", { name: "Open Leaflogue" }).click();
}
