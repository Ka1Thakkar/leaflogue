// @vitest-environment edge-runtime

import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allowedEmails, verifiedGoogleProfile } from "./auth";
import { identityKey, ownUserIdentityKey } from "./hostIdentity";
import schema from "./schema";
import { convexModules } from "./test.setup";

const SITE = "https://quiet-otter-123.convex.site";
const provisionHostOwner = makeFunctionReference<"mutation", { identityTokenIdentifier: string }, { libraryId: string }>("access:provisionHostOwner");
const myLibraries = makeFunctionReference<"query", Record<string, never>, Array<{ libraryId: string; role: string }>>("access:myLibraries");

const identity = (issuer: string, subject: string) => ({ auth: { getUserIdentity: () => Promise.resolve({ issuer, subject, tokenIdentifier: `${issuer}|${subject}` }) } }) as never;

afterEach(() => { vi.unstubAllEnvs(); });

describe("the web app's sign-in", () => {
  it("is closed until emails are allowed, and compares them without case", () => {
    expect(allowedEmails(undefined).size).toBe(0);
    expect([...allowedEmails(" Reader@Example.test, ,second@example.test")]).toEqual(["reader@example.test", "second@example.test"]);
  });

  it("requires Google's positive verified-email claim before creating an identity", () => {
    expect(() => verifiedGoogleProfile({ sub: "reader", email: "reader@example.test" })).toThrow("not allowed");
    expect(() => verifiedGoogleProfile({ sub: "reader", email: "reader@example.test", email_verified: false })).toThrow("not allowed");
    expect(verifiedGoogleProfile({ sub: "reader", email: " Reader@Example.test ", email_verified: true }))
      .toMatchObject({ id: "reader", email: "reader@example.test", emailVerified: true });
  });

  it("keys the deployment's own readers by user, so a new session is the same reader", async () => {
    vi.stubEnv("CONVEX_SITE_URL", SITE);
    expect(await identityKey(identity(SITE, "user123|session1"))).toBe("user|user123");
    expect(await identityKey(identity(SITE, "user123|session2"))).toBe("user|user123");
    expect(await identityKey(identity("https://other.example", "user123|session1"))).toBe("https://other.example|user123|session1");
  });

  it("opens the library to the reader provisioned at sign-in, from any session", async () => {
    vi.stubEnv("CONVEX_SITE_URL", SITE);
    const t = convexTest(schema, convexModules);
    const { libraryId } = await t.mutation(provisionHostOwner, { identityTokenIdentifier: ownUserIdentityKey("user123") });
    const signedIn = t.withIdentity({ issuer: SITE, subject: "user123|session9" });
    expect(await signedIn.query(myLibraries, {})).toEqual([{ libraryId, role: "owner" }]);
    expect(await t.withIdentity({ issuer: SITE, subject: "stranger|session1" }).query(myLibraries, {})).toEqual([]);
  });
});
