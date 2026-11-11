---
title: Link your Calibre library
description: Read Calibre-managed EPUBs without copying them or changing your Calibre library.
---

:::note[Available in 0.1.1 development builds]
Calibre linking is part of the desktop EPUB reader in the source and local
`0.1.1-beta.1` build. It is not included in the published `0.1.0-beta.3`
download. See the [release notes](/start/release-notes/).
:::

:::note[Format selection in development]
After 0.1.1-beta.1, the source adds a **Book format** choice for EPUB and
KEPUB (Kobo EPUB). Each book appears once with its available supported formats;
choose one, then confirm **Link selected EPUB** or **Link selected KEPUB**.
The selected format is remembered, including after Calibre renames. If it is
removed, Leaflogue reports it instead of silently opening another format.
The published 0.1.1-beta.1 reader links EPUB only; this selector is for a
follow-up beta. Files are read in place, without conversion or copies.
:::

## Choose a library and edition

1. Open the book in Leaflogue and choose **Read**, then **Link from Calibre**.
2. Choose the local Calibre library folder containing `metadata.db`.
3. Search by title, author, or ISBN. Suggested matches help you find the book;
   they do not attach anything automatically. Refine your search if the list
   does not include the edition you need.
4. Select the EPUB edition, then confirm **Link selected EPUB**.

Only books with an EPUB are offered. This connects an existing Leaflogue book
to its file; it does not import your whole Calibre catalogue, its annotations,
or its metadata into Leaflogue.

Leaflogue opens the catalogue read-only and reads the EPUB in place. It never
copies the EPUB or writes to Calibre's database or files. Highlights and notes
you create while reading belong to Leaflogue and are not written back to Calibre.
See [Read an EPUB](/library/epub/) for reading and annotation controls.

## Renamed, moved, or changed files

Leaflogue stores the Calibre library and book identifiers, then looks up the
current filename when you open the reader. Renames made through Calibre are
followed automatically.

If you move the library folder, open reader options with right-click or
**Shift+F10**, choose **Manage Calibre link**, and select the new folder.
The library identifiers keep the link associated with the same library.
A Calibre Content Server URL is not supported; choose a local folder.

Leaflogue also checks the EPUB's file identity. If the file's contents change,
it asks for edition review instead of silently applying the old position and
anchors to different text. Use **Unlink book file**, then link the intended
edition. Linking the same edition from Calibre can replace a direct file link
without losing your reading position.

## Disconnect and back up

**Unlink book file** removes only Leaflogue's local link and reading position.
It keeps your Calibre EPUB, Leaflogue book, highlights, and notes.

Calibre connections, file paths, and reading positions stay on this computer.
They are not uploaded with library sync or included in SQLite backups or
exports. Keep a separate backup of your Calibre library, and link books again
on another computer. The [backup guide](/library/backups/#epub-files-and-reading-positions)
explains how to preserve Leaflogue's local reader state too.
