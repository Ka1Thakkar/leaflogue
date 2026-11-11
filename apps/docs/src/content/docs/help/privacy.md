---
title: Privacy
description: What Leaflogue keeps, where, and when it uses the network.
---

Leaflogue is built to keep your reading private by default.

## What stays on your computer

Your books, passages, notes, organisation, and reading history live in one
SQLite file in your [data folder](/start/files-and-settings/). Saved database
URLs, sync keys, and AI keys live in a settings file only your user account
can read. There is no account, no analytics, and no telemetry.

In 0.1.1 development builds, EPUB files stay in their original location.
Local file links, Calibre connections, and reading positions are stored beside
the library and are not uploaded by sync. Calibre's catalogue is read-only.
The EPUB reading surface blocks scripts and external network resources.

## When Leaflogue uses the network

Only in these cases, each of which you turn on or start:

- **Covers.** When a book's details include a cover address, Leaflogue
  downloads that image so it can show it. Addresses on private or local
  networks are refused.
- **Sync**, once you have set it up: when Leaflogue opens and whenever you
  choose sync, to the database you configured.
- **AI**, when you ask it to explain a passage, to the provider you chose,
  after showing you what will be sent.
- **Book lookup**, when you choose to find or fill in book details. Your search
  terms or book identifiers go to the configured catalogue providers. In the
  0.1.1 Add book form, typing at least two characters and pausing starts a
  Google Books search automatically, with Open Library as a fallback. Your
  library and notes are not sent with that search.
- **Updates**, when you choose **Check for updates**, or if you enable the
  optional daily check. Leaflogue asks GitHub Releases for version metadata;
  it downloads an update only when you choose to install it.
- **Links** in notes open in your web browser, after Leaflogue shows you the
  full address and you confirm.

With sync and AI turned off, Leaflogue makes no sync or AI requests at all,
and its automated tests check this.

## Imports

Your e-reader's highlights are read on your computer. Leaflogue never uploads
them and never writes to your e-reader.

## Exports and backups

Exports and backups never include your settings or saved keys.
