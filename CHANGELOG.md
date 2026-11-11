# Changelog

Notable changes to Leaflogue are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
the policy in [`docs/release-process.md`](docs/release-process.md).

Current experimental beta: `v0.1.1-beta.2`. Release
gates are in [`docs/release-readiness.md`](docs/release-readiness.md).

## 0.1.1-beta.2 — 2026-11-11

- Add a local paged EPUB reader with keyboard navigation, saved position,
  publisher formatting, an in-app options overlay, and dark/theme colours.
- Link Calibre-managed EPUB/KEPUB files read-only and in place, with an explicit
  format choice and no copies or conversion.
- Add confirmed highlight and note creation, clickable annotations and note
  icons, and navigation between library passages and their reader context.
- Add a resizable right context sidebar with Reader and Assistant tabs.
- Search Google Books as you type in Add book, with Open Library fallback.
- Document reader controls, Calibre linking, and local-file backup limits.
- Review matching existing books when importing on a second synced desktop,
  reattaching exact source highlights/notes without duplicating the book.
- Show live sync phases, sent/received counts, and queued edits in Settings.

This is an experimental beta. Original files, local links, and reading positions
are not synced or included in SQLite backups/exports. File sync, PDFs, DRM,
and cross-device positions remain deferred. Manual clean-desktop and actual
screen-reader acceptance remain pending; Mac packages are ad-hoc signed without
notarization, and Windows packages are unsigned.

## [Unreleased]

## [0.1.0-beta.2] (candidate)

Supersedes the unpublished beta.1 candidate with signed beta-channel in-app
updates. Mac app bundles, per-user Windows installer builds, and Linux
AppImages verify updates before installing and restarting. Windows ZIP/Linux
tarball copies remain manual. The release workflow signs five platform/architecture
feeds with a separate beta key. Actual native fixture-upgrade checks supplement
the signature and corruption tests; human acceptance remains pending.

## [0.1.0-beta.1] (unpublished candidate)

Candidate for the first public beta on Linux x64/ARM64, Mac Apple Silicon/Intel,
and Windows x64, plus the web app you can host beside your sync database. Final publication
waits on the checks in [`docs/release-readiness.md`](docs/release-readiness.md).

### Added

- **Local agent access with MCP.** An opt-in, read-only stdio server exposes
  books, passage search, notes, and threads with citation details. Settings
  provides client configuration and an access switch; disabling blocks further
  reads from connected clients. A cloud client may transmit returned passages
  to its provider. No writing, shell, credential, or arbitrary-file tools.

- **Your library, on your computer.** Books, passages and notes live in one
  private file. A first-run setup explains where everything is stored.
- **Imports from your e-reader:** Kobo, Kindle, KOReader, PocketBook, Tolino
  and Boox, plus Leaflogue's own JSON export. A plugged-in reader is offered
  directly. You see what a file holds before anything is saved, re-importing
  updates what you imported before, and a passage you edited is never
  overwritten: both versions wait for you to choose.
- **Kobo chapters and positions.** Kobo passages keep their chapter and roughly
  how far through the book they are, and Kindle clippings in English, Spanish,
  German, French, Italian, Portuguese, Dutch, Japanese and Chinese keep the
  date you highlighted them.
- **A reading overview.** The library opens with your passages, notes, finished
  books, active days, longest run and busiest day; a calendar of when you
  highlighted; your most highlighted books; series; and today's highlight.
- **Book pages** with each book's ranks among your library, when you
  highlighted it, where in the book (for Kobo), the first passage you kept, and
  its details, reading history, collections and tags.
- **Statistics:** a year of daily activity, highlights by month and weekday,
  passage lengths, most highlighted books and authors, books finished each
  year, and a panel saying how much of your library each chart can draw on.
  Every chart shows its figures when you point at it.
- **Customisable overviews.** Choose **Customise** on the library or
  Statistics page to drag widgets around, resize panels, make one two rows
  tall, remove what you don't use, and add any widget to either page. Layouts
  are kept in the settings file. Five more widgets can be added: On this day,
  Currently reading, Pick back up, Recently kept and Time of day. On the
  library page, widgets can also go below your books.
- **Custom widgets.** While customising, **New widget** builds your own: count
  passages, books or notes, group them by things like weekday, hour, tag,
  thread, author, series or language, keep only what matches a few filters,
  and show the result as a number, columns, a ranked list, a calendar or a
  list, with a live preview as you choose. Edit, delete, or export a widget
  from its toolbar, and **Import widgets** adds widget files others shared.
  Widget files are plain recipes, never code, and are checked before anything
  is added. A new Plugins page in the guides has ready-made widgets to
  download.
