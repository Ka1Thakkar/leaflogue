---
title: Read an EPUB
description: Link a local EPUB, turn pages, and keep highlights and notes beside your book.
---

The EPUB reader is included in the experimental **0.1.1-beta.4** desktop
release. See the [release notes](/start/release-notes/) for downloads and
known limitations.

## Link your book file

In the desktop app, open a book and choose **Read**. In the right-hand
**Reader** tab, choose **Attach EPUB** (**Attach book file** in the next beta) and select a DRM-free, reflowable EPUB or Kobo KEPUB file (`.epub`, `.kepub`, or
`.kepub.epub`).
Leaflogue links the original file; it does not make another copy. Keep that
file available where you attached it. If Calibre manages your books, use
[Link from Calibre](/library/calibre/) so Leaflogue can follow catalogue renames.

The Reader and Assistant share the right context panel. Drag its left edge to
resize it, or choose **Expand context panel** for more reading space.
**Restore split view** brings the book page back beside it. The header's
rightmost button opens or closes the panel. Closing it keeps your place.

## Turn pages and change the display

The reader uses pages. Use the arrow keys, **Space** or **Page Down** to move
forward; **Shift+Space** or **Page Up** goes back. Mouse-wheel movement and
clicking near the left or right page edge also turn pages. Keyboard page turns
work while the Reader tab is visible, unless you are typing or using another
control or dialog. Reading position saves automatically.

Right-click the page, or press **Shift+F10**, to open reader options over the
book. Choose a chapter under **Contents**, change **Typography**, or check
reading progress. Press **Escape** or click outside to return to the page.
Page-turn buttons are not part of this menu.

- **Dark mode** starts with black paper and white text. Turn it off for white
  paper and dark text.
- **Use theme colours** maps the book's colours to your app theme, adjusting
  text contrast. This is separate from the app's light/dark setting. Images
  keep their colours.

Display choices are remembered on this device. Changing text size or panel
width reflows the pages, so the page count can change while your place stays
anchored to the text.

## Save highlights and notes

Select text, then choose **Highlight** to save it. Selecting alone never saves
a highlight. Choose **Add note**, write your note, then choose **Save highlight
and note** to keep both. A single-word selection also offers **Define** using
the [offline dictionary](/library/dictionary/). Deselecting or turning a page
clears the selection controls.

Saved highlights appear in your library and use the same optional library
sync as other passages. Imported highlights show in the EPUB when their text
matches one location in this edition. The reader options report how many
could not be matched. A different edition, altered quotation, or repeated
phrase may prevent a match; Leaflogue does not guess.

Click a displayed highlight once to see its actions: **Add note**, **Remove
highlight**, or **Open in book** to find it on the book page. Highlights with
notes have a margin note icon; click it to read the notes. Removing a
highlight asks for confirmation, including its attached notes.

From a library passage's actions, choose **Read in context** to open its
matching EPUB page. If you have not linked a file, link it when prompted.
Missing or ambiguous matches produce a message instead of a guessed jump.

## Files, backups, and limits

EPUB files, local links, and reading positions do not travel with library
sync, SQLite backups, or JSON/Markdown exports. Link the file separately on
each computer and keep your original EPUBs backed up. See
[Back up and restore](/library/backups/#epub-files-and-reading-positions).

**Unlink book file** in reader options removes the local link and reading
position after confirmation. It keeps the original file, library book,
highlights, and notes. Unlink before attaching another edition. Existing
edition-specific highlight anchors may not match a replacement file.

The reader preserves supported publisher formatting, images, and fonts while
blocking scripts and external resources. IDPF and Adobe font obfuscation is
restored locally when the book identifier permits it; otherwise the reader
uses fallback fonts. Adobe page templates are ignored. DRM, fixed-layout
fidelity, audio/video, PDFs, and book-file sync are not supported
in this version. EPUBs must be no larger than 50 MB; malformed or oversized
resources may also be rejected.

## Search and bookmarks (next beta)

In the next beta, open reader options with right-click or **Shift+F10**.
Expand **Search this book**, type literal text, and choose a result to open
its location. Search ignores case and shows up to 100 matches; narrow the
query to find more. Results do not create saved highlights.

Expand **Bookmarks**, then choose **Bookmark this location**. Choose a saved
entry to return or **Remove** to delete it. Bookmarks belong to the exact
linked edition, stay on this device, and are removed when the file is
unlinked. They are not included in library sync, SQLite backups, or exports.

## Explain a passage (next beta)

With optional AI enabled and a provider configured in Settings, click a saved
highlight and choose **Explain this passage**. For a new selection, choose
**Save & explain** and confirm: this saves a normal library highlight before
opening the Assistant tab. Cancel keeps the selection without saving it.

The Assistant uses the existing provider disclosure and first-use consent.
Selecting text alone does not save or send it. Previously accepted providers
can answer immediately after you explicitly choose Explain. Saved highlights
and notes use normal library sync; the book file stays local.

## Review highlight locations (next beta)

Reader options includes **Review highlight locations**. Choose a saved passage
to see exact-text candidates, allowing whitespace and quotation-mark differences.
Use **Preview location** to read its context, then reopen options and choose
**Use this location** to confirm it. Repeated quotations are never chosen
automatically. If no text matches, the passage remains in your library.

Reviews are local and bound to the exact EPUB edition. They do not change the
imported passage, original source location, notes, or library revision, and do
not sync or appear in SQLite backups/exports. **Reset reviewed location** removes
the local choice. Unlinking the file removes its local reviews. A replacement
edition needs a new review.

Use Tab and Shift+Tab within reader options; Escape closes options and returns
focus to the reader. These keyboard checks do not replace actual screen-reader
acceptance, which remains pending.

## Highlight colours (next beta)

Each highlight has a colour: yellow by default, with green, blue, pink and
purple alternatives. Choose a swatch in the highlight’s actions on the book page
or in a saved reader highlight’s actions. All five choices are visible directly;
one click changes the colour. The date, hover bar and
reader marking use the same choice; no additional colour tag is shown beside
the date. All colours adapt to the active theme;
changing themes retains the colour name rather than a fixed paint value.

Colour choices are saved with each highlight and sync between desktop,
Libredex, and the self-hosted web app when they use the same library. They are
included in SQLite backups and JSON exports and survive file unlinking or
changing formats. Each device uses its own theme to render the saved colour.

Existing choices saved on a device migrate automatically when it opens the
updated app. A colour already saved in the shared library takes precedence.
Update your desktop apps before upgrading a Convex backend to mutation contract
24. Colour changes stay queued locally until that backend supports them.
