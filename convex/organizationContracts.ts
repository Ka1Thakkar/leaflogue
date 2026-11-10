import { v } from "convex/values";

export const createCollectionArgs = {
  libraryId: v.string(), id: v.string(), name: v.string(), description: v.optional(v.string()),
};
export const updateCollectionArgs = { ...createCollectionArgs, expectedRevision: v.number() };
export const deleteCollectionArgs = { libraryId: v.string(), id: v.string(), expectedRevision: v.number() };
export const createTagArgs = {
  libraryId: v.string(), id: v.string(), name: v.string(), color: v.optional(v.string()),
};
export const updateTagArgs = { ...createTagArgs, expectedRevision: v.number() };
export const deleteTagArgs = { libraryId: v.string(), id: v.string(), expectedRevision: v.number() };
export const setBookCollectionMembershipArgs = {
  libraryId: v.string(), bookId: v.string(), collectionId: v.string(), included: v.boolean(),
};
export const setBookTagMembershipArgs = {
  libraryId: v.string(), bookId: v.string(), tagId: v.string(), included: v.boolean(),
};
export const setHighlightTagMembershipArgs = {
  ...setBookTagMembershipArgs, highlightId: v.string(),
};

export const collectionValidator = v.object({
  id: v.string(), name: v.string(), description: v.optional(v.string()), bookCount: v.number(),
  createdAt: v.number(), updatedAt: v.number(), revision: v.number(),
});
export const tagValidator = v.object({
  id: v.string(), name: v.string(), color: v.optional(v.string()), bookCount: v.number(),
  highlightCount: v.number(), createdAt: v.number(), updatedAt: v.number(), revision: v.number(),
});
export const membershipValidator = v.object({
  changed: v.boolean(), included: v.boolean(), bookId: v.string(), bookRevision: v.number(),
  containerId: v.string(), containerRevision: v.number(), highlightId: v.optional(v.string()),
});

export type CreateCollectionArgs = { readonly libraryId: string; readonly id: string; readonly name: string; readonly description?: string };
export type UpdateCollectionArgs = CreateCollectionArgs & { readonly expectedRevision: number };
export type DeleteCollectionArgs = { readonly libraryId: string; readonly id: string; readonly expectedRevision: number };
export type CreateTagArgs = { readonly libraryId: string; readonly id: string; readonly name: string; readonly color?: string };
export type UpdateTagArgs = CreateTagArgs & { readonly expectedRevision: number };
export type DeleteTagArgs = { readonly libraryId: string; readonly id: string; readonly expectedRevision: number };
export type SetBookCollectionMembershipArgs = { readonly libraryId: string; readonly bookId: string; readonly collectionId: string; readonly included: boolean };
export type SetBookTagMembershipArgs = { readonly libraryId: string; readonly bookId: string; readonly tagId: string; readonly included: boolean };
export type SetHighlightTagMembershipArgs = SetBookTagMembershipArgs & { readonly highlightId: string };
export interface CollectionResult { readonly id: string; readonly name: string; readonly description?: string; readonly bookCount: number; readonly createdAt: number; readonly updatedAt: number; readonly revision: number }
export interface TagResult { readonly id: string; readonly name: string; readonly color?: string; readonly bookCount: number; readonly highlightCount: number; readonly createdAt: number; readonly updatedAt: number; readonly revision: number }
export interface MembershipResult { readonly changed: boolean; readonly included: boolean; readonly bookId: string; readonly bookRevision: number; readonly containerId: string; readonly containerRevision: number; readonly highlightId?: string }
