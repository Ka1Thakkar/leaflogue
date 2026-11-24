# Independent web-article reader

Local branch: feat/web-article-reader, from origin/develop at 99d3dbb.
The owner selected a separate feature outside multimedia. Begin with desktop-local
capture and existing reader behavior; do not depend on review-import branches.

## Intended flow

Paste a URL → explicitly retrieve → preview cleaned title/author/content → confirm
save → read/highlight using existing reader tools. Preserve source URL, capture
version/checksum and personal annotation snapshots. Network/extraction failure
must offer retry without losing drafts or creating an empty library entry.

## Reuse and design decisions before implementation

- Reuse EpubReader's selection, annotation, matching, preferences and context
  workspace through a document adapter. Do not build a second independent reader.
- Existing EpubDocument/EpubStore/file-reference sidecars are book/file-oriented.
  Establish an additive captured-document contract and identity/location adapter
  before wiring article data into them. Do not introduce a fake EPUB or pretend
  arbitrary HTML is an EPUB file just to bypass validation.
- Decide how standalone article entries fit the current Book library interface
  without requiring the full future multimedia Work model. Record and test the
  compatibility path rather than assuming this independence costs no model work.
- Retain SQLite migrations and upgrade fixtures for existing users. Reuse current
  canonical annotation mutations, IDs, tombstones and ordinary optional sync;
  captured full article bodies remain device-local until explicitly designed.
- Use a supported extraction library such as Readability behind an adapter;
  extraction is not sanitization. Reuse inert rendering/network-denied reader
  policy and stable anchor mapping. Avoid scattering article checks through UI.

## Retrieval and retention boundaries

Desktop main process only; narrow typed capture operations rather than a generic
URL fetch bridge. Validate protocols, credentials in URLs, DNS/address targets,
redirect destinations, response types, time/byte/decompression limits and cancellation.
Decide private-network policy; never silently fetch localhost or cloud metadata.
No automatic clipboard reads, login-cookie copying, paywall bypass or remote images.
Never render raw remote HTML or activate scripts/iframes/forms/event handlers.

Retain original/canonical URL, capture timestamp and immutable source version.
Define duplicate URL handling and an explicit refetch/new-version action. Existing
saved highlights cannot move silently when an article changes. Declare capture
body inclusion/exclusion for export/backup; keep credentials out of every artifact.
Hosted-web capture is out of the first desktop slice unless separately designed.

## Verification

All automated checks HEADLESS with disposable fixture HTTP servers or injected
fetch adapters. Test redirects to forbidden addresses, malformed/oversized/slow
responses, Unicode, inert HTML, missing metadata, cancellation, duplicate URLs,
refetch/versioned anchors, reader regression and migration/export/restore. Reuse
an isolated actual-library snapshot for upgrades; never run against the installed
Mac library or production Convex. No OS/browser window should appear in automation.

Status: implemented as a desktop capture adapter over the existing library and
reader. See decisions/0008-local-article-capture.md for identity, persistence,
compatibility and known limits. Headless tests cover extraction, fetch boundaries,
preview/confirmation, retries, original-version preservation, reader state and
canonical notes. Full format/lint/type/unit/build checks passed. Seven headless browser checks
passed (one compact-layout-only skip) across article highlights, typography,
position and existing EPUB preferences. The built extraction worker also passed
in Electron's embedded Node runtime using RUN_AS_NODE, without launching an app,
GUI or network. A temporary clone of the actual baseline passed preview/save,
reopen and canonical highlight checks; it was removed after testing. The original
installed library and production provider were never modified.

Reproduce the distributable worker check with `npm run test:article-worker`.
This is a no-GUI fixture check; packaged install/update and manual article-site
acceptance remain distinct release gates.
No production capture, deployment or change to the installed library occurred.
