import type { DataModelFromSchemaDefinition, FunctionReference, GenericMutationCtx, MutationBuilder } from "convex/server";
import { makeFunctionReference, mutationGeneric } from "convex/server";
import { requireLibraryAccess } from "./accessControl";
import {
  collectionValidator,
  createCollectionArgs,
  createTagArgs,
  deleteCollectionArgs,
  deleteTagArgs,
  membershipValidator,
  setBookCollectionMembershipArgs,
  setBookTagMembershipArgs,
  setHighlightTagMembershipArgs,
  tagValidator,
  updateCollectionArgs,
  updateTagArgs,
  type CollectionResult,
  type CreateCollectionArgs,
  type CreateTagArgs,
  type DeleteCollectionArgs,
  type DeleteTagArgs,
  type MembershipResult,
  type SetBookCollectionMembershipArgs,
  type SetBookTagMembershipArgs,
  type SetHighlightTagMembershipArgs,
  type TagResult,
  type UpdateCollectionArgs,
  type UpdateTagArgs,
} from "./organizationContracts";
import schema from "./schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
const mutation = mutationGeneric as MutationBuilder<DataModel, "public">;
const internal = {
  createCollection: reference<CreateCollectionArgs, CollectionResult>("organization:createCollection"),
  updateCollection: reference<UpdateCollectionArgs, CollectionResult>("organization:updateCollection"),
  deleteCollection: reference<DeleteCollectionArgs, null>("organization:deleteCollection"),
  createTag: reference<CreateTagArgs, TagResult>("organization:createTag"),
  updateTag: reference<UpdateTagArgs, TagResult>("organization:updateTag"),
  deleteTag: reference<DeleteTagArgs, null>("organization:deleteTag"),
  setBookCollectionMembership: reference<SetBookCollectionMembershipArgs, MembershipResult>("organization:setBookCollectionMembership"),
  setBookTagMembership: reference<SetBookTagMembershipArgs, MembershipResult>("organization:setBookTagMembership"),
  setHighlightTagMembership: reference<SetHighlightTagMembershipArgs, MembershipResult>("organization:setHighlightTagMembership"),
};

export const createCollection = mutation({ args: createCollectionArgs, returns: collectionValidator, handler: guarded(internal.createCollection) });
export const updateCollection = mutation({ args: updateCollectionArgs, returns: collectionValidator, handler: guarded(internal.updateCollection) });
export const deleteCollection = mutation({ args: deleteCollectionArgs, handler: guarded(internal.deleteCollection) });
export const createTag = mutation({ args: createTagArgs, returns: tagValidator, handler: guarded(internal.createTag) });
export const updateTag = mutation({ args: updateTagArgs, returns: tagValidator, handler: guarded(internal.updateTag) });
export const deleteTag = mutation({ args: deleteTagArgs, handler: guarded(internal.deleteTag) });
export const setBookCollectionMembership = mutation({ args: setBookCollectionMembershipArgs, returns: membershipValidator, handler: guarded(internal.setBookCollectionMembership) });
export const setBookTagMembership = mutation({ args: setBookTagMembershipArgs, returns: membershipValidator, handler: guarded(internal.setBookTagMembership) });
export const setHighlightTagMembership = mutation({ args: setHighlightTagMembershipArgs, returns: membershipValidator, handler: guarded(internal.setHighlightTagMembership) });

function guarded<Args extends { readonly libraryId: string }, Result>(target: FunctionReference<"mutation", "internal", Args, Result>) {
  return async (ctx: GenericMutationCtx<DataModel>, args: Args): Promise<Result> => {
    await requireLibraryAccess(ctx, args.libraryId, "write");
    return ctx.runMutation(target as never, args as never) as Promise<Result>;
  };
}

function reference<Args extends Record<string, unknown>, Result>(name: string): FunctionReference<"mutation", "internal", Args, Result> {
  return makeFunctionReference<"mutation", Args, Result>(name) as unknown as FunctionReference<"mutation", "internal", Args, Result>;
}
