import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Drives the GTK file chooser that a packaged Linux build opens, the way a
 * reader would: find the window by its title, type the path into its
 * location field, and press the accept button. Production fuses stop Playwright from
 * stubbing Electron's `dialog` module in the packaged app, so the real system
 * dialog has to be answered from outside. Needs X11 (Xvfb in CI) and
 * `xdotool`; there is no window manager, so focus is set directly.
 */

const run = promisify(execFile);

async function xdotool(...args: string[]): Promise<string> {
  const { stdout } = await run("xdotool", args, { timeout: 15_000 });
  return stdout.trim();
}

/** With LEAFLOGUE_E2E_DIALOG_SHOTS set to a folder, save the screen at each step for debugging. */
let shot = 0;
async function capture(step: string): Promise<void> {
  const folder = process.env.LEAFLOGUE_E2E_DIALOG_SHOTS;
  if (!folder) return;
  shot += 1;
  await run("import", ["-window", "root", `${folder}/dialog-${String(shot).padStart(2, "0")}-${step}.png`]).catch(() => undefined);
}

export async function nativeDialogsAvailable(): Promise<boolean> {
  if (process.platform !== "linux" || !process.env.DISPLAY) return false;
  return xdotool("version").then(() => true, () => false);
}

function exactTitle(title: string): string {
  return `^${title.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`;
}

async function findWindow(title: string, timeout: number): Promise<string> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = await xdotool("search", "--onlyvisible", "--name", exactTitle(title)).catch(() => "");
    const id = found.split("\n").find(Boolean);
    if (id) return id;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`No "${title}" file dialog opened`);
}

async function waitForClose(id: string, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const visible = await xdotool("search", "--onlyvisible", "--name", ".").catch(() => "");
    if (!visible.split("\n").includes(id)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("The file dialog did not close");
}

async function clickAcceptButton(id: string): Promise<void> {
  const geometry = await xdotool("getwindowgeometry", "--shell", id);
  const value = (key: string) => Number(new RegExp(`^${key}=(\\d+)`, "mu").exec(geometry)?.[1] ?? Number.NaN);
  const [x, y, width, height] = ["X", "Y", "WIDTH", "HEIGHT"].map(value);
  if ([x, y, width, height].some((number) => !Number.isFinite(number))) throw new Error("Could not measure the file dialog");
  await xdotool("mousemove", String(x! + width! - 50), String(y! + height! - 24));
  await xdotool("click", "1");
}

/**
 * Answer the next file dialog titled `title` with `path`. For an open dialog
 * the location field is opened with Ctrl+L; a save dialog's name field already
 * has focus and accepts a full path.
 */
export async function answerNativeFileDialog(title: string, path: string, kind: "open" | "save"): Promise<void> {
  const id = await findWindow(title, 20_000);
  await xdotool("windowfocus", "--sync", id);
  // Give GTK a moment to finish laying out the chooser before typing into it.
  await new Promise((resolve) => setTimeout(resolve, 500));
  await capture("opened");
  await xdotool("key", "--clearmodifiers", kind === "open" ? "ctrl+l" : "ctrl+a");
  await xdotool("type", "--delay", "15", path);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await capture("typed");
  // Enter in the location field closes this chooser without a selection, so
  // press its accept button (Open or Save), which sits at the bottom right.
  await clickAcceptButton(id);
  await waitForClose(id, 10_000);
  if (process.env.LEAFLOGUE_E2E_DIALOG_SHOTS) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await capture("closed");
  }
}

/** Accept the default button of the next native message box titled `title`. */
export async function acceptNativeMessageBox(title: string): Promise<void> {
  const id = await findWindow(title, 20_000);
  await xdotool("windowfocus", "--sync", id);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await xdotool("key", "Return");
  await waitForClose(id, 10_000);
}
