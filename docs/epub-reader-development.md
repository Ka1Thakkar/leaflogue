# Local EPUB reader development

The first 0.1.1 development slice is available from a desktop book page:
**Read**, then **Attach EPUB** in the right-hand Reader tab. This is source functionality, not part of
the published 0.1.0 beta. Attach a DRM-free text EPUB to an existing book.

The reader follows the EPUB spine and lays the book out as reflowable pages.
Arrow keys, Page Up/Down, Space (Shift+Space goes back), mouse-wheel movement,
edge clicks, and the page controls turn pages across chapters. The chapter
picker jumps directly to a section. Reading position saves automatically,
including a character offset within long paragraphs. Text size and panel size
reflow the pages while retaining the anchored text. It uses the application's
current colours. Closing and reopening the application
retains the attachment and resume point. The existing global offline dictionary
can define selected words in this reading surface.

## Context panel prototype

The book page stays in the centre while a collapsible right panel contains
**Reader** and **Assistant** tabs. **Read** on a book opens its linked EPUB there.
**Explain this passage** on a highlight opens the same panel's Assistant tab,
using the existing provider disclosure, consent, follow-up and save-as-note flows.
Switching tabs or collapsing the panel preserves the current reader and assistant
session in that window. Conversations are still not persisted across restarts.

Drag the divider or focus it and use Left/Right to resize; Home/End select the
minimum/maximum width. Width is remembered on this device. **Expand context
panel** gives the panel the centre workspace; **Restore split view** brings the
book page back. Below 900 px the panel fills the available window, with the
close control always accessible. Tabs support Left/Right and Home/End navigation.
Dictionary selection works in the Reader tab too.

## Storage and limits

Only a local file reference and resume metadata are saved in
`<library.sqlite>.epubs/`, beside the active SQLite library. EPUB bytes remain
in their original location and are never copied or modified. Each book has one
linked edition; replacement and removal are not implemented yet. A SHA-256
identity is computed from the original file;
resume points are accepted only for that edition and valid chapter/paragraph
indices. This data stays on this device and is never sent by library sync.

**SQLite backups and library exports do not include attachments or resume points.**
Keep your original EPUBs. To preserve this development reader's local state,
copy the sidecar directory separately while the app is closed. Restoring a
SQLite backup does not restore or roll back this directory. Merging books does
not move their attachments yet; attach to the book you intend to keep.

The reader preserves semantic EPUB markup, publisher stylesheets, local images
and unobfuscated fonts inside a sandboxed iframe. Only sanitized elements and
attributes are retained. External resources, scripts, forms and embedded frames
are blocked. Resources come from the linked EPUB itself; reading does not fetch
publisher URLs. An image or font may not render if its format is unsupported.
This remains a reflowable reader; fixed-layout fidelity, audio and video are not
implemented. Publisher CSS is shared across spine documents in this version.

Reading controls live in an **in-app overlay**, opened by right-click or
Shift+F10 and dismissed with Escape or a click outside. It contains chapter
navigation, text size, light/dark mode, theme-colour mapping, reading progress
and keyboard help. Page buttons are
not placed in the overlay; page turns happen directly in the reader. There are no
native reader menus or persistent reader toolbar/footer. Page-turn keys work
while the Reader tab is visible, including after clicking outside the page;
they defer to text inputs, visible dialogs, tabs and other keyboard widgets.

The reader defaults to plain dark mode (black paper and white text). Light mode
uses white paper and dark text. **Use theme colours** selects the active app
theme's corresponding light/dark palette without changing the app's own mode.
Book colours are mapped by hue family and adjusted for readable contrast; when a
theme lacks a matching hue, one is adapted from its saturation and lightness.
Images are not inverted or recoloured. Both toggles are saved per device.

Page columns use an exact whole-pixel pitch so fractional font metrics do not
accumulate horizontal drift over a long book. Reflow constrains publisher block
widths and padding, wraps long tokens, and reserves a small inset for glyphs.


Encrypted resources (including font obfuscation) are rejected for now. Limits
are 50 MB per archive, 8 MB per entry, 100 MB expanded, 4,000 entries and 1,000
spine chapters, plus a 40 MB formatted-resource budget. Malformed XML, external
entities and unsupported document types are rejected. Simple HTML5 doctypes
are accepted. The reading document has its own policy blocking scripts and
network access; it has no preload bridge or application IPC permissions.

## Highlights and notes

Selecting text displays an in-app action toolbar; it never creates a highlight
by itself. Choose **Highlight** to confirm, or **Add note** followed by
**Save highlight and note**. A single-word selection also offers **Define**.
Deselecting or turning a page clears selection controls. Notes on an existing
anchored selection reuse its highlight record instead of creating a duplicate.

Reader-created highlights use the normal library mutation and an edition-bound
range in `sourceLocation`, preserving parity with existing sync adapters. They
appear in the book page and search. Changes from library editing and background
sync refresh the reader. Imported highlights are placed where a unique quoted
text match exists (including whitespace and curly-quote normalization); ambiguous
and missing matches remain unplaced, with counts in the reader options. Ranges
are painted using CSS highlights rather than changing publisher markup.

## Next slice

Add richer match review, book search and bookmarks, and reuse the optional AI
disclosure flow for reader selections.
File sync and PDFs remain deferred. The full 0.1.1 milestone is not complete.

The beta-feedback issue form records OS/architecture, installer filename,
install/update outcomes, accessibility observations, and redacted errors.

## Calibre connection

Choose **Link from Calibre** before attaching a file, or **Manage Calibre link**
from reader options. Pick the local library folder containing `metadata.db`.
Search available EPUBs by title, author or ISBN; ISBN and title/author matches
are labelled as suggestions. Select an edition and confirm **Link selected EPUB**.
Nothing is attached merely because metadata matches.

Calibre's catalogue is opened read-only, using its
[documented source schema](https://github.com/kovidgoyal/calibre/blob/master/resources/metadata_sqlite.sql).
Leaflogue never changes that database or its managed files. The connection is
stored in `<library.sqlite>.calibre.json`; local attachment metadata keeps the
Calibre library UUID, book UUID, original root and EPUB hash. On open, Leaflogue
resolves the current filename through the catalogue and checks that its real
path stays inside the selected library. Renames are followed automatically.
Reconnect a moved library by choosing its new folder; UUIDs keep existing links
bound to that library and edition. Changed EPUB bytes require edition review.

Linking the same file edition from Calibre can replace a direct file reference
without discarding its reading position. **Unlink book file** removes only local
link and position metadata; it never removes the EPUB, logical book, highlights
or notes. Linking another edition requires unlinking first, with explicit
confirmation. Edition-bound anchors from a different file are not guessed.

Calibre connections and paths stay local and are not included in SQLite backups
or uploaded with library sync. Calibre annotation/metadata write-back, Content
Server connections and automatic whole-library imports remain outside this slice.

## Navigating annotations

**Read in context** on a library highlight opens the matching EPUB page. If no
file is linked, the request is retained while the reader attaches one; missing
or ambiguous matches produce an explanation instead of a guessed jump.

Click a painted highlight as one entity to open its actions: **Open in book**,
**Add note**, and **Remove highlight**. Removal uses the existing library mutation
and an in-app confirmation that accounts for attached notes. A note icon appears
in the page margin for highlights with notes; clicking it displays those notes
and the same actions. **Open in book** restores the centre workspace and focuses
the original library annotation rather than creating another copy.
