---
title: Export your library
description: Take your books, passages, and notes with you as Markdown or JSON.
---

Choose **Export your library**, on the library page or in **Settings → Your
data**, then pick a format and choose **Export**. Leaflogue never uploads an
export.

## Markdown, for notes apps and AI tools

Pick **Markdown**, decide whether to include archived books, and choose a
folder. Leaflogue creates a new folder inside it, such as
`Leaflogue Markdown 2026-10-05`, containing:

- **one file per book** in a `books` folder, with each passage as a quote,
  your notes underneath, and its tags, threads, and date;
- **`library.md`**, every book in one file.

The per-book files open nicely in apps like Obsidian or Logseq. `library.md`
is handy for reading your whole library at once, or for pasting into an AI
tool such as NotebookLM.

Exporting again on the same day makes a second folder rather than changing the
first, so nothing you've edited is overwritten.

## JSON, to move your library

Pick **JSON** and choose where to save the file. You get readable JSON of
everything: books, passages, notes, organisation (tags, collections, and
threads), and reading history. To bring it into another Leaflogue library, choose
**Import** there and pick the JSON file; it adds to that library rather than
replacing it.

## Exports are not backups

Neither export includes your settings, saved keys, or sync setup. To restore a
library exactly as it was, use a [backup](/library/backups/).
