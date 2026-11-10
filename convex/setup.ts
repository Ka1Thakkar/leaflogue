import { queryGeneric } from "convex/server";
import { v } from "convex/values";

export const status = queryGeneric({
  args: {},
  returns: v.object({
    product: v.literal("leaflogue"),
    schemaVersion: v.number(),
    mutationContractVersion: v.number(),
  }),
  handler: () => ({
    product: "leaflogue" as const,
    schemaVersion: 17,
    mutationContractVersion: 23,
  }),
});
