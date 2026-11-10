import { selectOption } from "../shared/select";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { createProfile, isolatedProfileEnvironment, removeProfile, type Profile } from "../e2e/harness";
import { openBook, openRail, passage } from "../e2e/steps";
import { stopPackagedProcess, unusedLoopbackPort } from "../e2e/packaged-process";
import { acceptNativeMessageBox } from "../e2e/native-file-dialog";

const executable = process.env.LEAFLOGUE_PACKAGED_EXECUTABLE?.trim();
const deploymentUrl = process.env.LEAFLOGUE_CONVEX_URL?.trim();
const syncKey = process.env.LEAFLOGUE_CONVEX_SYNC_KEY?.trim();

interface PackagedSession {
  readonly browser: Browser;
  readonly child: ChildProcess;
  readonly page: Page;
  readonly profile: Profile;
}

function requireDisposableDeployment(): void {
  if (!executable || !existsSync(resolve(executable)) || !deploymentUrl || !syncKey) {
    throw new Error("Set the packaged executable, Convex URL, and sync key in the ignored local environment");
  }
  if (process.env.CONVEX_DEPLOY_KEY || !process.env.CONVEX_DEPLOYMENT?.startsWith("dev:") ||
      new URL(process.env.CONVEX_URL ?? "https://invalid.example").origin !== new URL(deploymentUrl).origin) {
    throw new Error("This test requires the matching CLI-selected disposable development deployment without a deploy key");
  }
}

async function launchPackaged(profile: Profile): Promise<PackagedSession> {
  const port = await unusedLoopbackPort();
  const environment = isolatedProfileEnvironment(profile);
  for (const key of Object.keys(environment)) if (key.startsWith("CONVEX_")) delete environment[key];
  const child = spawn(resolve(executable!), [
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${join(profile.root, "user-data")}`,
    ...(process.env.LEAFLOGUE_E2E_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
  ], {
    cwd: profile.root,
    env: environment,
    detached: process.platform !== "win32",
    stdio: "ignore",
  });
  try {
    const endpoint = `http://127.0.0.1:${port}`;
    await expect.poll(() => fetch(`${endpoint}/json/version`).then((response) => response.ok, () => false), {
      message: "Packaged Leaflogue did not open its local automation endpoint",
      timeout: 30_000,
    }).toBe(true);
    const browser = await chromium.connectOverCDP(endpoint);
    const page = browser.contexts()[0]?.pages()[0];
    if (!page) throw new Error("Packaged Leaflogue opened no page");
    await expect(page).toHaveURL(/^leaflogue:\/\/app\//u);
    return { browser, child, page, profile };
  } catch (error) {
    await stopPackagedProcess(child);
    throw error;
  }
}

async function closePackaged(session: PackagedSession): Promise<void> {
  await stopPackagedProcess(session.child);
  await Promise.race([
    session.browser.close().catch(() => undefined),
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 3_000)),
  ]);
}

async function finishLocalSetup(page: Page): Promise<void> {
  const welcome = page.getByRole("dialog", { name: "Your library starts on this computer." });
  await expect(welcome).toBeVisible();
  await welcome.getByRole("button", { name: "Continue" }).click();
  const storage = page.getByRole("dialog", { name: "Would you like a remote library?" });
  await storage.getByRole("button", { name: "Continue" }).click();
  const review = page.getByRole("dialog", { name: "Ready for your library." });
  await review.getByRole("button", { name: "Open Leaflogue" }).click();
}

async function configureAndSync(page: Page): Promise<void> {
  await openRail(page, "Settings");
  const section = page.locator("details").filter({ has: page.getByRole("heading", { name: "Remote library" }) });
  await openRemoteSection(section);
  await selectOption(section.getByLabel("Database provider"), "convex");
  await section.getByLabel("Convex deployment URL").fill(deploymentUrl!);
  await section.getByLabel("Sync key").fill(syncKey!);
  // A new sync server is confirmed in a native dialog the renderer cannot answer.
  await Promise.all([
    acceptNativeMessageBox("Sync with a new server?"),
    section.getByRole("button", { name: "Save connection" }).click(),
  ]);
  await expect(section.getByRole("status").filter({ hasText: "Connection saved." })).toBeVisible();
  await section.getByRole("button", { name: "Check connection" }).click();
  await expect(section.getByRole("status").filter({ hasText: "Connected. Leaflogue schema" })).toBeVisible();
  await syncNow(section);
}

