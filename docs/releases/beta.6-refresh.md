# Existing beta.6 release refresh

Owner direction, 25 November 2026: Goodreads import and local web-article capture
should merge into develop, then be included when refreshing the existing release.
Do not create a new release or bump the version solely for these features.

Target: the existing published prerelease v0.1.1-beta.6. This document records
scope and gates, not publication approval or a claim that downloads contain it.

Included changes: Goodreads CSV books/reviews through the canonical importer;
public HTTPS article preview/confirm/save through the shared local reader; the
reader and performance fixes already on develop, and the shared-boundary
refactor recorded in ADR 0009 (SQLite migration 21, current backend protocol). StoryGraph is deferred until a
verified representative export exists. Multimedia implementation remains separate.

Before refreshing downloads:

- Complete feature/develop CI and integrated local acceptance on an isolated
  SQLite library. Never connect the test profile to production Convex.
- Complete the authorized develop-to-main integration and native release checks.
- Build the complete platform/backend/web set from one declared source commit.
  Regenerate checksums, build inputs, audits, notices and signed update manifests.
  Do not replace only the DMG while leaving mismatched archives or signatures.
- Document source provenance and source/tag alignment explicitly. Do not silently
  move a published tag, claim an old source archive matches new binaries, or
  overwrite published assets merely because code was merged into develop.
- Update the existing release notes to distinguish refreshed downloads from the
  previous beta.6 builds. The updater compares versions; an equal-version rebuild
  does not trigger an automatic update. Existing users must reinstall refreshed
  downloads unless a separately reviewed update mechanism is introduced.

The current published downloads and production deployments remain unchanged until
that release refresh is deliberately performed. The shared-boundary refactor
requires SQLite schema 21 to retire the deferred-colour journal without losing
intent. Existing-library migration checks still apply. Captured article bodies
remain outside normal sync/backups.
