# Design system

Leaflogue is a dense stat sheet for a reading life: panels of counts, charts,
and passages on a quiet page, closer to a game tracker than a notebook. The
same system runs the desktop app and the hosted web app (Libredex) through the
shared [`@leaflogue/ui`](../packages/ui) package.

## Shared package

`@leaflogue/ui` holds everything both apps draw the same way:

- `ui.css`: tokens, fonts (Barlow, Barlow Semi Condensed, Newsreader, bundled
  locally), the header, rail, panels, tabs, buttons, chips, fields, facets,
  settings rows, bars, ranked lists, and the activity heatmap.
- React primitives with the structure and accessibility of each: `AppHeader`,
  `NavRail`, `Panel`, `StatTile`, `TitleRow`, `Bars`, `Ranked`, `Heatmap`,
  `Meter`, `Facet`, `KeyValue`, `Chip`, `Status`.

Icons come from the shared `Icon` paths. The `@leaflogue/ui/app-icons` adapter
provides the named icons, size steps, and stroke weight used by both apps.
App-specific pieces (import, sync, settings forms) stay in each app.

## Tokens

Every colour derives from the active theme's named materials, so built-in and
dropped-in themes drive the whole interface:

- `--ui-bg` is the theme's paper; `--ui-panel` its ruled surface; `--ui-raised`
  its muted surface for hover and selection.
- `--ui-text` (ink), `--ui-dim` (pencil), and `--ui-danger` (stamp) are the
  guaranteed text colours, because the theme validator proves each readable on
  paper, ruled, and muted. Primary buttons are paper on ink for the same reason.
- `--ui-chart` (the theme's optional `chart`, else pen) marks bars, calendars,
  meters, and the current tab; `--ui-accent` (pen) marks focus. Neither is
  guaranteed as text, so `--ui-tone-*` offers each accent (chart, highlight,
  pen) as text only where it is readable, shaded until it is.
- `--ui-control` (control border) is the edge of every field.

Scrollbars in both apps are shared controls, not per-page decoration. The shared
stylesheet gives the page, dialogs, and nested panes a 12-pixel transparent
gutter with a slim, fully rounded thumb. Its resting colour mixes the active
theme's pencil and paper; hover uses pencil. This keeps light, dark, and custom
themes in step without adding scrollbar colours to theme manifests. New
scrollable areas inherit the rule: do not hide the scrollbar or override it
with a page-specific width, colour, or radius unless the interaction requires
it. The track stays transparent so every panel keeps its own surface.

On a desktop book page the cover sits in the top section with the title and
tiles, outside any inner scrolling region; the details panel beside the
passages scrolls on its own, so its thumb never runs alongside the cover.

AI explanations use the shared `ui-companion` right-hand sheet: fixed below the
app header, up to 30 rem wide, with a persistent heading and an independently
scrolling answer. Long Markdown must wrap or scroll within that sheet; it must
never be clipped inside a small centred dialog. The heading, answer panels,
Markdown, and scroll controls live in `ui.css`;
web-only follow-up and recall controls use those same tokens. Tables and code
blocks scroll within the answer. A provider response stopped by
its output limit is an error, not a complete explanation.

Type: Barlow Semi Condensed for labels, figures, titles, and tabs (small caps
labels, tabular figures); Barlow for controls and copy; Newsreader for
passages, the words readers kept.

## Layout

```text
┌ brand / breadcrumb ───────────────────── search ⌘K · sync · bell ┐
│ rail │ title row with meta and actions                            │
│  ▣   │ ┌ tile ┐┌ tile ┐┌ tile ┐┌ tile ┐┌ tile ┐┌ tile ┐            │
│  ❝   │ ┌ panel ──────────────┐┌ panel ──────────────┐             │
│  ⌥   │ └─────────────────────┘└─────────────────────┘             │
│  ▥   │ tabs · toolbar                                             │
│  ⤓   │ list or grid of cards                                      │
│  ⚙   │                                                            │
└──────┴────────────────────────────────────────────────────────────┘
```

The 44-pixel header carries the breadcrumb, search (⌘K or Ctrl K, opening
Highlights), and sync state; on macOS it leaves room for the traffic lights and
drags the window. The 52-pixel rail holds Library, Highlights, Threads,
Statistics, Import, and Settings. Below 640 pixels the rail becomes a labelled
tab bar along the bottom and Import moves to the page actions.

Charts only show what the readers' files actually record. Kobo positions come
from the chapter and how far through it a passage starts; page and Kindle
location numbers are not positions. Where some data is missing, a chart says
how much it leaves out rather than guessing.

Text is left aligned. Passage measures stay comfortably readable; controls align
to the content grid rather than the window edge. Empty states occupy the working
area and teach the first useful action. Hairlines and panels communicate
structure; nothing is tilted, taped, or textured.

## Updating the hosted interface

From the Leaflogue repository, refresh the web host's UI package with:

```sh
node scripts/export-convex-host.mjs ../libredex --ui-only
```

This copies the shared UI and appearance catalogue without changing Convex modules, domain packages,
or the backend manifest. Run `npm install` in the host if the package's exports
or dependencies changed. Keep app-specific layout changes in both renderers;
check Library, Highlights, book details, Threads, Statistics, and the companion
at desktop and phone widths in light and dark themes before publishing.

The docs website imports the same UI stylesheet. Its guides retain Starlight's
navigation and search, while the landing page and widget gallery use the same
fonts, panels, rules, and header height as the apps. Marketing images are real
renderer captures of synthetic libraries, compressed as WebP. Refresh both
apps in the same palette and mode before replacing the images.

Marketing pages share the apps' materials and fonts, with a separate editorial
composition: larger Newsreader headlines, generous spacing, and product
screenshots large enough to show the work. Screenshots use a curated library
of published books and follow light/dark appearance; the hosted marketing
page also selects a capture for its active built-in palette. UI stress-test
fixtures are never used as marketing content. `npm run capture:marketing`
rebuilds the images from the actual renderers and documented sources.
