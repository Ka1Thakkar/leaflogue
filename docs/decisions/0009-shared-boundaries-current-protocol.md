# Shared boundaries and current runtime protocols

Status: accepted for the combined Goodreads/article change.

## Decision

Use adapters and shared policies at actual variation points across the project.
Keep storage transactions, host capabilities and rendering concerns separate.
There are no public users requiring old client protocols. Preserve database
migration history and existing library data; retire old runtime protocols rather
than maintaining degraded feature modes.

## Audit and resulting boundaries

| Area | Shared boundary | Result |
| --- | --- | --- |
| Desktop and browser UI | `LeaflogueBridge`, shared React components and UI package | Keep host adapters; rename the generic source API to `reader`, including IPC. |
| EPUB, PDF and articles | `ReaderDocument`, `ReaderStore`, parser registry | Parsers adapt bytes; one attachment, position, bookmark and annotation pipeline. Every document identifies its format. EPUB archive parsing stays separate from storage. |
| Imports | Parser adapters, shared domain reconciliation, import provenance | Goodreads follows the existing pipeline. Provider IDs, names and source naming are declared once in contracts and consumed by desktop, browser, PostgreSQL server and Convex. |
| Sync | `SyncTransport`, change/bootstrap sources, ledger and runner | Keep provider adapters and one durable exchange algorithm. Require Convex contract 24/schema 17; remove contract 22/23 projections and partial-success colour messaging. |
| Persistence | `LibraryRepository`, shared domain normalization and policies | Keep SQLite, PostgreSQL and Convex transaction implementations. Their SQL/index/transaction semantics differ; do not invent a generic database interpreter. |
| AI | Provider adapters and the `@leaflogue/ai` catalog/tasks | Share IDs, names, presets and prompt limits. Import AI directly; remove the remote package's ownership-obscuring re-export. |
| Public resource retrieval | DNS-pinned `public-resource-fetch` adapter | Covers and articles use the same public-address policy; delete the cover-only compatibility alias. Extraction remains an isolated worker behind injected ports. |
| Highlight display | Shared DB record and theme palette | Delete localStorage colour migration/fallback. Keep one palette observer/cache for all visible passages, rather than one observer per passage. |
| Hosted highlight queries | Exact millisecond bounds | Remove browser fallback retries and server UTC-day aliases. Preserve paging, local-day/DST boundaries and explicit errors. |

The application composition root wires adapters. It need not add a class or
factory for every function. A multimedia factory can later choose real
medium-specific policies through the same approach; this change does not build
speculative multimedia entities or a second reader/import/sync pipeline.

## Removed compatibility and upgrade behavior

- Old `epub` bridge/types/store aliases are removed; rebuild renderer and main
  together. Persisted `epub:` annotation coordinates remain the current EPUB
  format, not a deprecated client protocol. Existing reader sidecar paths stay
  unchanged, preserving attachments, positions, bookmarks and reviewed anchors.
- SQLite migration 21 bumps affected live highlights' revisions so the normal
  outbox replays formerly acknowledged colour-less projections, then drops
  `sync_deferred_colours`. Current highlight state wins over older journal
  values. Deleted highlights are not resurrected. Historical migrations remain.
- Convex migrations and the migration barrier remain. Incompatible deployments
  fail before provisioning or exchange and get version-update guidance. No
  transport strips colours, threads or reading history to fit an old backend.
- Old display-preference and highlight-colour localStorage keys are ignored.
  Current preference validation and corrupt-state recovery remain.
- Signed update manifests must be format 2. Detached signature envelopes are
  still format 1, their current independent protocol. Signing and integrity
  checks remain mandatory.
- Old configuration relocation is removed. Database relocation, coherent WAL
  snapshots, device identity and interrupted database-restore recovery remain.
- Persisted Calibre references must name their format; old references without
  it need to be linked again. A new Calibre link may still default to EPUB as a
  UI convenience.

Supported external device export formats and OpenAI-compatible endpoints are
product features, not old Leaflogue protocols. They remain supported. Import
identity stability prevents duplicate annotations in existing SQLite libraries.

## Data and release implications

Migration 21 runs locally on library open; it changes revisions/outbox entries
only for journaled live highlights and removes the obsolete journal. Database
backups from before upgrade remain useful. An older build must not open a newer
schema; rollback requires restoring its matching backup. No migration resets
or rewrites the library's IDs, notes or provenance.

Run automated checks headless, including migration, provenance, conflicts,
two-device sync and EPUB/PDF/article reader regression checks. Personal data may
only be tested on an isolated SQLite copy without production Convex credentials.

Ship in the existing feature PR targeting develop, including Goodreads and web
articles. Existing beta.6 release preparation remains governed by
`docs/releases/beta.6-refresh.md`; merging develop does not publish new assets.
