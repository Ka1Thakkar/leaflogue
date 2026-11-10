import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createProfile, launch, removeProfile, type Profile } from "./harness";

/**
 * The guarantees every other spec relies on. If one of these stops holding,
 * a passing workflow would no longer prove the app stayed local.
 */

let profile: Profile;
test.beforeEach(() => { profile = createProfile(); });
test.afterEach(async () => { await removeProfile(profile); });

test("keeps every storage path inside the throwaway profile", async () => {
  const session = await launch(profile);
  // Only Linux relocates Electron's log directory. Elsewhere the default sits
  // outside userData, and asking for it creates it, so it is not queried.
  const paths = await session.app.evaluate(({ app }, linux) => ({
    userData: app.getPath("userData"),
    sessionData: app.getPath("sessionData"),
    crashDumps: app.getPath("crashDumps"),
    ...(linux ? { logs: app.getPath("logs") } : {}),
  }), process.platform === "linux");
  for (const [name, path] of Object.entries(paths)) {
    expect(path.startsWith(profile.root), `${name} (${path}) escaped the profile`).toBe(true);
  }
  await session.close();
  const library = process.platform === "linux"
    ? join(profile.root, "xdg-data", "leaflogue", "library.sqlite")
    : join(profile.root, "user-data", "library.sqlite");
  expect(existsSync(library)).toBe(true);
});

test("fails a session whose main process attempts a request", async () => {
  const session = await launch(profile);
  // A closed loopback port: nothing could leave the machine even if the
  // guard were missing, but the guard must still refuse and report it.
  const outcome = await session.app.evaluate(async ({ net }) => {
    try {
      await net.fetch("http://127.0.0.1:9/leaflogue-e2e-guard");
      return "completed";
    } catch {
      return "refused";
    }
  });
  expect(outcome).toBe("refused");
  await expect(session.close()).rejects.toThrow(/requests left the app/u);
});

test("fails a session that leaves a stubbed dialog unanswered", async () => {
  const session = await launch(profile);
  await session.chooseFile(join(profile.files, "never-chosen.json"));
  await expect(session.close()).rejects.toThrow(/stubbed dialogs that were never shown/u);
});
