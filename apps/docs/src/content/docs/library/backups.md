---
title: Back up and restore
description: Save your whole library to one file and restore it later.
---

A backup is one file holding your library. Make one before big changes, and
keep copies somewhere other than this computer.

## What a backup includes

| Included | Not included |
| --- | --- |
| Books and their details | The book files themselves (EPUBs and PDFs) |
| Passages and notes, including book notes | Links to book files and to your Calibre library |
| Tags, collections, and threads | Reading positions and bookmarks |
| Reading status and history, which your statistics are built from | Reader display settings, such as text size, font, and margins |
| | App settings and saved keys |

Settings shows the same list beside **Create backup**, and again when a backup
is saved or restored.

## Make a backup

Open **Settings → Backups and your data** and choose **Create backup**, then choose where to
save the file. It is named like `Leaflogue-backup-2026-10-01.sqlite` and only
your user account can read it.

## Restore a backup

Open **Settings → Backups and your data** and choose **Restore backup**, then choose the
file.

:::caution
Restoring **replaces** your current library with the one in the backup. It
does not merge them.
:::

Leaflogue checks the backup completely before it replaces anything. If the
file is damaged or is not a Leaflogue backup, you see "That backup could not
be restored. Your current library was kept." and nothing changes.

## Backups and exports are different

| | Backup | [Export](/library/exporting/) |
| --- | --- | --- |
| Purpose | Restore this library exactly | Read or move your data |
| Format | A copy of the library database (`.sqlite`) | Markdown or readable JSON |
| Restores with | **Restore backup** | JSON: **Import**; Markdown: open in your notes app |

Neither contains your settings or saved keys. If you use sync, restoring a
backup resets this computer's sync progress: the next sync compares
the restored library with your database from the start instead of picking up
where it left off.


## Book files, reading positions, and reader settings

The reader opens your EPUBs and PDFs where they already are, so backups and
exports keep your highlights and notes but not the files. Back up your book
files or Calibre library separately.

Backups also leave out file and Calibre links, reading positions, bookmarks,
and reader display settings. Restoring a backup doesn't change them: they stay
as they were on this computer. On another computer, link your books again and
set the reader up the way you like it.

To keep links, positions, and bookmarks too, copy
`<library.sqlite>.epubs/` and `<library.sqlite>.calibre.json` from beside your
library while Leaflogue is closed.


Captured article text is stored separately in the `.articles` directory beside
the library database. Database backups and portable exports do not include it.
For full article reading-context recovery, retain that directory and the existing
reader sidecars as well as the database. Saved quotations and notes remain in the
database and are included normally.
