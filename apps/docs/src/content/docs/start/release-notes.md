---
title: 0.1.0 preview notes
description: What the first preview includes, what is still being validated, and where to get it.
---

**Release status: experimental public beta, `0.1.0-beta.1`.** Automated
source, native package, and MCP checks pass. Clean-desktop installation,
manual updates/uninstall, and actual Orca, VoiceOver, and Narrator checks
remain pending. The maintainer approved experimental publication with these
limitations disclosed. Back up your library before testing.
Download from the [Releases page](https://github.com/Ka1Thakkar/leaflogue/releases/tag/v0.1.0-beta.1).
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

The integrated book reader and book-file sync are not included. Future plans
are tracked in the [development roadmap](https://github.com/Ka1Thakkar/leaflogue/blob/main/docs/roadmap.md).

## Downloads and compatibility

Linux builds target x64 and arm64 as AppImage and tarball packages. Mac builds
target Apple Silicon and Intel as DMG and ZIP; Windows builds target x64 as a
per-user installer and ZIP.
The release carries the matching Convex backend bundle, checksums, dependency
audit, SBOM, and build metadata. This experimental beta uses manual replacement updates; it does not publish
signed stable update manifests.

The first release uses local SQLite schema **17**, PostgreSQL schema **13**,
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
