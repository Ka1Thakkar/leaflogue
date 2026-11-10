import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FuseState, FuseV1Options, FuseVersion, getCurrentFuseWire } from "@electron/fuses";
import { expect, test } from "@playwright/test";
import { createProfile, networkActivity, removeProfile } from "./harness";
import { completeLocalSetup, launchPackagedApp, stopPackagedProcess } from "./packaged-process";

const configuredExecutable = process.env.LEAFLOGUE_PACKAGED_EXECUTABLE?.trim();

test("the packaged desktop payload opens an isolated local library", async () => {
  test.skip(!configuredExecutable, "Set LEAFLOGUE_PACKAGED_EXECUTABLE to the native packaged app executable");
  const executable = resolve(configuredExecutable!);
  expect(existsSync(executable), `Missing packaged executable: ${executable}`).toBe(true);
  const fuses = await getCurrentFuseWire(executable);
  expect(fuses).toMatchObject({
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: FuseState.DISABLE,
    [FuseV1Options.EnableCookieEncryption]: FuseState.ENABLE,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: FuseState.DISABLE,
    [FuseV1Options.EnableNodeCliInspectArguments]: FuseState.DISABLE,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: FuseState.ENABLE,
    [FuseV1Options.OnlyLoadAppFromAsar]: FuseState.ENABLE,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: FuseState.DISABLE,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: FuseState.DISABLE,
    [FuseV1Options.WasmTrapHandlers]: FuseState.ENABLE,
  });
  const profile = createProfile();
  let app: Awaited<ReturnType<typeof launchPackagedApp>> | undefined;
  try {
    app = await launchPackagedApp(executable, profile);
    const { page, netLog } = app;
    await expect(page).toHaveURL(/^leaflogue:\/\/app\//u);
    expect(await page.evaluate(() => {
      const marker = "__leaflogueUnexpectedInlineScript";
      Reflect.deleteProperty(window, marker);
      const script = document.createElement("script");
      script.textContent = `window.${marker} = true`;
      document.head.append(script);
      script.remove();
      return marker in window;
    }), "packaged CSP allowed an inline script").toBe(false);
    const connectionViolation = await page.evaluate(async (url) => {
      const violation = new Promise<{ blockedUri: string; directive: string } | null>((resolveViolation) => {
        const onViolation = (event: SecurityPolicyViolationEvent) => {
          if (event.effectiveDirective !== "connect-src") return;
          clearTimeout(timeout);
          document.removeEventListener("securitypolicyviolation", onViolation);
          resolveViolation({ blockedUri: event.blockedURI, directive: event.effectiveDirective });
        };
        const timeout = window.setTimeout(() => {
          document.removeEventListener("securitypolicyviolation", onViolation);
          resolveViolation(null);
        }, 2_000);
        document.addEventListener("securitypolicyviolation", onViolation);
      });
      await fetch(url).catch(() => undefined);
      return violation;
    }, "http://127.0.0.1:9/json/version");
    expect(connectionViolation, "packaged CSP did not report a blocked renderer connection").toEqual({
      blockedUri: "http://127.0.0.1:9/json/version",
      directive: "connect-src",
    });
    expect(await page.evaluate(() => ({
      process: "process" in window,
      require: "require" in window,
    })), "packaged renderer exposed Node globals").toEqual({ process: false, require: false });

    const dictionary = await page.evaluate(() => window.leaflogue.system.lookupWord!("serendipity"));
    expect(dictionary.definitions.some(entry => entry.definition.includes("fortunate")), "packaged dictionary files are missing or unreadable").toBe(true);

    await completeLocalSetup(page);

    await page.getByRole("button", { name: "Add book" }).click();
    const form = page.getByRole("dialog", { name: "Add a book" });
    await form.getByLabel("Title").fill("Packaged boundary check");
    await form.getByLabel("Authors").fill("Leaflogue");
    await form.getByRole("button", { name: "Add book" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Packaged boundary check" })).toBeVisible();
    const libraryFile = await page.evaluate(async () => (await window.leaflogue.system.getCapabilities()).storagePaths.libraryFile);
    expect(libraryFile.startsWith(`${profile.root}${sep}`), "packaged app used a library outside the isolated profile").toBe(true);
    await app.quit();
    expect(existsSync(libraryFile), "packaged app did not create its isolated SQLite library").toBe(true);
    const database = new DatabaseSync(libraryFile, { readOnly: true });
    try {
      expect(database.prepare("SELECT count(*) AS count FROM books WHERE title = ?").get("Packaged boundary check"))
        .toEqual({ count: 1 });
    } finally {
      database.close();
    }
    expect(networkActivity(netLog), "packaged Chromium renderer or browser service used the network").toEqual([]);
  } finally {
    if (app) await stopPackagedProcess(app.child);
    await removeProfile(profile);
  }
});