async function openRemoteSection(section: Locator): Promise<void> {
  if (await section.getAttribute("open") === null) await section.locator("summary").click();
  await expect(section.getByRole("button", { name: "Check connection" })).toBeVisible();
}

async function syncNow(section: Locator): Promise<void> {
  await section.getByRole("button", { name: "Sync now" }).click();
  await expect(section.getByRole("status").filter({ hasText: "Sync complete." })).toBeVisible({ timeout: 60_000 });
}

test("two isolated packaged desktops exchange edits through Settings", async () => {
  requireDisposableDeployment();
  const profiles = [createProfile(), createProfile()];
  const sessions: PackagedSession[] = [];
  const title = `Packaged Convex check ${randomUUID()}`;
  const quote = `A synthetic packaged passage ${randomUUID()}`;
  const note = `A synthetic note from the second desktop ${randomUUID()}`;
  try {
    const first = await test.step("launch first packaged desktop", () => launchPackaged(profiles[0]!), { timeout: 35_000 });
    sessions.push(first);
    await test.step("create first desktop book and passage", async () => {
      await finishLocalSetup(first.page);
      await first.page.getByRole("button", { name: "Add book" }).click();
      const form = first.page.getByRole("dialog", { name: "Add a book" });
      await form.getByLabel("Title").fill(title);
      await form.getByRole("button", { name: "Add book" }).click();
      await first.page.getByRole("button", { name: "Add highlight" }).click();
      const keep = first.page.getByRole("dialog", { name: "Keep a passage" });
      await keep.getByRole("textbox", { name: "Quote" }).fill(quote);
      await keep.getByRole("button", { name: "Add highlight" }).click();
    }, { timeout: 35_000 });
    await test.step("configure and sync first desktop through Settings", () => configureAndSync(first.page), { timeout: 45_000 });

    const second = await test.step("launch second packaged desktop", () => launchPackaged(profiles[1]!), { timeout: 35_000 });
    sessions.push(second);
    await test.step("second desktop receives the book and passage", async () => {
      await finishLocalSetup(second.page);
      await configureAndSync(second.page);
      await openBook(second.page, title);
      await expect(passage(second.page, quote)).toBeVisible();
    }, { timeout: 45_000 });
    await test.step("second desktop adds and syncs a note", async () => {
      const received = passage(second.page, quote);
      await received.getByRole("button", { name: "Add another note" }).click();
      const noteDialog = second.page.getByRole("dialog", { name: "Add a note" });
      await noteDialog.getByRole("textbox", { name: "Your note" }).fill(note);
      await noteDialog.getByRole("button", { name: "Add note" }).click();
      await openRail(second.page, "Settings");
      const secondRemote = second.page.locator("details").filter({ has: second.page.getByRole("heading", { name: "Remote library" }) });
      await openRemoteSection(secondRemote);
      await syncNow(secondRemote);
    }, { timeout: 35_000 });

    await test.step("first desktop receives the note", async () => {
      await openRail(first.page, "Settings");
      const firstRemote = first.page.locator("details").filter({ has: first.page.getByRole("heading", { name: "Remote library" }) });
      await openRemoteSection(firstRemote);
      await syncNow(firstRemote);
      await openBook(first.page, title);
      await expect(passage(first.page, quote)).toContainText(note);
    }, { timeout: 35_000 });

    await test.step("a wrong saved key is refused and the correct key restores sync", async () => {
      await openRail(first.page, "Settings");
      const remote = first.page.locator("details").filter({ has: first.page.getByRole("heading", { name: "Remote library" }) });
      await openRemoteSection(remote);
      const keyField = remote.getByLabel("Sync key");
      await keyField.fill(randomBytes(32).toString("hex"));
      await remote.getByRole("button", { name: "Save connection" }).click();
      await expect(keyField).toHaveValue("");
      await remote.getByRole("button", { name: "Sync now" }).click();
      await expect(remote.getByRole("status").filter({ hasText: "The sync provider rejected the configured credentials." }))
        .toBeVisible({ timeout: 30_000 });
      await keyField.fill(syncKey!);
      await remote.getByRole("button", { name: "Save connection" }).click();
      await expect(keyField).toHaveValue("");
      await syncNow(remote);
    }, { timeout: 45_000 });
  } finally {
    for (const session of sessions.reverse()) await closePackaged(session);
    for (const profile of profiles) await removeProfile(profile);
  }
});
