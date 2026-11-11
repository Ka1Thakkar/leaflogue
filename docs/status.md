# Project status

Leaflogue 0.1.0-beta.3 is the update-enabled experimental desktop beta in preparation.
Automated checks pass; clean-desktop and actual screen-reader acceptance remain
pending. The maintainer explicitly approved experimental publication with
these limitations disclosed on 10 November 2026.
It includes local SQLite storage, reviewed e-reader imports, shared passages
and notes, optional PostgreSQL/Convex sync, a self-hosted web client, an offline
English dictionary, and opt-in read-only agent access through local MCP.

Linux x64/ARM64, Mac Apple Silicon/Intel, and Windows x64 are beta targets.
Mac builds are ad-hoc signed without notarization; Windows builds are unsigned.
Consult [release readiness](release-readiness.md) for the exact validation status.

The [roadmap](roadmap.md) assigns EPUB reading and optional book-file sync to
0.1.1. See [CONTRIBUTING](../CONTRIBUTING.md) to help with code, documentation,
import formats, accessibility, and native testing.

The updater verifies separately signed beta manifests and exact artifact hashes
before installation. Standard Mac bundles, per-user Windows installer builds,
and Linux AppImages can install and restart from the app; portable Windows
ZIP/Linux tarballs remain manual. The earlier beta.1 candidate was not published.
