Experimental public beta for Linux x64/ARM64, Mac Apple Silicon/Intel and Windows x64.

### Refreshed downloads — 25 November 2026

The version remains **0.1.1-beta.6**. Existing beta.6 users must reinstall a refreshed download because automatic updates require a newer version.

- Add books and web articles through one **Add to library** flow, retaining drafts when switching types.
- Permanently delete archived library items with confirmation; original files remain on disk and deletions propagate through sync.
- Import Goodreads library CSVs: books, reading status and reviews as book notes, using the existing import reconciliation and conflict handling.
- Capture public HTTPS web articles on desktop with preview and confirmation, then read, highlight and annotate the saved text in the shared reader.
- Reader typography, spacing, layout, appearance and preset controls; reader preferences remain local to the device.
- Shelf paging (60 books per page), library-wide search, themed monochrome PDF pages and pre-painted adjacent pages to prevent page-turn flashes.
- Shared EPUB/PDF/article reader adapters and provider policies; obsolete runtime compatibility paths removed. Highlight colours use the shared library record.

### Existing beta features

Read local PDFs or link EPUB, KEPUB and PDF files from Calibre without copying the original. Selectable-text PDFs share highlights and notes with the book page; scanned pages remain readable without fabricated OCR. Search book text, save local bookmarks, review ambiguous highlight locations and request optional AI explanations. Five semantic highlight colours sync across desktop and hosted web clients. Includes a self-hostable web archive and the matching Convex deployment bundle.

### Compatibility and upgrades

SQLite schema **21**, PostgreSQL schema **14**, Convex schema **17** / mutation contract **24**. This desktop requires the current Convex contract. Update the desktop and deploy its matching backend before syncing. Queued edits remain local until versions match. SQLite migrations preserve library data; migration 21 requeues previously deferred database colour changes through the normal outbox. Old browser-only colour/display preferences are ignored. Calibre references without a format need relinking.

Upgrade guide: https://leaflogue-docs.vercel.app/sync/convex/#upgrading-an-existing-deployment

Article bodies, book files, positions, bookmarks and reviewed locations stay on this device and are outside ordinary sync/database backups/JSON exports. Back up source files and reader sidecars separately. Article capture is desktop-only, text-only and limited to public pages without login cookies. StoryGraph support remains deferred pending a verified export.

### Installation and verification

Refreshed packages are built and tested on their native platforms. Checksums, build inputs, dependency audits and SBOMs accompany the downloads. Five beta update feeds are signed with the application's trusted beta key, and payload hashes and published GitHub digests are independently verified before release notes are updated.

Mac builds are ad-hoc signed and not Apple-notarized. Windows builds are unsigned. Human clean-machine installation, observed OS prompts, manual uninstall and actual screen-reader acceptance remain pending, as disclosed for this experimental beta.

The existing release tag is unchanged. Refreshed binaries use the exact build source linked below; GitHub's automatic source archives still describe the original tag. Use the linked build commit for matching source. No new release or version was created.

Guides: https://leaflogue-docs.vercel.app/
