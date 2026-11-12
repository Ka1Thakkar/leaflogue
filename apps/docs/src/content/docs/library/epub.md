---
title: Read an EPUB
description: Link a local EPUB, turn pages, and keep highlights and notes beside your book.
---

The EPUB reader is included in the experimental **0.1.1-beta.4** desktop
release. See the [release notes](/start/release-notes/) for downloads and
known limitations.

## Link your book file

In the desktop app, open a book and choose **Read**. In the right-hand
**Reader** tab, choose **Attach EPUB** and select a DRM-free, reflowable EPUB or Kobo KEPUB file (`.epub`, `.kepub`, or
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
