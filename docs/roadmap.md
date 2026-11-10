# Roadmap

## 0.1.0 — cross-platform beta

Implemented in source:

- Local-first books, passages, Markdown notes, tags, collections and threads.
- Reviewed imports from Kobo, Kindle, KOReader, PocketBook, Tolino and Boox.
- Offline English dictionary, themes, dashboards and reading statistics.
- Backups, restores, JSON and Markdown exports.
- Optional PostgreSQL/Convex sync and a self-hosted browser client.
- Opt-in local read-only MCP, with citations and immediate access revocation.
- Linux x64/ARM64, Mac Apple Silicon/Intel, and Windows x64 packaging.

Release gates, including clean-machine and screen-reader acceptance, are in
[release readiness](release-readiness.md). A passing build is not a completed
native acceptance claim. Beta packages use ad-hoc Mac signatures and unsigned
Windows installers, as documented in [beta validation](beta-desktop-validation.md).

## 0.1.1 — integrated reader

The [reader plan](releases/0.1.1.md) covers DRM-free EPUB attachments, reading
position, highlights and notes shared with the rest of the library, dictionary
and optional AI actions, and return-to-context navigation. It also includes
separate opt-in book-file sync, offline downloads, progress across devices,
and conservative matching of imported highlights against an attached edition.

## Later evaluation

- PDF and other formats, with OCR considered separately.
- Deliberate, visible and undoable MCP writing tools.
- Semantic search if ordinary passage search proves insufficient.
- Metadata-provider expansion and book conversion.
- Writing annotations back to external readers, after format-specific review.

For a substantial change, discuss the scope in an issue before implementation.
