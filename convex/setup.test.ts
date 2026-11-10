// @vitest-environment edge-runtime

import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "./schema";
import { convexModules } from "./test.setup";

const status = makeFunctionReference<"query", Record<string, never>, {
  product: "leaflogue";
  schemaVersion: number;
  mutationContractVersion: number;
}>("setup:status");

describe("Convex deployment status", () => {
  it("exposes only version metadata without reading library data", async () => {
    const t = convexTest(schema, convexModules);
    await t.run((ctx) => ctx.db.insert("libraries", {
      externalId: "private-library-id",
      nextChangeSequence: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));

    await expect(t.query(status, {})).resolves.toEqual({
      product: "leaflogue",
      schemaVersion: 17,
      mutationContractVersion: 23,
    });
  });
});
