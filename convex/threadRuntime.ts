import type { DataModelFromSchemaDefinition, FunctionReference, GenericMutationCtx, MutationBuilder } from "convex/server";
import { makeFunctionReference, mutationGeneric } from "convex/server";
import { requireLibraryAccess } from "./accessControl";
import {
  createThreadArgs, deleteThreadArgs, setHighlightThreadMembershipArgs, threadMembershipValidator,
  threadValidator, updateThreadArgs, type CreateThreadArgs, type DeleteThreadArgs,
  type SetHighlightThreadMembershipArgs, type ThreadMembershipResult, type ThreadResult, type UpdateThreadArgs,
} from "./threadContracts";
import schema from "./schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
const mutation = mutationGeneric as MutationBuilder<DataModel, "public">;
const internal = {
  createThread: reference<CreateThreadArgs, ThreadResult>("threads:createThread"),
  updateThread: reference<UpdateThreadArgs, ThreadResult>("threads:updateThread"),
  deleteThread: reference<DeleteThreadArgs, null>("threads:deleteThread"),
  setHighlightThreadMembership: reference<SetHighlightThreadMembershipArgs, ThreadMembershipResult>("threads:setHighlightThreadMembership"),
};

export const createThread = mutation({ args: createThreadArgs, returns: threadValidator, handler: guarded(internal.createThread) });
export const updateThread = mutation({ args: updateThreadArgs, returns: threadValidator, handler: guarded(internal.updateThread) });
export const deleteThread = mutation({ args: deleteThreadArgs, handler: guarded(internal.deleteThread) });
export const setHighlightThreadMembership = mutation({
  args: setHighlightThreadMembershipArgs, returns: threadMembershipValidator,
  handler: guarded(internal.setHighlightThreadMembership),
});

function guarded<Args extends { readonly libraryId: string }, Result>(target: FunctionReference<"mutation", "internal", Args, Result>) {
  return async (ctx: GenericMutationCtx<DataModel>, args: Args): Promise<Result> => {
    await requireLibraryAccess(ctx, args.libraryId, "write");
    return ctx.runMutation(target as never, args as never) as Promise<Result>;
  };
}
function reference<Args extends Record<string, unknown>, Result>(name: string): FunctionReference<"mutation", "internal", Args, Result> {
  return makeFunctionReference<"mutation", Args, Result>(name) as unknown as FunctionReference<"mutation", "internal", Args, Result>;
}
