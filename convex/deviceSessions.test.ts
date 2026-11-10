// @vitest-environment edge-runtime

import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "./schema";
import { convexModules } from "./test.setup";

const LIBRARY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEVICE = "11111111-1111-4111-8111-111111111111";
const ALICE = "https://identity.example|alice";
const BOB = "https://identity.example|bob";
const provision = makeFunctionReference<"mutation", {
  libraryId: string;
  identityTokenIdentifier: string;
  role?: "owner" | "editor" | "viewer";
}, unknown>("access:provisionLibrary");
const revokeAccess = makeFunctionReference<"mutation", {
  libraryId: string;
  identityTokenIdentifier: string;
}, boolean>("access:revokeLibraryAccess");
const enroll = makeFunctionReference<"mutation", {
  libraryId: string;
  deviceId: string;
  name: string;
}, { sessionId: string; deviceId: string; name: string; currentIdentity: boolean }>("deviceSessions:enroll");
const list = makeFunctionReference<"query", { libraryId: string }, Array<{
  sessionId: string;
  deviceId: string;
  name: string;
  currentIdentity: boolean;
  revokedAt?: number;
}>>("deviceSessions:list");
const revoke = makeFunctionReference<"mutation", {
  libraryId: string;
  sessionId: string;
}, boolean>("deviceSessions:revoke");
const check = makeFunctionReference<"query", {
  libraryId: string;
  sessionId: string;
  deviceId: string;
}, true>("deviceSessions:check");
const forgetRevoked = makeFunctionReference<"mutation", {
  libraryId: string;
  sessionId: string;
}, boolean>("deviceSessions:forgetRevoked");

