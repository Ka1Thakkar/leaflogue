import type { BookId, HighlightId } from "@leaflogue/contracts";
import { chooseDailyHighlightId, resolveLocalDay, type DailyCandidate } from "@leaflogue/domain";
import type { DataModelFromSchemaDefinition, DocumentByName, GenericMutationCtx, MutationBuilder } from "convex/server";
import { internalMutationGeneric } from "convex/server";
import { dailySelectionValidator, ensureDailySelectionArgs } from "./dailyContracts";
import schema from "./schema";
import { claimWebWrites } from "./webWrites";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type MutationContext = GenericMutationCtx<DataModel>;
type Library = DocumentByName<DataModel, "libraries">;
type DailySelectionDocument = DocumentByName<DataModel, "dailySelections">;
const internalMutation = internalMutationGeneric as MutationBuilder<DataModel, "internal">;
const MAX_DAILY_HIGHLIGHTS = 2_000;
const MAX_DAILY_BOOKS = 500;

export const ensureDailySelection = internalMutation({
  args: ensureDailySelectionArgs,
  returns: dailySelectionValidator,
  handler: async (ctx, args) => {
    const requestedId = requiredId(args.id);
    const now = Date.now();
    const { localDay, timezone } = resolveLocalDay(args.timezone, now);
    const [library, candidateRows, existing, pendingMigration, blockedProjection] = await Promise.all([
      requireLibrary(ctx, args.libraryId),
      ctx.db.query("dailyCandidates")
        .withIndex("by_library_active_book_and_highlight", (q) => q.eq("libraryId", args.libraryId).eq("bookActive", true))
        .take(MAX_DAILY_HIGHLIGHTS + 1),
      findSelection(ctx, args.libraryId, localDay, timezone),
      ctx.db.query("highlights")
        .withIndex("by_library_candidate_ready_and_id", (q) => q.eq("libraryId", args.libraryId).eq("dailyCandidateReady", undefined))
        .first(),
      ctx.db.query("dailyProjectionBlocks").withIndex("by_library", (q) => q.eq("libraryId", args.libraryId)).first(),
    ]);
    if (pendingMigration) throw new Error("Run the daily-candidate migration before selecting a daily highlight");
    if (blockedProjection) throw new Error("Repair the daily-candidate projection before selecting a daily highlight");
    if (candidateRows.length > MAX_DAILY_HIGHLIGHTS) throw new Error("Library is too large for Convex daily selection");
    const bookIds = new Set(candidateRows.map((candidate) => candidate.bookId));
    if (bookIds.size > MAX_DAILY_BOOKS) throw new Error("Library is too large for daily selection");
    const candidates: DailyCandidate[] = candidateRows.map((candidate) => ({
      id: candidate.highlightId as HighlightId,
      bookId: candidate.bookId as BookId,
    }));
    const candidateDigest = await digest(candidates);
    const currentIsEligible = existing?.highlightId !== undefined && candidates.some(({ id }) => id === existing.highlightId);
    const hasAlternative = existing?.highlightId !== undefined && candidates.some(({ id }) => id !== existing.highlightId);
    const emptySelectionIsCurrent = existing !== null && existing.highlightId === undefined &&
      candidates.length === 0 && existing.candidateDigest === candidateDigest;
    if (existing && (emptySelectionIsCurrent || (currentIsEligible && (!args.another || !hasAlternative)))) return mapSelection(existing);

    let previous: DailySelectionDocument | undefined = existing ?? undefined;
    if (!previous) {
      previous = await ctx.db.query("dailySelections")
        .withIndex("by_library_timezone_and_day", (q) => q.eq("libraryId", args.libraryId).eq("timezone", timezone))
        .order("desc")
        .first() ?? undefined;
    }
    const recent = previous?.recentHighlightIds ?? [];
    const revision = (existing?.revision ?? 0) + 1;
    const selectedId = chooseDailyHighlightId(candidates, recent as HighlightId[], existing?.highlightId as HighlightId | undefined, {
      localDay, timezone, candidateDigest, revision,
    });
    const nextRecent = selectedId
      ? [...recent.filter((id) => id !== selectedId), selectedId].slice(-7)
      : recent.slice(-7);
    let selection: DailySelectionDocument;
    if (existing) {
      await ctx.db.patch(existing._id, {
        highlightId: selectedId, candidateDigest, recentHighlightIds: nextRecent,
        selectedAt: now, updatedAt: now, revision,
      });
      selection = { ...existing, highlightId: selectedId, candidateDigest, recentHighlightIds: nextRecent, selectedAt: now, updatedAt: now, revision };
    } else {
      const idConflict = await ctx.db.query("dailySelections")
        .withIndex("by_library_and_id", (q) => q.eq("libraryId", args.libraryId).eq("id", requestedId))
        .unique();
      if (idConflict) throw new Error("Entity ID already exists with different daily selection data");
      const documentId = await ctx.db.insert("dailySelections", {
        libraryId: args.libraryId, id: requestedId, localDay, timezone, ...(selectedId ? { highlightId: selectedId } : {}),
        candidateDigest, recentHighlightIds: nextRecent, selectedAt: now, updatedAt: now, revision: 1, createdAt: now,
      });
      const inserted = await ctx.db.get(documentId);
      if (!inserted) throw new Error("Daily selection could not be created");
      selection = inserted;
    }
    await recordChange(ctx, library, selection.id, selection.revision, now);
    return mapSelection(selection);
  },
});

async function digest(candidates: readonly DailyCandidate[]): Promise<string> {
  const payload = JSON.stringify(candidates.map(({ id, bookId }) => [id, bookId]));
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
async function recordChange(ctx: MutationContext, library: Library, id: string, revision: number, now: number): Promise<void> {
  const sequence = library.nextChangeSequence + 1;
  await ctx.db.insert("syncChanges", { libraryId: library.externalId, sequence, entityType: "daily-selection", entityId: id, revision, changedAt: now });
  await ctx.db.patch(library._id, { nextChangeSequence: sequence, updatedAt: now });
  await claimWebWrites(ctx, library.externalId, [{ entityType: "daily-selection", entityId: id }], now);
}
function requireLibrary(ctx: MutationContext, libraryId: string) { return ctx.db.query("libraries").withIndex("by_external_id", (q) => q.eq("externalId", libraryId)).unique().then((value) => { if (!value) throw new Error("Library no longer exists"); return value; }); }
function findSelection(ctx: MutationContext, libraryId: string, localDay: string, timezone: string) { return ctx.db.query("dailySelections").withIndex("by_library_day_and_timezone", (q) => q.eq("libraryId", libraryId).eq("localDay", localDay).eq("timezone", timezone)).unique(); }
function mapSelection(value: DailySelectionDocument) { return { id: value.id, localDay: value.localDay, timezone: value.timezone, ...(value.highlightId ? { highlightId: value.highlightId } : {}), candidateDigest: value.candidateDigest, recentHighlightIds: value.recentHighlightIds, selectedAt: value.selectedAt, updatedAt: value.updatedAt, revision: value.revision }; }
function requiredId(value: string) { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) throw new Error("Entity ID is invalid"); return value; }
