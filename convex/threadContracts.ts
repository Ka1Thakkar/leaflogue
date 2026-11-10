import { v } from "convex/values";

export const createThreadArgs = {
  libraryId: v.string(), id: v.string(), name: v.string(), description: v.optional(v.string()),
};
export const updateThreadArgs = { ...createThreadArgs, expectedRevision: v.number() };
export const deleteThreadArgs = { libraryId: v.string(), id: v.string(), expectedRevision: v.number() };
export const setHighlightThreadMembershipArgs = {
  libraryId: v.string(), bookId: v.string(), highlightId: v.string(),
  threadIds: v.array(v.string()), expectedHighlightRevision: v.number(),
};

export const threadValidator = v.object({
  id: v.string(), name: v.string(), description: v.optional(v.string()), passageCount: v.number(),
  createdAt: v.number(), updatedAt: v.number(), revision: v.number(),
});
export const threadMembershipValidator = v.object({
  changed: v.boolean(), bookId: v.string(), highlightId: v.string(),
  highlightRevision: v.number(), threadIds: v.array(v.string()),
});

export type CreateThreadArgs = { readonly libraryId: string; readonly id: string; readonly name: string; readonly description?: string };
export type UpdateThreadArgs = CreateThreadArgs & { readonly expectedRevision: number };
export type DeleteThreadArgs = { readonly libraryId: string; readonly id: string; readonly expectedRevision: number };
export type SetHighlightThreadMembershipArgs = {
  readonly libraryId: string; readonly bookId: string; readonly highlightId: string;
  readonly threadIds: readonly string[]; readonly expectedHighlightRevision: number;
};
export interface ThreadResult {
  readonly id: string; readonly name: string; readonly description?: string; readonly passageCount: number;
  readonly createdAt: number; readonly updatedAt: number; readonly revision: number;
}
export interface ThreadMembershipResult {
  readonly changed: boolean; readonly bookId: string; readonly highlightId: string;
  readonly highlightRevision: number; readonly threadIds: string[];
}
