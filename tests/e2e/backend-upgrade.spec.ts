import { expect, test } from "@playwright/test";
import { createProfile, launch, removeProfile } from "./harness";

for (const newer of [false, true]) test(`explains a ${newer ? "newer" : "older"} backend without asking the user to reset data`, async () => {
  const profile = createProfile();
  try {
    const session = await launch(profile);
    await session.page.getByRole("button", { name: "Set up later" }).click();
    await session.app.evaluate(({ ipcMain }, newer) => {
      const backendUpdate = { installedContract: newer ? 25 : 21, installedSchema: 17, requiredContract: 24, requiredSchema: 17, updateDesktop: newer };
      for (const channel of ["remote:describe", "remote:check", "sync:status"]) ipcMain.removeHandler(channel);
      ipcMain.handle("remote:describe", () => ({ configured: true, provider: "convex", host: "fixture.convex.cloud", deployment: "fixture", source: "config", transport: "tls", syncKeySaved: true }));
      ipcMain.handle("remote:check", () => ({ configured: true, provider: "convex", reachable: true, initialized: false, schemaVersion: 17, mutationContractVersion: backendUpdate.installedContract, backendUpdate }));
      ipcMain.handle("sync:status", () => ({ state: "idle", lastResult: { status: "failed", bootstrapped: 0, pushed: 0, pulled: 0, superseded: 0,
        problem: { phase: "connect", kind: "schema", message: "Update needed", backendUpdate } } }));
    }, newer);
    await session.page.evaluate(() => { location.hash = "#/settings"; });
    await session.page.getByRole("heading", { name: "Remote library", exact: true }).click();
    const guide = session.page.getByRole("region", { name: "Backend upgrade guidance" });
    // section has an accessible label and contains the actionable version comparison.
    await expect(guide).toBeVisible();
    await expect(guide.getByRole("heading", { name: newer ? "Your desktop app needs an update" : "Your backend needs an update" })).toBeVisible();
    await expect(guide).toContainText(`contract ${newer ? 25 : 21}`);
    await expect(guide).toContainText("Queued edits and deferred colour choices remain saved");
    await expect(guide.getByRole("button", { name: "Upgrade instructions" })).toBeVisible();
    if (!newer) await expect(guide).toContainText("/deploy.sh --production");
    await session.close();
  } finally { await removeProfile(profile); }
});
