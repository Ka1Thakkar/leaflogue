---
title: 0.1.0 preview notes
description: What the first preview includes, what is still being validated, and where to get it.
---

**Release status: candidate preparation.** `0.1.0` is being prepared as the
first public desktop beta for Linux, macOS, and Windows. A candidate build is not a completed support or
security validation, and a draft GitHub release is not a stable update feed.
The final download will be linked from the
[Releases page](https://github.com/Ka1Thakkar/leaflogue/releases).

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

## Agents in 0.1.0; reading in 0.1.1

**0.1.0:** an opt-in local MCP server for agents to search passages, inspect
books and notes, and explore threads with source details for citations. The
first version is read-only. It is implemented in the beta source; final native candidate validation
remains required before release. Read the [agent setup guide](/ai/mcp/). A connected cloud agent may receive the
passages returned to it; local operation does not keep those responses on-device.

**0.1.1:** a desktop EPUB reader with highlights and notes shared with the rest
of the library, reading position, “Read in context,” optional book-file sync,
offline downloads, and reviewed matching of imported highlights. Files will
remain local unless the user explicitly enables their sync. These are planned
features, not capabilities of the current build. PDFs and external-reader
write-back follow separately.

## Downloads and compatibility

Linux builds target x64 and arm64 as AppImage and tarball packages. Mac builds
target Apple Silicon and Intel as DMG and ZIP; Windows builds target x64 as a
per-user installer and ZIP.
The release carries the matching Convex backend bundle, checksums, dependency
audit, SBOM, and build metadata. The final AppImage release also carries its
signed stable update manifests.

The first release uses local SQLite schema **17**, PostgreSQL schema **13**,
and Convex schema **17**, mutation contract **23**. The desktop accepts Convex
contracts **22–23**. Update desktops before updating a deployment to contract
23. Back up a development library before opening it with a release build.

## Validation still to complete

The maintainer has not yet recorded the clean Linux desktop workflow,
including an Orca screen-reader pass and ARM64 launch/import/backup/restore.
These remain release gates. Automated tests and container runs are recorded
separately and do not replace those checks.

Mac and Windows are part of the beta target. Their native CI and clean-machine
checks must pass before publication. Current Mac candidate packages are ad-hoc
signed without notarization; Windows candidates are unsigned. The maintainer approved this signing status for the public beta;
clean-machine checks must still record the resulting OS prompts. There is no Flathub listing yet.
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

The complete development history is in the
[changelog](https://github.com/Ka1Thakkar/leaflogue/blob/main/CHANGELOG.md).
