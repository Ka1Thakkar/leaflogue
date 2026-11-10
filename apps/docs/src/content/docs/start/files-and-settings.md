---
title: Files and settings
description: Where Leaflogue keeps your library, settings, and logs on Linux.
---

Leaflogue follows the standard Linux layout for applications, so your library,
settings, and disposable caches each live in their own folder:

| What | Where | Contains |
| --- | --- | --- |
| Settings | `~/.config/leaflogue/config.json` | Appearance, AI, and sync settings, including saved keys |
| Library | `~/.local/share/leaflogue/` | `library.sqlite`, the file that holds your books, passages, and notes |
| Cache | `~/.cache/leaflogue/` | Disposable browser-engine data; safe to delete |
| Logs | `~/.local/state/leaflogue/` | Logs and crash diagnostics |

If you set the `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, or
`XDG_STATE_HOME` environment variables to absolute paths, Leaflogue uses those
folders instead. **Settings** always shows the folders actually in use, under
**Storage locations**.

## The settings file is protected

Saved database URLs, sync keys, and AI keys are written to the settings file,
which only your user account can read (permission `0600`). Leaflogue checks
this every time it reads the file and refuses a file that other users could
read. Once saved, a key is never shown in the interface again.

To use a settings file somewhere else, start Leaflogue with
`LEAFLOGUE_CONFIG_FILE=/path/to/config.json`. Settings then shows that path
and cannot move it.

## Themes

**Settings → Appearance** chooses a theme and light, dark, or system mode.

To add your own theme, put its JSON file in the `themes` folder next to your
settings file (`~/.config/leaflogue/themes/`). **Settings → Appearance → Open
folder** opens it for you. Make the file private to you:

```sh
install -m 600 my-theme.json ~/.config/leaflogue/themes/my-theme.json
```

Leaflogue notices the new file straight away, even while it is open, and lists
the theme in Settings. Editing or deleting a file there updates the app the
same way. If a file can't be used, for example because its text would be hard
to read or other users could open it, Settings names the file and says why, and
your other themes keep working.

A theme can also set a `chart` colour for its bars, calendar, and meters;
without one they use the theme's accent colour.

**Export theme** and **Import theme** move a theme between computers as a JSON
file. An imported theme is copied into the same `themes` folder.

## Page layouts

The layouts you make with **Customise** are saved in the settings file under
`dashboards`, one list for `library` and one for `statistics`. Each entry
names a widget and, for panels, an optional `width` (`third`, `half`,
`two-thirds`, or `full`) and `tall`:

```json
"dashboards": {
  "statistics": [
    { "widget": "passages" },
    { "widget": "activity", "width": "full" },
    { "widget": "top-books", "tall": true }
  ]
}
```

Widgets are `passages`, `notes`, `books`, `finished`, `active-days`,
`longest-run`, `busiest-day`, `activity`, `top-books`, `top-authors`,
`months`, `weekdays`, `coverage`, `lengths`, `finished-years`, `series`,
`daily`, `on-this-day`, `reading-now`, `hours`, `recent`, and `pick-up`. On
the library page, `{ "widget": "shelf" }` stands for your list of books:
widgets after it show below your books. Leave a page out to use its default
layout. If a list can't be read,
Leaflogue uses the default layouts and says so when you next choose
**Customise**.

[Custom widgets](/widgets/custom-widgets/) you build are saved under
`widgets`, and a page places one as `{ "widget": "custom:<its id>" }`.

The [web app](/web/overview/) keeps each reader's layouts with their account
instead, so they don't appear in this file.