- **A sidebar you can expand and resize**, with ⌘B (Ctrl B) to fold it.
- **Passages load as you scroll** on a book's page and in Highlights, and a
  passage opened from a link is marked on the page.
- **Find or do anything from one box.** Click the search bar at the top, or
  press Ctrl+K (⌘K on a Mac), and type: books, passages, notes, tags, threads,
  collections, pages, any setting, and actions such as importing from a
  plugged-in reader, adding a book, exporting, backing up, checking for
  updates, switching theme or light and dark, and folding the sidebar. Each
  page adds its own, such as marking a book finished. Start with `>` for
  actions, `#` for tags, `@` for authors or `/` for pages and settings.
  Choosing a setting opens Settings at that control. What you opened lately
  comes first, and none of it leaves your computer.
- Highlights with filters by book, notes and tags; collections, tags, threads
  that follow an idea across books, reading status history and completion
  dates.
- **Sync between computers** through a Convex deployment or a PostgreSQL
  database you run, in the background, with its state in the header. Versions
  that lose a sync race are kept for review, so sync never discards writing.
- **Themes:** Leaflogue, Everforest, Catppuccin, Rosé Pine, Tokyo Night and
  Nord, each light and dark. Drop a theme file into the `themes` folder beside
  your settings and it appears straight away.
- **An optional reading companion** that explains a passage in a side sheet,
  through an AI provider you choose. It is off until you turn it on, and you
  see exactly what would be sent first.
- Backups with journaled restore, and exports to Markdown (for notes apps) or
  JSON (for another Leaflogue library).
- Signed AppImage updates: a manual check or optional daily notification,
  followed by installation only when the reader chooses **Install and restart**.
  Draft candidates are not stable update feeds.
- **A web app you host yourself.** Open your library in any browser, with the
  same interface as the desktop: the library overview, book pages, Highlights,
  Threads, Statistics, search and commands, themes, and the reading
  companion. Host it in one container beside the PostgreSQL database your
  computers sync with, or as static files with your Convex deployment. Only
  emails you allow can sign in. Import by choosing your reader's file in the
  browser. Each reader's page layouts are kept with their account. Backups,
  exports, importing from a folder or plugged-in reader, updates, theme files
  and custom widgets stay in the desktop app, and the web app doesn't offer
  them.

### Release preparation

- Updated the Electron runtime to 44.10.2 and refreshed dependencies to address
  the production audit findings. The final candidate retains its own audit,
  SBOM, checksums, and build-input record.
- Reorganised the user guides around getting started, navigation, reading,
  dashboards, imports, and recovery; aligned the release/update policy with
  the implemented signed updater.

### Known limitations

- Clean Linux desktop, ARM64 normal-user workflow, and Orca validation are
  pending. These are final-publication gates, not completed test results.
- Mac packages are ad-hoc signed without notarization; Windows packages are
  unsigned, as approved for the beta. Native acceptance and screen-reader
  checks remain pending. There is no Flathub or app-store listing.

### Upgrade notes

- First release. Libraries made with earlier development builds open as they
  are. Beta.1 used manual replacement outside stable Linux AppImages; beta.2
  adds the signed beta update paths described above.
- Local library schema 17. PostgreSQL schema 13. Convex schema 17, mutation
  contract 23; the matching Convex backend bundle is attached to the release.
- The web app's server keeps its own tables in a separate `leaflogue_web`
  schema (version 2), which never changes the version desktops check. On
  Convex, the web app adds sign-in and layout tables to the same deployment;
  deploy the bundle from this release before opening it.

<!--
Template for each release. Keep entries in plain language about what changes
for the reader; link issues or pull requests where they help.

## [x.y.z] - YYYY-MM-DD

### Added
### Changed
### Fixed
### Security
### Upgrade notes
Schema versions this release migrates to, whether an older release can still
open the library afterwards, and anything the reader must do.
-->

[Unreleased]: https://github.com/Ka1Thakkar/leaflogue/compare/v0.1.0-beta.2...HEAD
[0.1.0-beta.2]: https://github.com/Ka1Thakkar/leaflogue/releases/tag/v0.1.0-beta.2
[0.1.0-beta.1]: https://github.com/Ka1Thakkar/leaflogue/releases/tag/v0.1.0-beta.1
