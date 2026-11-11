---
title: How sync works
description: Share one library between computers using a database you run yourself.
---

Sync is optional. Without it, Leaflogue keeps everything on one computer and
makes no sync requests. With it, several computers share one library
through a database **you** set up and control. There is no Leaflogue server
and no Leaflogue account.



## Choose a database

| | [Convex](/sync/convex/) | [PostgreSQL](/sync/postgresql/) |
| --- | --- | --- |
| What it is | A hosted database service | A database server you run or rent |
| You need | Your Convex account and a few commands | A PostgreSQL 16+ server reachable over TLS |
| Good for | Most people who want sync without running a server | People who already run PostgreSQL |

## What happens when you sync

- **Your computer always has the whole library.** Leaflogue keeps working
  offline; changes wait on this computer until the next sync.
- **Sync runs by itself when Leaflogue opens.** After that, choose the refresh
  button at the top of the window, or **Sync now** in Settings, whenever you
  want to catch up. A large sync keeps going until it is finished.
- **The top of the window shows where sync stands:** syncing, synced, paused,
  or failed. Hover over it for details, or select it to open the sync
  settings. When a sync brings in changes, the page you are on refreshes to
  show them.
- **Everything syncs:** books and their reading history, passages, notes,
  tags, collections, threads, and the daily highlight.
- **Nothing is lost when two computers disagree.** If the same thing changed
  on both, one version wins on every computer and the other is kept for you to
  [review](/sync/conflicts/). If one computer deleted something the other
  edited, the deletion wins and the edit is kept for review.
- If two computers picked a different daily highlight while offline, the one
  picked first is kept everywhere.

## Who can see your library

Anyone with your database credentials (the PostgreSQL URL, or the Convex sync
key) can read and change your library. Keep them like a password.


## Follow sync progress

Starting in **0.1.1-beta.2**, Settings shows live progress in **Settings → Sync → Remote library**,
including connecting/preparing, sending changes, receiving changes, sent and
received counts, and how many local edits remain queued. Background sync from
the header uses the same status. A finished run keeps its result and finish time.

The remote service does not provide a reliable total, so receiving uses an
activity indicator and a running count rather than a percentage. Counters
continue across batches; a failed sync reports its completed work and leaves
unsent changes queued for the next attempt.
