# Marketing capture library

These are real published works, used to show the product with a small curated
reading library. They are not a user's personal data or UI stress fixtures.
`books.json` records each work's Project Gutenberg source URL and selected
passages. Covers in `covers/` are from the corresponding Gutenberg edition:

- Jane Austen, *Pride and Prejudice*, ebook 1342.
- Mary Shelley, *Frankenstein*, ebook 84.
- Henry David Thoreau, *Walden*, ebook 205.
- Arthur Conan Doyle, *The Adventures of Sherlock Holmes*, ebook 1661.
- Oscar Wilde, *The Picture of Dorian Gray*, ebook 174.
- F. Scott Fitzgerald, *The Great Gatsby*, ebook 64317.

The capture script adds a few illustrative reader notes and reading dates,
and computes the visible statistics from these records. Both apps use the
same dataset. The library dashboard is arranged with the normal dashboard
preferences, with the books above the activity chart. No product behaviour or
numbers are changed to create the images.

Run `npm run capture:marketing -- ../libredex` with both local development
servers running. The script intercepts read calls in the browser, blocks
Convex sockets from connecting, serves covers from this directory, and saves
light/dark captures of every relevant screen and built-in palette.
