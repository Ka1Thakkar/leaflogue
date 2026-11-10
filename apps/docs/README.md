# Leaflogue website and guides

The public site: a landing page (`src/pages/index.astro`) and the user guides
(`src/content/docs/`), built with [Astro](https://astro.build/) and
[Starlight](https://starlight.astro.build/). Pages live in this repository so a
guide changes in the same commit as the behaviour it describes.

```sh
npm run dev --workspace @leaflogue/docs     # http://localhost:4321
npm run build --workspace @leaflogue/docs   # static output in apps/docs/dist
npm run test:docs                          # layouts, screenshots, search, theme picker
```

The root `npm run build` (and so `npm run check` and CI) builds the site too,
so a broken page fails the quality gate.

## Design

The site imports `@leaflogue/ui/ui.css`, sharing Barlow, Barlow Semi Condensed,
Newsreader, semantic UI tokens, and scrollbars with desktop and Libredex.
`src/styles/tokens.css` supplies the light/dark materials; `landing.css` lays
out the marketing page; `docs.css` maps Starlight onto the same system.
Guide headings use the condensed face; marketing headlines use Newsreader.
The guide header is 44 pixels tall, while the landing page uses 72 pixels on
desktop and 64 pixels on phones. The postbuild step writes the Pagefind search index with its
CLI, ensuring the shipped metadata is complete. Panels, fine rules, and quiet
surfaces replace the former paper textures, tape, and handwritten type.

Marketing screenshots in `public/images/` are actual renderer captures of a
curated library of published books, with source texts and cover credits in
`tests/marketing/`. They are separate from the intentionally artificial UI
stress fixtures. Desktop and web use the same passages; the real statistics
code calculates their counts. The library dashboard uses an ordinary saved
layout that puts the books directly after the daily highlight.

The landing page uses an editorial layout, reading-face headlines, and larger
product images. Guides keep their compact navigation. Screenshots follow the
page's light/dark appearance; Libredex has captures for every built-in palette.
Imported custom palettes use the default screenshots.

To refresh images, start the desktop renderer preview on port 5199 and Libredex's
development server on port 3100, then run:

```sh
npm run capture:marketing -- ../libredex
```

This needs Chromium (`npx playwright install chromium`) and `cwebp`. It never
connects to Convex or reads a personal library. The generated WebP files have
explicit image dimensions, alt text, and lazy loading below the hero.

## Deployment (Vercel, for now)

One deployment of the current docs; there are no per-release copies.

1. In Vercel, import the GitHub repository as a new project.
2. Set **Root Directory** to `apps/docs`. Vercel reads `apps/docs/vercel.json`,
   which installs only this workspace (`npm ci --workspace @leaflogue/docs`)
   and publishes `dist`.
3. Set the production branch to the branch that should publish the site.

The canonical URL comes from Vercel's `VERCEL_PROJECT_PRODUCTION_URL`. Set
`SITE_URL` (for example `https://docs.example.org`) to override it, such as
when the site moves to another host; the output is plain static files that
any web server can serve.
