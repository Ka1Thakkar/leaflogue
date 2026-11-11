---
title: 0.1.1-beta.2 release notes
description: What the reader beta adds, its known limits, and where to get it.
---

**Release status: experimental public beta, `0.1.1-beta.2`.** Automated
source, native package, and MCP checks pass. Clean-desktop installation,
manual updates/uninstall, and actual Orca, VoiceOver, and Narrator checks
remain pending. The maintainer approved experimental publication with these
limitations disclosed. Back up your library before testing.
Download from the [Releases page](https://github.com/Ka1Thakkar/leaflogue/releases/tag/v0.1.1-beta.2).
This prerelease is not a signed stable update feed.

## Included

- A local SQLite library for books, passages, Markdown notes, tags,
  collections, threads, and reading history.
- Reviewed imports from Kobo, Kindle, KOReader, PocketBook/Vivlio, Tolino,
  Boox, and Leaflogue JSON. Importing the same source again reconciles changes.
- Library and book dashboards, reading statistics, today's highlight,
  searchable passages, and the command palette.
- An [offline English dictionary](/library/dictionary/) with definitions, parts of
  speech, and synonyms, bundled with the desktop app.
- Built-in light and dark themes, custom themes, and desktop custom widgets.
- SQLite backups and restores, Markdown exports, and JSON exports that can
  be imported into another library.
- Optional Convex or PostgreSQL sync and optional provider-based AI explanations.
- A self-hosted web client for either backend, with allowlisted sign-in and
  browser file import. Desktop-only features are listed in the
  [web guide](/web/overview/#what-is-different).

## Local agent access

**0.1.0:** an opt-in local MCP server for agents to search passages, inspect
books and notes, and explore threads with source details for citations. The
first version is read-only. Source and packaged-client automation passed on Mac, Windows, and Linux x64;
the Linux ARM64 package also passed native ARM64 container checks. Read the [agent setup guide](/ai/mcp/). A connected cloud agent may receive the
passages returned to it; local operation does not keep those responses on-device.

## New in 0.1.1-beta.2

This release adds:

- A paged [desktop EPUB reader](/library/epub/) with remembered position,
  keyboard page turns, and an in-app right-click options overlay.
- [Calibre library linking](/library/calibre/), with a choice of EPUB or KEPUB,
  reading the original file without copies, conversion, or catalogue changes.
- Confirmed highlight creation, notes with margin icons, clickable saved
  highlights, and navigation between a library passage and its EPUB context.
- A resizable right context panel with Reader and Assistant tabs, plus reader
  light/dark mode and optional theme-colour mapping.
- Google Books search as you type in Add book, with Open Library fallback
  and manual entry.
- Reviewed existing-book destinations when importing on a synced computer,
  preventing duplicate books when that device lacks local import history.
  Exact unique highlights and imported notes are reattached to the same records.
- Live sync phases, sent/received counts, and queued edits in Settings.

The earlier 0.1.1-beta.1 candidate was not published. This beta includes the
cross-device Kobo import fix. Earlier duplicate copies remain for review;
this release does not remove them automatically.

EPUB files, local links, Calibre connections, and reading positions stay on
this device. SQLite backups and library exports do not include them; back up
your original files and reader sidecars separately. Library highlights and
notes continue to use normal sync. See [the reader guide](/library/epub/).

Book-file sync, cross-device reading positions, PDFs, DRM, fixed-layout
fidelity, audio/video, and Calibre write-back are not included. Book search,
bookmarks, direct AI actions on reader selections, and richer ambiguous-match
review remain follow-ups. Further scope is tracked in the
[development roadmap](https://github.com/Ka1Thakkar/leaflogue/blob/main/docs/roadmap.md).

## Downloads and compatibility

Linux builds target x64 and arm64 as AppImage and tarball packages. Mac builds
target Apple Silicon and Intel as DMG and ZIP; Windows builds target x64 as a
per-user installer and ZIP.
The release carries the matching Convex backend bundle, checksums, dependency
audit, SBOM, and build metadata. Standard Mac app bundles, Windows installer builds, and Linux AppImages offer
signed beta updates through **Settings → Updates → Install and restart**.
Windows ZIP/Linux tarball copies remain manual. This is a beta feed, not a
stable update channel.

This release retains local SQLite schema **17**, PostgreSQL schema **13**,
and Convex schema **17**, mutation contract **23**. The desktop accepts Convex
contracts **22–23**. Update desktops before updating a deployment to contract
23. Back up a development library before opening it with a release build.

## Validation still to complete

Clean-desktop installation, manual updates/uninstallation, and actual Orca,
VoiceOver, and Narrator checks remain unperformed across the target matrix.
Automated tests and container runs are separate evidence, not human acceptance.
These checks remain required before stable publication.

Mac packages are ad-hoc signed without Apple notarization; Windows packages
are unsigned. OS trust prompts may block installation and have not yet been
recorded on clean machines. The maintainer approved this experimental beta
with those limitations.
Additional reader formats are tested against format fixtures; real-device
coverage varies. If an import does not match your reader's output, report the
format and error without posting your private library or credentials.

## Data and updates

The desktop needs no account. Sync, AI, book lookups, cover downloads, and
update checks use the network only for their documented purpose. Read
[Privacy](/help/privacy/) before enabling optional services.

Existing development builds may need one manual AppImage download before
signed updates are available. An older build may refuse a library written by
a newer schema. Keep a [backup](/library/backups/) before changing versions.

The public development changelog is in the
[changelog](https://github.com/Ka1Thakkar/leaflogue/blob/main/CHANGELOG.md).
