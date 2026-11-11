# Project status

Leaflogue 0.1.1-beta.1 is the experimental desktop reader beta.
Automated checks pass; clean-desktop and actual screen-reader acceptance remain
pending. The maintainer explicitly approved experimental publication with
these limitations disclosed on 10 November 2026.
It includes local SQLite storage, reviewed e-reader imports, shared passages
and notes, optional PostgreSQL/Convex sync, a self-hosted web client, an offline
English dictionary, and opt-in read-only agent access through local MCP.

Linux x64/ARM64, Mac Apple Silicon/Intel, and Windows x64 are beta targets.
Mac builds are ad-hoc signed without notarization; Windows builds are unsigned.
Consult [release readiness](release-readiness.md) for the exact validation status.

The beta includes local EPUB reading, Calibre links without file copies, shared
highlights and notes, and the Reader/Assistant context sidebar. File sync and
cross-device reading positions remain deferred; see the [roadmap](roadmap.md). See [CONTRIBUTING](../CONTRIBUTING.md) to help with code, documentation,
import formats, accessibility, and native testing.

The updater verifies separately signed beta manifests and exact artifact hashes
before installation. Standard Mac bundles, per-user Windows installer builds,
and Linux AppImages can install and restart from the app; portable Windows
ZIP/Linux tarballs remain manual. The earlier beta.1 candidate was not published.
