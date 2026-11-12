---
title: Import highlights
description: Bring highlights and notes in from a Kobo, Kindle, KOReader, PocketBook, Tolino, or Boox reader, or from another Leaflogue library.
---

Leaflogue reads your reader's own highlights file. It only reads the file you
choose: it never writes to your e-reader, and nothing is uploaded anywhere.

| Reader | What to choose |
| --- | --- |
| Kobo | `KoboReader.sqlite` |
| Kindle | `My Clippings.txt` |
| KOReader (on any reader) | The reader's drive, or your books folder, with **Choose folder** |
| PocketBook or Vivlio | `books.db` |
| Tolino | `notes.txt` |
| Boox | The `.txt` file NeoReader exports for a book |
| Leaflogue | A JSON export (**Export your library**, then **JSON**) |

In the [web app](/web/overview/), choose the file itself: a browser can't
open a folder or see a plugged-in reader. For KOReader, choose every
`metadata.*.lua` file from your books' `.sdr` folders at once; for Boox,
choose all the exported `.txt` files at once. The file is read in your
browser, and only the books and passages in it are saved to your library.

## The easy way: plug in your reader

Connect your Kobo, Kindle, PocketBook, or Tolino with its USB cable, open
Leaflogue, and choose **Import**. Leaflogue notices the reader and shows
**Import from Kobo** (or Kindle, PocketBook, Tolino); choose it and skip
straight to the review below. If you use KOReader on your reader, Leaflogue
offers **Import from KOReader** too. It only reads the highlights and never
changes anything on the reader.

On Linux, Leaflogue also notices a Boox, and the newest Kindles, which
connect like a phone rather than a USB drive. Unlock the reader if it asks
whether to allow access, then open its storage once in your file manager. A
Boox is offered once you have exported at least one book's highlights.

## Or find the file yourself

**Kobo.** Connect the Kobo by USB and open it in your file manager. The
database is in a hidden folder at the top of the device: `.kobo/KoboReader.sqlite`.
Show hidden files (usually <kbd>Ctrl</kbd>+<kbd>H</kbd>), then choose it
directly from the device or copy it to your computer first. Each passage keeps
the chapter it came from and roughly how far through the book it is, such as
"Part 2 · 41%". If you imported from your Kobo before, import it again to add
chapters to the passages you already have.

**Kindle.** Connect the Kindle by USB. `My Clippings.txt` is in its
`documents` folder. Kindle clippings in other languages are understood too,
including the date each passage was highlighted: English, Spanish, German,
French, Italian, Portuguese, Dutch, Japanese, and Chinese.

**KOReader.** KOReader keeps each book's highlights in a small folder beside
the book. Choose **Choose folder** and pick the reader's drive, or the folder
your books are in, and Leaflogue finds every book's highlights inside it.

**PocketBook or Vivlio.** Connect the reader by USB. The library is
`system/config/books.db` (on some readers, `system/profiles/default/config/books.db`).
If your newest highlights are missing, eject the reader properly once and try
again.

**Tolino.** Connect the Tolino by USB. `notes.txt` is at the top of its drive.
Notes in English, German, French, Italian, Dutch, and Spanish are understood.

**Boox.** In NeoReader, open the book's notes and export them as text. The
exports are saved in the reader's `note` folder. Choose one `.txt` file, or
use **Choose folder** and pick the whole folder to import every book at once.
On a Mac, copy the files to your computer first.

## Import

1. Open **Import** from the icons down the left side (or the **Import**
   button on the library page). The page lists each reader and the file to
   choose for it.
2. Choose the file (or the folder, for KOReader or Boox). Leaflogue reads it on
   this computer and shows how many books, passages, and notes it found, with
   each book's counts. Nothing is saved yet.
3. Choose an **import source**: the device or account the file came from, such
   as "My Kobo Clara". The first time, create one and give it a name. Using the
   same source each time is how Leaflogue recognises passages it has already
   imported.
4. Choose **Import highlights and notes**. Everything is saved in one step, so
   if anything goes wrong the import is rolled back and your library is
   unchanged. Afterwards the page shows what was added, what was updated, and
   anything that needs your review.

## Importing again

Import the same device whenever you have new highlights. Passages you already
have are matched rather than duplicated. If a passage changed on the device
and you also edited it in Leaflogue, both versions are kept and the import
asks you to review them: **Keep my version** or **Accept incoming source**.
Open **Import history** to see past imports and anything still waiting for
review.

## Duplicates

If the same book arrives from two sources, say your Kobo and your Kindle, the
library page points it out. Choose **Review** to open the book with its
**Merge duplicate** panel ready, and decide which copy to keep. If a passage
ended up in a book twice, the book's page lists it so you can remove the extra
copy. Leaflogue never merges or deletes anything for you.

## Limits

Leaflogue refuses files that are unexpectedly large (a text file over 16 MiB,
for example) or that are not what they claim to be. Page bookmarks without any
highlighted text are skipped, and the review tells you how many. If Leaflogue
says it could not read a file, choose a fresh copy from your reader and try
again.

## Importing on another synced computer

Import-source profiles and their record mappings currently stay on the computer
that performed the import. A second computer can have synced books, highlights,
and notes without that local import history.

Starting in **0.1.1-beta.4**, the desktop adds a review of matching books before a desktop import.
Under **Import into**, choose **Keep existing** to reuse a book already in your
library, or **Create a separate book** when you intend another copy. A unique
source quotation/date match, ISBN, or title/author candidate is suggested; when several copies match, choose
one explicitly before importing. Existing source links take precedence.

Keeping an existing book preserves its metadata, notes, and identity. Exact,
unique source highlight matches are linked back to the local import history;
new annotations are added. Ambiguous or edited passages are not guessed.
Later imports from the same source reconcile normally. When multiple source
profiles exist, choose one explicitly; a new source is not selected for you.

If duplicates already exist, review them before merging or deleting anything.
This import change does not remove earlier copies automatically.
