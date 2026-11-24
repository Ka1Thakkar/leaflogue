# ADR 0008: article captures use the existing reading library and document adapter

Status: implemented on the independent article-reader feature branch; unreleased.

## Context

Articles need the existing reader's annotations, matching, preferences and position
storage, without depending on the planned multimedia Work model. Duplicating the
reader or pretending a remote HTML response is an EPUB would introduce parallel
code and unsafe parsing. Raw HTML must never be mounted in a renderer.

## Decision

Retain the existing bibliographic library record and stable BookId as the reading
item identity. Use the canonical importer as the transactional creation/provenance
adapter, with a dedicated Web articles source and a stable external ID derived from
the normalized final HTTPS URL. The historical Book name remains a compatibility
API; this change does not introduce film/music/game records or a new Work model.
Article items use the current reading status, collections, notes and threads.
Current book-oriented library/statistics terminology remains shared for reading
items; a media-specific library/status redesign belongs to the separate Work model.

The reader document gains an explicit `article` format. It is backed by a validated
`leaflogue-article` version-1 JSON snapshot containing metadata and paragraphs,
not executable remote HTML or a fabricated EPUB. A paragraph adapter emits escaped
markup with the existing chapter/paragraph coordinates. `article:<checksum>:...`
locations distinguish article anchors while keeping old EPUB/PDF anchors readable.

Reader references, positions, bookmarks and reviewed anchors use the existing
edition-checked EpubStore through its backward-compatible API. The new captured
format does not change the database schema; existing canonical metadata and note
rows retain their IDs/contracts. Upgrade tests must exercise existing SQLite data,
not just fresh profiles. Older clients may view the canonical metadata/writing but
cannot open the new local source format. No database reset is required.

Full source snapshots and immutable URL capture manifests are stored beside the
library in `<library.sqlite>.articles`, outside the database and ordinary sync,
exports and database snapshots. Atomic exclusive publication and stable import
mapping make retries recoverable. Repeated capture of the same final URL opens the
first saved edition; it does not replace text underneath annotations. Updating an
article to a new edition remains an explicit future flow. Query strings are kept
because they may identify articles; fragments are removed. Known credential query
parameters are rejected. Alternate URLs/redirect aliases may require manual merge;
there is no automatic fuzzy title-based merge across captures or devices.

Metadata includes the source URL in its description, so the ordinary library
record and user-selected quotations can sync through existing providers. The full
capture never enters the hosted library. Import provenance remains device-local as
it does for other sources; cross-device capture matching is not a new global URL
identity service. Remote clients retain saved quotations even without source text.

A shared public-resource fetcher preserves the cover fetcher's DNS pinning and
address rejection. Every redirect is revalidated. The first capture path supports
public HTTPS on the standard port, HTML, bounded identity-encoded responses and
supported text encodings. It does not load cookies, scripts, remote images, auth
sessions or browser automation. Readability runs with resource/script loading off
in a bounded worker, followed by text-only reconstruction and validation. Explicit
cancel/timeout terminates the worker. Parsing is not on the interaction path.

## Consequences and limits

One reader and one canonical annotation pipeline are maintained. There are no new
sync entities or remote migrations in this slice, but new-format source storage
and legacy-library upgrade/recovery tests remain mandatory. Ordinary backups do
not include the captured text or reader sidecars. Recovery of reading context needs
those directories in addition to the database. User writing remains canonical.

This first capture is text-only, desktop-only and cannot retrieve every site;
JavaScript-only, authenticated, paywalled, non-HTML or unsupported compressed pages
may fail cleanly. It neither bypasses access controls nor promises licensed use of
any particular site's content. Source replacement, capture export bundles and a
typed cross-media Work model are separate changes. No production network/load or
hosted-backend migration is performed by fixture tests.
