import { describe, expect, it } from "vitest";
import { readConfig } from "./config";

const BASE = {
  DATABASE_URL: "postgres://leaflogue@db/leaflogue",
  LEAFLOGUE_PUBLIC_URL: "https://reading.example.test",
  LEAFLOGUE_OIDC_CLIENT_ID: "client",
  LEAFLOGUE_OIDC_CLIENT_SECRET: "secret",
  AUTH_ALLOWED_EMAILS: "Reader@Example.test",
};

describe("server configuration", () => {
  it("reads a complete environment with safe defaults", () => {
    const config = readConfig(BASE);
    expect(config.publicUrl.origin).toBe("https://reading.example.test");
    expect(config.oidc?.issuer).toBe("https://accounts.google.com");
    expect([...config.allowedEmails]).toEqual(["reader@example.test"]);
    expect(config).toMatchObject({ host: "127.0.0.1", port: 8787 });
  });

  it("refuses to open sign-in to everyone or to plain http on the internet", () => {
    expect(() => readConfig({ ...BASE, AUTH_ALLOWED_EMAILS: " , " })).toThrow("AUTH_ALLOWED_EMAILS");
    expect(() => readConfig({ ...BASE, AUTH_ALLOWED_EMAILS: undefined })).toThrow("AUTH_ALLOWED_EMAILS");
    expect(() => readConfig({ ...BASE, LEAFLOGUE_PUBLIC_URL: "http://reading.example.test" })).toThrow("https");
    expect(() => readConfig({ ...BASE, LEAFLOGUE_PUBLIC_URL: "https://reading.example.test/app" })).toThrow("no path");
    expect(() => readConfig({ ...BASE, LEAFLOGUE_OIDC_ISSUER: "http://idp.example.test" })).toThrow("https");
    expect(() => readConfig({ ...BASE, LEAFLOGUE_LIBRARY_ID: "library" })).toThrow("LEAFLOGUE_LIBRARY_ID");
    expect(readConfig({ ...BASE, LEAFLOGUE_PUBLIC_URL: "http://localhost:5173" }).publicUrl.origin).toBe("http://localhost:5173");
  });

  it("runs without sign-in only on this computer, for one reader", () => {
    const local = { DATABASE_URL: BASE.DATABASE_URL, LEAFLOGUE_AUTH: "none", LEAFLOGUE_PUBLIC_URL: "http://localhost:8787" };
    const config = readConfig(local);
    expect(config.oidc).toBeUndefined();
    expect([...config.allowedEmails]).toEqual(["reader@localhost"]);
    expect(() => readConfig({ ...local, HOST: "0.0.0.0" })).toThrow("only on this computer");
    expect(() => readConfig({ ...local, LEAFLOGUE_PUBLIC_URL: "https://reading.example.test" })).toThrow("only on this computer");
    expect(() => readConfig({ ...local, LEAFLOGUE_AUTH: "open" })).toThrow("oidc or none");
  });
});
