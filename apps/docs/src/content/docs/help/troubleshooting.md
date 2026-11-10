---
title: Troubleshooting
description: Common messages and what to do about them.
---

## Starting Leaflogue

**The AppImage does not open.** Make sure it is executable
(`chmod +x Leaflogue-*.AppImage`). Some distributions also need the FUSE 2
library to run AppImages. Install your distribution's FUSE 2 compatibility
package, or use the tarball instead. Package names differ by distribution
and release.

**Leaflogue says its configuration permissions must be 0600.** Other users can
read your settings file, so Leaflogue refuses to use it. Fix it with:

```sh
chmod 600 ~/.config/leaflogue/config.json
```

## Imports

| Message | What to do |
| --- | --- |
| "Leaflogue could not read that file…" | Check it is one of the files in [where to find your highlights](/library/importing/#or-find-the-file-yourself), then choose a fresh copy from your reader. |
| "Leaflogue found no KOReader or Boox highlights in that folder…" | Choose the reader's drive, the folder your books are in, or the folder holding your Boox exports. |
| "Text file exceeds 16 MiB" | Split the file, or remove old clippings you no longer need. |
| "The import was rolled back. Your library was not changed." | Something went wrong partway; nothing was saved. Try again, and report it if it keeps happening. |
| "Import needs attention" | Some passages changed in both places. Open **Import history** to review them. |

## Backups

| Message | What to do |
| --- | --- |
| "That backup could not be restored. Your current library was kept." | The file is damaged or is not a Leaflogue backup. Try another backup. |
| "Leaflogue could not create that backup." | Choose a folder you can write to, with free space. |

## Sync

See the troubleshooting tables in [Sync with Convex](/sync/convex/#troubleshooting).
Some messages apply to every provider:

| Message | What to do |
| --- | --- |
| "Sync was cancelled. Unsent changes remain queued." | Nothing was lost. Choose **Sync now** again. |
| "Sync paused at its safety limit. Run it again to continue." | Large syncs normally continue on their own, so this means sync stopped making progress. Choose sync again; if the message comes back, [open an issue](https://github.com/Ka1Thakkar/leaflogue/issues). |
| **Sync failed** at the top of the window | Hover over it to read why, then select it to open the sync settings. |
| "Sync stopped before data this version cannot apply. Update Leaflogue and try again." | Another computer runs a newer Leaflogue. Update this one. |
| "Remote PostgreSQL URLs must require TLS…" | Add `?sslmode=require` to the connection URL. |

## AI

| Message | What to do |
| --- | --- |
| "The … model is busy right now. Try again shortly, or choose another model in settings." | The provider is overloaded. Wait a minute, or pick another model in **Settings → Optional AI**. |
| "The … request hit a rate limit" | You reached the provider's limit for now; free tiers allow only a few requests a minute and a set number a day. Wait, or use a paid key. |

## Still stuck?

[Open an issue](https://github.com/Ka1Thakkar/leaflogue/issues) describing
what you did and the exact message. Never include your library, keys, or
database URLs.
