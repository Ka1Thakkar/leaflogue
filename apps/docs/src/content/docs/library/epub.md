---
title: Read an EPUB
description: Link a local EPUB, turn pages, and keep highlights and notes beside your book.
---

The EPUB reader is included in the experimental **0.1.1-beta.6** desktop
release. See the [release notes](/start/release-notes/) for downloads and
known limitations.

## Link your book file

In the desktop app, open a book and choose **Read**. In the right-hand
**Reader** tab, choose **Attach book file** and select a DRM-free, reflowable EPUB or Kobo KEPUB file (`.epub`, `.kepub`, or
`.kepub.epub`).
Leaflogue links the original file; it does not make another copy. Keep that
file available where you attached it. If Calibre manages your books, use
[Link from Calibre](/library/calibre/) so Leaflogue can follow catalogue renames.

### If the book file moves or changes

If Leaflogue can't open the linked file, the Reader tab explains what happened:
the file was moved or deleted, it has changed (perhaps to a different edition),
or it can't be read. Choose **Locate file…** and pick the file in its new place.

- If it is the same edition, Leaflogue links it again and keeps your reading
  position, bookmarks and highlight locations.
- If it is a different edition, Leaflogue asks first, because your place and
  highlight locations may shift. Bookmarks that still exist in the new file are
  kept.

Books linked from Calibre show **Reconnect from Calibre** instead. You can also
choose **Unlink book file** and link the book again from scratch.

The Reader and Assistant share the right context panel. Drag its left edge to
resize it, or choose **Expand context panel** for more reading space.
**Restore split view** brings the book page back beside it. The header's
rightmost button opens or closes the panel. Closing it keeps your place.

## Turn pages and change the display

The reader uses pages. Use the arrow keys, **Space** or **Page Down** to move
forward; **Shift+Space** or **Page Up** goes back. Mouse-wheel movement and
clicking near the left or right page edge also turn pages. Keyboard page turns
work while the Reader tab is visible, unless you are typing or using another
control, menu, list or dialog. Those keep their own keys, including
**Shift+F10**. Reading position saves automatically.

Right-click the page, or press **Shift+F10**, to open reader options over the
book. The **Book** tab contains chapter navigation, search and bookmarks.
The **Text**, **Layout**, **Appearance** and **Presets** tabs control reading preferences. Press **Escape** or click outside to return to the page.
Page-turn buttons are not part of this menu.

- **Dark mode** starts with black paper and white text. Turn it off for white
  paper and dark text.
- **Use theme colours** maps the book's colours to your app theme, adjusting
  text contrast. This is separate from the app's light/dark setting. Images
  keep their colours.

Display choices are remembered on this device. Changing text size or panel
width reflows the pages, so the page count can change while your place stays
anchored to the text. In a long book the total page count starts as an
estimate and may shift by a few pages as you read; your current page always
moves forward one page at a time. Each new chapter starts on a fresh page.

## Reading preferences in development

The next desktop build adds adjustable text size, weight, alignment, line and
paragraph spacing, indentation, letter/word spacing and hyphenation. Font-family
selection is not included. Publisher settings remain available; headings and
centered dedications retain their alignment and emphasis.

Use **Layout** for side/top/bottom margins, reading width and automatic, one- or
two-column spreads. Narrow readers stay single-column. Enable **Reading progress**,
**Chapter information** or **Clock** to show them below the page while options are
closed. These indicators are off by default.

**Appearance** adds sepia and a page/app surround choice alongside dark mode and
theme colours. Theme colours take precedence over sepia. **Presets** saves named
combinations, restores publisher typography, resets preferences and optionally
keeps different preferences for this book. Turning **Use separate preferences
for this book** off keeps that book's settings, so turning it back on restores
them; choose **Forget this book's settings** to remove them. Preferences are local to this device;
they are not library data or synchronized annotations.

Changes preview immediately and repaginate around the current text location.
Your alignment, line spacing, paragraph spacing and indentation take priority
over the book's own paragraph styles, while titles, captions and verse keep
their layout.
PDFs keep their fixed layout and use zoom rather than these typography controls.
Automatic hyphenation depends on the language information and available browser
dictionaries; some embedded fonts offer only limited weight variation.

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

To use the keyboard instead, open reader options and expand **Highlights in
this book**. Choose a highlight to go to its page and open the same actions,
including its colour, **Add note** and **Remove highlight**. Press **Escape**
or choose **Cancel** to return to the page.

From a library passage's actions, choose **Read in context** to open its
matching EPUB page. If you have not linked a file, link it when prompted.
Missing or ambiguous matches produce a message instead of a guessed jump.

## Files, backups, and limits

EPUB files, local links, and reading positions do not travel with library
sync, SQLite backups, or JSON/Markdown exports. Link the file separately on
each computer and keep your original EPUBs backed up. See
[Back up and restore](/library/backups/#epub-files-and-reading-positions).

**Unlink book file** in reader options removes the local link after
confirmation, along with your reading position, bookmarks and reviewed
highlight locations for that file, and its Calibre link if it has one. It keeps
the original file, library book, highlights, and notes. Unlink before attaching another edition. Existing
edition-specific highlight anchors may not match a replacement file.

The reader preserves supported publisher formatting, images, and fonts while
blocking scripts and external resources. IDPF and Adobe font obfuscation is
restored locally when the book identifier permits it; otherwise the reader
uses fallback fonts. Adobe page templates are ignored. DRM, fixed-layout
fidelity, audio/video, and book-file sync are not supported
in this version. For PDFs, use the [PDF reader](/library/pdf/). EPUBs must be no larger than 50 MB; malformed or oversized
resources may also be rejected.

## Search and bookmarks

Open reader options with right-click or **Shift+F10**.
Expand **Search this book**, type literal text, and choose a result to open
its location. Search ignores case and shows up to 100 matches; narrow the
query to find more. Results do not create saved highlights.

Expand **Bookmarks**, then choose **Bookmark this location**. Choose a saved
entry to return or **Remove** to delete it. Bookmarks belong to the exact
linked edition, stay on this device, and are removed when the file is
unlinked. They are not included in library sync, SQLite backups, or exports.

## Explain a passage

With optional AI enabled and a provider configured in Settings, click a saved
highlight and choose **Explain this passage**. For a new selection, choose
**Save & explain** and confirm: this saves a normal library highlight before
opening the Assistant tab. Cancel keeps the selection without saving it.

The Assistant uses the existing provider disclosure and first-use consent.
Selecting text alone does not save or send it. Previously accepted providers
can answer immediately after you explicitly choose Explain. Saved highlights
and notes use normal library sync; the book file stays local.

## Review highlight locations

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

## Highlight colours

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
24. Colour choices stay in a separate durable local queue until that backend supports them; ordinary library data continues syncing with contract 23.