describe("authenticated Convex device sessions", () => {
  it("enrolls idempotently, lists without identity data, and denies device takeover", async () => {
    const t = convexTest(schema, convexModules);
    await t.mutation(provision, { libraryId: LIBRARY, identityTokenIdentifier: ALICE });
    await t.mutation(provision, { libraryId: LIBRARY, identityTokenIdentifier: BOB, role: "editor" });
    await expect(t.mutation(enroll, { libraryId: LIBRARY, deviceId: DEVICE, name: "Laptop" }))
      .rejects.toThrow("Authentication is required");
    const asAlice = t.withIdentity({ tokenIdentifier: ALICE });
    const first = await asAlice.mutation(enroll, { libraryId: LIBRARY, deviceId: DEVICE, name: " Laptop " });
    const repeated = await asAlice.mutation(enroll, { libraryId: LIBRARY, deviceId: DEVICE, name: "Work laptop" });
    expect(repeated).toMatchObject({ sessionId: first.sessionId, name: "Work laptop", currentIdentity: true });
    const visible = await asAlice.query(list, { libraryId: LIBRARY });
    expect(visible).toMatchObject([{ sessionId: first.sessionId, deviceId: DEVICE, name: "Work laptop" }]);
    expect(JSON.stringify(visible)).not.toContain(ALICE);
    await expect(asAlice.query(check, {
      libraryId: LIBRARY,
      sessionId: first.sessionId,
      deviceId: DEVICE,
    })).resolves.toBe(true);
    await expect(asAlice.query(check, {
      libraryId: LIBRARY,
      sessionId: first.sessionId,
      deviceId: "22222222-2222-4222-8222-222222222222",
    })).rejects.toThrow("inactive");
    await expect(t.withIdentity({ tokenIdentifier: BOB }).mutation(enroll, {
      libraryId: LIBRARY,
      deviceId: DEVICE,
      name: "Stolen identity",
    })).rejects.toThrow("another identity");
    await expect(t.withIdentity({ tokenIdentifier: BOB }).query(list, { libraryId: LIBRARY }))
      .resolves.toEqual([]);
  });

  it("allows self/owner revocation and refuses reenrollment of a revoked device", async () => {
    const t = convexTest(schema, convexModules);
    await t.mutation(provision, { libraryId: LIBRARY, identityTokenIdentifier: ALICE });
    await t.mutation(provision, { libraryId: LIBRARY, identityTokenIdentifier: BOB, role: "editor" });
    const asBob = t.withIdentity({ tokenIdentifier: BOB });
    const session = await asBob.mutation(enroll, { libraryId: LIBRARY, deviceId: DEVICE, name: "Bob's laptop" });
    await expect(asBob.mutation(revoke, { libraryId: LIBRARY, sessionId: session.sessionId })).resolves.toBe(true);
    await expect(asBob.mutation(revoke, { libraryId: LIBRARY, sessionId: session.sessionId })).resolves.toBe(false);
    await expect(asBob.mutation(enroll, { libraryId: LIBRARY, deviceId: DEVICE, name: "Again" }))
      .rejects.toThrow("revoked");
    await expect(asBob.query(check, {
      libraryId: LIBRARY,
      sessionId: session.sessionId,
      deviceId: DEVICE,
    })).rejects.toThrow("inactive");
    const listed = await t.withIdentity({ tokenIdentifier: ALICE }).query(list, { libraryId: LIBRARY });
    expect(listed[0]).toMatchObject({ sessionId: session.sessionId, currentIdentity: false });
    expect(listed[0]?.revokedAt).toEqual(expect.any(Number));
  });

  it("keeps sessions revoked after membership removal and reprovisioning", async () => {
    const t = convexTest(schema, convexModules);
    await t.mutation(provision, { libraryId: LIBRARY, identityTokenIdentifier: ALICE });
    const asAlice = t.withIdentity({ tokenIdentifier: ALICE });
    const session = await asAlice.mutation(enroll, { libraryId: LIBRARY, deviceId: DEVICE, name: "Lost laptop" });
    await expect(t.mutation(revokeAccess, { libraryId: LIBRARY, identityTokenIdentifier: ALICE })).resolves.toBe(true);
    await expect(asAlice.query(check, { libraryId: LIBRARY, sessionId: session.sessionId, deviceId: DEVICE }))
      .rejects.toThrow("access is denied");
    await t.mutation(provision, { libraryId: LIBRARY, identityTokenIdentifier: ALICE });
    await expect(asAlice.query(check, { libraryId: LIBRARY, sessionId: session.sessionId, deviceId: DEVICE }))
      .rejects.toThrow("inactive");
    await expect(asAlice.mutation(enroll, { libraryId: LIBRARY, deviceId: DEVICE, name: "Still lost" }))
      .rejects.toThrow("revoked");
    await expect(asAlice.mutation(forgetRevoked, { libraryId: LIBRARY, sessionId: session.sessionId }))
      .resolves.toBe(true);
    await expect(asAlice.mutation(enroll, { libraryId: LIBRARY, deviceId: DEVICE, name: "Recovered laptop" }))
      .resolves.toMatchObject({ deviceId: DEVICE, name: "Recovered laptop" });
  });

  it("lets an owner revoke another identity, denies cross-library IDs, and caps retained sessions", async () => {
    const t = convexTest(schema, convexModules);
    const otherLibrary = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await t.mutation(provision, { libraryId: LIBRARY, identityTokenIdentifier: ALICE });
    await t.mutation(provision, { libraryId: LIBRARY, identityTokenIdentifier: BOB, role: "editor" });
    await t.mutation(provision, { libraryId: otherLibrary, identityTokenIdentifier: ALICE });
    const bobSession = await t.withIdentity({ tokenIdentifier: BOB }).mutation(enroll, {
      libraryId: LIBRARY,
      deviceId: DEVICE,
      name: "Bob's laptop",
    });
    const asAlice = t.withIdentity({ tokenIdentifier: ALICE });
    await expect(asAlice.mutation(revoke, { libraryId: otherLibrary, sessionId: bobSession.sessionId }))
      .resolves.toBe(false);
    await expect(asAlice.mutation(revoke, { libraryId: LIBRARY, sessionId: bobSession.sessionId }))
      .resolves.toBe(true);

    await t.run(async (ctx) => {
      for (let index = 1; index < 100; index += 1) {
        await ctx.db.insert("deviceSessions", {
          libraryId: LIBRARY,
          deviceId: `seed-${index}`,
          identityTokenIdentifier: ALICE,
          name: `Seed ${index}`,
          createdAt: index,
          lastSeenAt: index,
          revokedAt: index,
        });
      }
    });
    const before = await t.run((ctx) => ctx.db.query("deviceSessions")
      .withIndex("by_library", (q) => q.eq("libraryId", LIBRARY)).collect());
    expect(before).toHaveLength(100);
    await expect(asAlice.mutation(enroll, {
      libraryId: LIBRARY,
      deviceId: "22222222-2222-4222-8222-222222222222",
      name: "One too many",
    })).rejects.toThrow("at most 100");
    const after = await t.run((ctx) => ctx.db.query("deviceSessions")
      .withIndex("by_library", (q) => q.eq("libraryId", LIBRARY)).collect());
    expect(after).toHaveLength(100);
  });
});
