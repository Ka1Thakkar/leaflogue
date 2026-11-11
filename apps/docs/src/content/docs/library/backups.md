---
title: Back up and restore
description: Save your whole library to one file and restore it later.
---

A backup is one file holding your library database: books, passages, notes,
organisation, and reading history. Make one before big changes, and keep
copies somewhere other than this computer.

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


## EPUB files and reading positions

In 0.1.1, the reader links EPUBs in their original location.
SQLite backups and library exports include saved library highlights and notes,
but do not include EPUB files, local file links, Calibre connections, or reading
positions. Back up your original EPUBs or Calibre library separately.

Local reader state lives beside the active library in
`<library.sqlite>.epubs/` and `<library.sqlite>.calibre.json`. To preserve it,
copy those sidecars separately while Leaflogue is closed. Restoring a SQLite
backup does not restore or roll back them. On another computer, the original
file paths may differ; link the files again as needed.
