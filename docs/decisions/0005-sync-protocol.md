# ADR 0005: the sync protocol between a desktop library and its provider

Status: accepted on 25 September 2026 by the maintainer, who asked for whichever
rule serves the reader best; the concurrency policy below is the answer to that
question rather than the simplest rule to implement.

## Context

Phase 3 has built the pieces either side of the wire and nothing across it. A
local library records every reading-data mutation in a `sync_outbox` row inside
the same transaction, holds a durable device identity and remote cursor, and can
acknowledge operations atomically. `deliverPendingSyncChanges` reads a bounded
page from that outbox and hands it to a `SyncTransport`. Ordered change pages,
canonical `deviceId:sequence` operation identities, cursor-generation resets, and
acknowledgement validation are all defined and tested.

What does not exist is the transport itself, and the reason is a decision rather
than missing code. An outbox row carries an identity — entity type, entity id,
revision, operation — and no payload, so a transport must read the entity before
it can send anything. On the far side, the mutations both providers already
expose are the *interactive* ones: `updateBookMetadata`, `createNote`,
`deleteHighlight`, each guarded by `expectedRevision` against the row the
provider holds. Those guards are correct for a single writer editing through the
application, and wrong for replaying another device's history, where the local
revision counts that device's edits and the remote revision counts everyone's.
Feeding a synced change through them would reject every edit made while two
devices were both active, which is the normal case rather than the exception.

## Decision

**The outbox is a to-do list, not a log.** A transport resolves each entry to the
entity's *current* local state at the moment it sends, not to the state as of the
recorded revision. Several queued edits to one entity therefore collapse into one
transmission of the latest state, and an entry whose entity has moved on is not
stale work to discard — it is the same work, now cheaper. The recorded revision
stays in the entry as the causal marker the provider compares against; it is not
a reason to send an older body.

**Operations are acknowledged by identity, never by content.** The idempotency
key remains `deviceId:sequence`. A provider that has already applied an operation
acknowledges it again without reapplying, so a retry after an interrupted
response is safe. `assertSyncAcknowledgement` already permits acknowledging a
prefix of what was submitted, and transports use that: on the first failure they
stop, acknowledge what landed, and leave the rest pending, so ordering within a
device is preserved and no gap is skipped.

**Each provider gains a separate synced-write entry point.** `applySyncedChange`
takes the entity state, the originating device, and that device's revision, and
is not guarded by `expectedRevision`. Ordering is by (revision, device): every
replica evaluates the same comparison over the same rows, so they converge on the
same winner without a shared clock, and a repeated delivery loses to the row it
already wrote. The interactive mutations keep their optimistic guards and remain
what the application itself calls; sync never borrows them.

**What happens to the loser depends on whether the reader can get it back.**
Applying one rule to every entity would be either careless or exhausting, so the
rule follows the cost of being wrong rather than the shape of the data.

Most entities take the winner silently: book metadata, reading status, archive
state, collection and tag membership, thread membership, and the daily
selection. Losing one of these costs the reader seconds — the title is retyped,
the tag reapplied, the status set again — and much of it can be recovered from
the import source that supplied it. Asking someone to adjudicate a race over
which device last marked a book finished would be a worse product than quietly
picking one.

A note's body and a passage's text never disappear silently. They are the
reader's own writing, and the entire point of the application; a lost paragraph
is not recoverable from anywhere, and the reader has no way to know it existed.
When a losing change carries a body that differs from the winner's, that body is
kept as a conflict for review rather than discarded. The same applies when a
tombstone races an edit: the deletion wins, because deleting is deliberate, but
any note body that would vanish with it is preserved for review first.

This keeps the review surface small enough to be worth having. Concurrent edits
to the *same* note on two devices inside one offline window are rare — most
reading generates new highlights and new notes, which carry distinct identities
and cannot collide — so conflicts stay exceptional while the guarantee behind
them is absolute: sync never silently destroys something the reader wrote.

**Pulling reuses the same shape in reverse.** The desktop applies an incoming
page inside one transaction per change, writing the entity and advancing the
cursor together, and applying an incoming change never appends to the outbox —
otherwise two devices would trade the same edit forever. A `resetRequired` page
means the local cursor no longer names the provider's exact history position,
and the desktop rebuilds from a bounded snapshot rather than guessing what it
missed. PostgreSQL binds sequence zero and every change to immutable tokens;
the runner verifies the stored token before any push, so a restored database
cannot masquerade as the old history merely by reaching the same sequence.

**Deletion stays a tombstone** on both sides, as it already is locally, so a
deletion propagates like any other change and a device that was offline learns
about it rather than resurrecting the row.

Provider tombstones are explicit even when that provider never saw the live
row. PostgreSQL keeps these in `sync_tombstones`; otherwise a deletion delivered
before its upsert would own the writer claim but emit no pullable state. Losing
passage and note bodies are deduplicated in `sync_conflicts` by their causal
identity and content fingerprint. Older revisions from the same device are
causal history, not conflicts. PostgreSQL keeps at most 20 pending conflicts per
entity and refuses an over-limit body or queue in the same transaction as the
claim, preserving both sides instead of partially applying it. Those persistence
records are not permission to expose sync yet: pull/application and the
conflict-review surface remain separate required slices.

## Consequences

- Both providers need `applySyncedChange` and the per-device revision bookkeeping
  it compares against, which is new state in PostgreSQL and Convex. Convex also
  needs its mutation contract version raised when it lands.
- The local library needs an apply-incoming path with the same conflict outcome,
  and it must be reachable without appending to the outbox. The existing import
  conflict machinery is the closest model and is deliberately separate: an import
  conflict is between a reader's edit and a file, a sync conflict is between two
  devices.
- Conflicts become a product surface, not only a data structure. Phase 3 already
  requires conflict review before sync is exposed; restricting conflicts to the
  reader's own writing is what keeps that surface small enough to review by hand.
- The split has to be explicit per entity rather than inferred, so each synced
  entity declares whether its loser is discardable or must be preserved. A new
  synced field is therefore a decision, not a default.
- Book metadata, status, archive state, and membership need no conflict storage,
  so the PostgreSQL book path built against this ADR is already correct and does
  not change. Notes and passages need the preserving path before they sync.
- Sending latest-state means a transport reads the local library while delivering.
  It therefore runs in the main process beside the database, never in the
  renderer, and the renderer continues to see no paths, credentials, or SQL.
- Convex sync stays gated on the legacy attached-note migration already recorded
  in the roadmap; PostgreSQL has no equivalent gate.
