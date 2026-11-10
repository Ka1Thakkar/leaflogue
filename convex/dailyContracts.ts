import { v } from "convex/values";

export const ensureDailySelectionArgs = {
  libraryId: v.string(), id: v.string(), timezone: v.string(), another: v.optional(v.boolean()),
};
export const dailySelectionValidator = v.object({
  id: v.string(), localDay: v.string(), timezone: v.string(), highlightId: v.optional(v.string()),
  candidateDigest: v.string(), recentHighlightIds: v.array(v.string()), selectedAt: v.number(),
  updatedAt: v.number(), revision: v.number(),
});

export type EnsureDailySelectionArgs = {
  readonly libraryId: string; readonly id: string; readonly timezone: string; readonly another?: boolean;
};
export interface DailySelectionResult {
  readonly id: string; readonly localDay: string; readonly timezone: string; readonly highlightId?: string;
  readonly candidateDigest: string; readonly recentHighlightIds: string[]; readonly selectedAt: number;
  readonly updatedAt: number; readonly revision: number;
}
