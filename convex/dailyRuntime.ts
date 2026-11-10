import type { DataModelFromSchemaDefinition, FunctionReference, GenericMutationCtx, MutationBuilder } from "convex/server";
import { makeFunctionReference, mutationGeneric } from "convex/server";
import { requireLibraryAccess } from "./accessControl";
import { dailySelectionValidator, ensureDailySelectionArgs, type DailySelectionResult, type EnsureDailySelectionArgs } from "./dailyContracts";
import schema from "./schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
const mutation = mutationGeneric as MutationBuilder<DataModel, "public">;
const target = makeFunctionReference<"mutation", EnsureDailySelectionArgs, DailySelectionResult>("daily:ensureDailySelection") as unknown as FunctionReference<"mutation", "internal", EnsureDailySelectionArgs, DailySelectionResult>;

export const ensureDailySelection = mutation({
  args: ensureDailySelectionArgs,
  returns: dailySelectionValidator,
  handler: async (ctx: GenericMutationCtx<DataModel>, args: EnsureDailySelectionArgs) => {
    await requireLibraryAccess(ctx, args.libraryId, "write");
    return ctx.runMutation(target, args);
  },
});
