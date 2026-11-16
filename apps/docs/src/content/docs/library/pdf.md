---
title: Read local PDFs
description: Read PDF pages and share selectable-text highlights with your library.
---

:::note[Next beta]
PDF support is in development after 0.1.1-beta.4. It is not in the published
beta.4 downloads.
:::

## Link one file

Open a book and choose **Read → Attach book file**, or **Link from Calibre** and
choose **PDF** under **Book format**. Leaflogue reads the original file in
place without copying or changing it. A book can have one linked EPUB, KEPUB,
or PDF at a time. Unlink the current file in reader options before attaching
another format. Unlinking keeps the book, highlights, notes and original file.

## Read and annotate

PDF pages keep their original layout. Reader options offers **Dark mode**
(black paper and white text) and **Use theme colours** (theme paper and ink).
Turn both off for the original colours. These are display-only adjustments;
they do not change the original PDF. Images keep their original colours on mixed pages. Covers, scans and pages
with complex artwork or text over images keep their original colours throughout. Raster text
inside an image is not recoloured. Use keyboard page turns,
mouse-wheel page turns, or the page list in the in-app right-click options.
Use **Zoom** in reader options for fit-page, fit-width, or 100–200% views.
When zoomed, scroll within the current page; keyboard page turns still work.
Expand the reader panel when you need more room. Page position is remembered
on this device. Search and bookmarks work with extracted text and page positions.

Select text and choose **Highlight** or **Add note** to save it. Selecting
alone does not create a highlight. Reader highlights and the book page use
the same records: notes, removal and normal library sync continue to work.
Click an existing reader highlight to open its actions, choose a
[theme-adapted colour](/library/epub/#highlight-colours-next-beta), or return to
the book page. **Read in context** opens a matched passage in its PDF page.

When an existing highlight's text is unique in the linked edition, it can
appear in the reader. Repeated text needs explicit location review; missing
text stays in the book page. Replacing an EPUB with a PDF does not reuse old
edition coordinates. Unique unchanged text can match automatically; review ambiguous locations
in the replacement file instead.

## Scanned PDFs and limits

Image-only PDFs are readable. There is no OCR, so pages without selectable
text do not support text highlights, text search, or imported-highlight
matching. Mixed PDFs can support these features on pages that contain text.
No OCR notice is displayed on each page.

PDF passwords are not supported. Files are limited to 50 MB, 1,000 pages,
and 10 MB of extracted text. Forms, scripts, embedded files and external
PDF links are not interactive. PDF reading does not enable book-file sync:
files, bookmarks, reviewed locations and page positions stay local and are
not included in SQLite backups or library exports. Back up original files
separately.
