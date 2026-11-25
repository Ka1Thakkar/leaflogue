# Independent book-review imports

Local work branch: feat/book-review-imports, from origin/develop at 99d3dbb.
This feature does not depend on multimedia or change the multimedia branch.

## Owner direction

Reuse existing import parsing, ImportDocument, preview/source selection,
transactional reconciliation, source provenance, conflict review and status history.
Goodreads reviews become standalone book notes, never fake highlighted quotations.
StoryGraph remains pending a representative export/schema fixture; the owner has
no StoryGraph account. Do not promise compatibility from a guessed CSV format.
The owner supplied a Goodreads export with one to-read book and no reviews. Keep
it outside Git and test a copy.

## First implementation slice

1. Verify actual Goodreads columns and encoding from the owner's export. Retain
   synthetic fixtures in Git, with multiline/quoted/Unicode content and empty fields.
2. Add a shared bounded CSV reader only if no existing suitable helper is present.
   Keep provider-specific header, identity, review and shelf mapping in adapters.
3. Emit ImportDocument for existing canonical storage. Preserve stable external IDs
   so repeated imports update the same source annotation. Do not hash review text
   as its identity: edited reviews must update rather than duplicate notes.
4. Confirm read/currently-reading/to-read mapping against the real file. Unmapped
   states, dates, ratings, private notes and custom shelves must be surfaced rather
   than silently reinterpreted; ratings are not selected feature scope.
5. Extend the shared provider contract and all current desktop/web/server/Convex
   provider validation and source labels. Reuse Import UI and commit/replay paths.
6. Verify edited/deleted-source reviews and local edits through existing conflict
   handling; never erase a locally edited note on a changed reimport.

## Source map

- packages/importers/src/common.ts: budgets, dates, hashing and warnings.
- packages/importers/src/portable.ts and index.ts: existing parsing contract.
- packages/contracts/src/index.ts: ImportBook, ImportAnnotation, ImportProvider.
- apps/desktop/src/main/index.ts: file selection/detection and source names.
- apps/web/src/import/files.ts: browser file selection/parser adapters.
- apps/desktop/src/renderer/src/components/Imports.tsx: shared preview/source UI.
- apps/web/src/bridge/imports.ts, apps/server/src/imports.ts,
  convex/importRuntime.ts: hosted import transport and provider validation.
- packages/storage/src/index.ts: canonical import and provenance reconciliation.

No schema change is assumed yet. Provider enums, status-source constraints,
portable exports and existing source identity rules must be checked before calling
this a parser-only change. Test both SQLite and supported hosted import paths.

## Tests

All tests HEADLESS. Unit parser fixtures plus import/reimport/conflict integration
checks, source selection and rejected input tests. Include CSV byte/row/column/cell
bounds, BOM, CRLF, quoted commas/newlines/escaped quotes, malformed/truncated CSV,
unknown headers and spreadsheet-style ISBNs without executing formulas. Personal
exports and real library data remain outside source control. No production provider
connection or change to the installed Mac library is permitted.

Status: Goodreads implementation added. The supplied real export has 23 columns,
one to-read book and no review; parsed it and verified canonical import/replay in
a temporary clone of the isolated actual-library baseline. Personal CSV/data are
not committed. Synthetic fixtures cover review notes, edits/conflicts, CSV quoting,
Unicode, limits and browser parsing. No database schema change is required for this
slice. Existing book statuses are preserved on linked reimports. Exported dates,
ratings/private notes/custom shelves/additional authors remain excluded with visible
preview warnings; StoryGraph still awaits a verified representative fixture.
