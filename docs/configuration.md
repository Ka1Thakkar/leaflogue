# Configuration profiles

Leaflogue validates one explicit profile at startup. It does not infer a public
deployment from partial environment variables.

| Profile | Storage | Authentication | AI keys | Network |
| --- | --- | --- | --- | --- |
| Desktop local | Local SQLite | None | Protected config, environment, or session memory | Off unless a feature is enabled |
| Desktop + sync | Local SQLite plus PostgreSQL or Convex | Database/runtime credential | Protected config, environment, or OS keyring | Configured database/provider only |
| Local web | PostgreSQL or Convex; no SQLite | None, loopback only | Server environment | Loopback by default |
| Self-hosted web | PostgreSQL or Convex; no SQLite | Password or Google | Server environment | HTTPS origin |
| Personal hosted | PostgreSQL or Convex; no SQLite | Google plus exact email allowlist | Server environment | HTTPS origin |

## Validation rules

- `none` authentication and a non-loopback bind are mutually exclusive.
- Google mode requires client ID, client secret, canonical public origin, and an
  exact redirect URI derived from that origin.
- Password mode requires a strong session secret and rate-limited credential
  endpoints; passwords use a memory-hard hash and are never recoverable.
- A database URL is consumed only by the Electron main process or deployed web
  server. Browser and Electron renderer bundles must never contain its value.
- Non-loopback PostgreSQL URLs must explicitly require TLS with
  `sslmode=require`, `sslmode=verify-ca`, or `sslmode=verify-full`.
- Desktop configuration is read from `LEAFLOGUE_DATABASE_URL`, or, for Convex,
  `LEAFLOGUE_CONVEX_URL` with `LEAFLOGUE_CONVEX_SYNC_KEY`, or from
  `config.json` in Leaflogue's platform configuration directory. On Unix, the
  file is rejected unless its permissions exclude group and other users.
- The desktop setup form may accept a connection value transiently. It sends the
  value over one validated IPC call, writes the configuration atomically with
  mode `0600`, clears the form after saving or closing, and never reads the saved
  value back into the renderer. A native save dialog can select another config
  file; Leaflogue remembers that location in a non-secret locator file.
- The self-hosted web application reads the same connection settings from its
  server environment and remains online-only. It has no SQLite cache.
- AI entry points exist only when the effective profile enables AI and a valid
  provider adapter is configured.
- Provider adapters cover OpenAI, Anthropic, Google Gemini, Mistral, xAI,
  DeepSeek, and explicitly configured OpenAI-compatible endpoints. Compatibility
  is validated per adapter rather than inferred from an endpoint label.
- Each provider has a config-controlled model allowlist, default model, optional
  endpoint, and capability flags. The UI model selector displays only that
  provider's configured allowlist.
- Database connection URLs and AI API keys may be stored only in the explicitly
  selected permission-`0600` configuration file or supplied through the process
  environment. The setup form accepts either value transiently, clears it after
  saving, and never reads it back into the renderer. OS-backed secret storage may
  be added later as a stronger optional backend, not a prerequisite.

The committed [`.env.example`](../.env.example) contains names and safe local
defaults only. Production deployment documentation must generate secrets rather
than encouraging users to keep placeholder values.

## Configuration ownership

Desktop appearance, database URLs, AI enabled state, provider/model catalogs,
AI keys, and sync credentials live in the protected config file or environment
so Linux installations can be controlled declaratively. The Electron main
process owns these values. A deployed web server reads equivalent settings from
its environment or mounted protected config; untrusted browser clients never
receive stored keys.

## Linux filesystem layout

Leaflogue follows the XDG base-directory split instead of treating Electron's
default `userData` directory as a home for everything:

| Purpose | Default path | Contents |
| --- | --- | --- |
| Config | `~/.config/leaflogue/config.json` | Human-editable version-1 JSON, setup marker, remote credentials, AI settings, appearance, dashboard layouts |
| Data | `~/.local/share/leaflogue/` | `library.sqlite`, its SQLite/device sidecars, and durable Electron state |
| Cache | `~/.cache/leaflogue/` | Disposable Chromium/Electron session and cache data |
| State | `~/.local/state/leaflogue/` | Logs and crash diagnostics |

Absolute `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, and
`XDG_STATE_HOME` values override those roots. Relative XDG values are ignored as
invalid. `LEAFLOGUE_CONFIG_FILE` can still select an explicit config document,
and the Settings interface shows the effective config, library, cache, and state
paths so the active source is not ambiguous.

Fresh desktop profiles open a keyboard-contained setup dialog that explains
these four paths before offering local-only, PostgreSQL, or Convex operation.
Connection values use the same one-way protected-config write as Settings and
the final review contains only redacted provider metadata. Completion is stored
as `setup.completedVersion: 1`; every optional choice remains available in
Settings after completing or deferring setup.

On the first launch after adopting this layout, Leaflogue preserves the effective
legacy config selection, then uses SQLite's backup API to make a validated,
coherent library snapshot (including committed WAL data). It publishes the
existing device identity before the database, can safely resume after an
interruption, and selects the last activated database when it encounters an
interrupted legacy restore. Sources must be regular, non-symlink,
current-user-owned files, and existing destinations are never overwritten. The
old directory is deliberately retained for manual recovery; Chromium cache is
not migrated.

## Appearance configuration

The desktop settings screen atomically writes a validated theme and mode to the
same permission-`0600` configuration document while preserving all other
sections. The equivalent declarative configuration is:

```json
{
  "version": 1,
  "appearance": {
    "themeId": "rose-pine",
    "mode": "dark"
  }
}
```

`mode` accepts `light`, `dark`, or `system`. Built-in `themeId` values are
`leaflogue`, `everforest`, `catppuccin`, `rose-pine`, `tokyo-night`, and `nord`.
Fresh installs use `leaflogue` with `system`. An unavailable ID or malformed
appearance section is reported and falls back to that safe default; it is never
partially applied.

Custom themes live in a `themes` folder beside the active config file
(`~/.config/leaflogue/themes/` by default). Every `.json` file in that folder is
read when Leaflogue starts and again whenever a file there is added, changed, or
removed, so a new theme shows up in Settings without editing the config. Select
it by its `id`, either in Settings or with `appearance.themeId`.

Start from [`theme.example.json`](../theme.example.json), give the copy a unique
lowercase ID, and protect it:

```sh
install -m 600 theme.example.json ~/.config/leaflogue/themes/quiet-library.json
```

Each file in the folder gets the checks below on its own. A file that fails is
skipped and named in Settings with the reason, and the other themes still load.
Files are read in name order, at most 64 of them. When two files share an ID the
first by name wins and the other is reported, except for older copies left by
**Import theme** (named `<id>-<hash>.json`), which are passed over quietly.

A theme kept elsewhere can still be referenced explicitly with
`appearance.themeFile`. A relative path is resolved from the directory
containing the active config file; an absolute path can point outside it. The
referenced file wins over a folder file with the same ID:

```json
{
  "version": 1,
  "appearance": {
    "themeId": "quiet-library",
    "mode": "system",
    "themeFile": "/Users/me/dotfiles/leaflogue/quiet-library.json"
  }
}
```

The manifest must contain exactly `version`, `id`, `name`, `light`, and `dark`.
Both variants must define every documented semantic token in the example using
lowercase six-digit hex. `chart` is the one optional token: the colour of bars,
the activity calendar, meters, and the current tab. Without it those use `pen`.
Accent colours (`pen`, `highlighter`, `chart`) colour figures and labels only
where they are readable on the theme's page and panels; elsewhere text stays in
`ink`. Only translucent wash, hairline, edge, and shadow
tokens may use eight-digit hex. Leaflogue rejects raw CSS, URLs, functions,
unknown fields, reserved IDs, unreadable contrast (WCAG 2.2 AA: 4.5:1 for
body, muted, navigation, danger, button, and cover text on every surface they
appear on, and 3:1 for focus indicators, field boundaries, and danger icons),
symlinks, non-regular files,
files over 32 KiB, files not owned by the current user, and Unix permissions
other than `0600`.

Symbolic links are judged from the protected config directory. Leaflogue
resolves that directory to its real location once, so links at or above it are
fine: macOS's `/var` → `/private/var`, a linked home directory, or a config
directory managed by a dotfiles tool. Below it, a relative `themeFile` must not
pass through any link, whether an intermediate directory or the theme file
itself. An absolute `themeFile` has no trusted directory of its own, so it must
be the file's canonical path (for example `/private/var/…` rather than
`/var/…` on macOS); a linked absolute path is reported rather than followed. A rejected manifest is reported and the complete built-in
Leaflogue theme is used at startup; no subset of an invalid theme is activated.
Individual tokens of any available theme can be adjusted in the config file
alone with `appearance.overrides`, keyed by theme ID and variant. Only the
semantic roles listed in the example manifest are accepted, with the same
lowercase-hex grammar (eight-digit alpha only for translucent roles):

```json
{
  "version": 1,
  "appearance": {
    "themeId": "nord",
    "mode": "dark",
    "overrides": { "nord": { "dark": { "pen": "#8fbcbb" } } }
  }
}
```

The adjusted theme must still pass every contrast rule above. An unknown role,
invalid colour, unavailable theme ID, or contrast failure is reported and the
whole overrides section is ignored, while the selected theme and mode stay in
effect; overrides are never partially applied. The settings screen does not
edit overrides and preserves them verbatim when it saves.

While Leaflogue is running it watches the canonical locations of the protected
config, the referenced theme, and the `themes` folder, the same paths it
validates, so editors that replace files atomically are supported.
Valid replacements update renderer and native-window colors together without a
restart. An invalid replacement reports its error while keeping the last fully
validated theme active.

Themes move between computers as files rather than inside library data. In
Settings, **Export theme** saves the theme exactly as it is rendered, overrides
included, as a version 1 manifest with permission `0600`; a built-in theme is
exported as an editable copy with its own ID (for example `nord-custom`).
**Import theme** reads a chosen manifest once without following links, applies
every check above, copies it into the `themes` folder beside the protected
config with permission `0600`, and selects it. The chosen file itself is never
referenced afterwards, so it may live anywhere and keep ordinary permissions. A
refused import leaves the config and current theme unchanged. Re-importing a
theme with the same ID points the config at the new copy; earlier copies stay
in the folder, unused, until you remove them.

## Dashboard layouts

The library overview and the Statistics page are each an ordered list of
widgets stored under `dashboards.library` and `dashboards.statistics`. Each
entry is `{ "widget": <id> }` with, for panels only, an optional `width`
(`third` by default, `half`, `two-thirds`, `full`) and `tall: true` (two grid
rows). Widget IDs are defined once in `@leaflogue/contracts`
(`DASHBOARD_WIDGET_IDS`) and any widget may appear on either page. A missing
page uses the built-in default, and saving a layout equal to that default
removes the entry so later default changes still arrive. Unknown fields,
unknown or repeated widgets, and invalid widths are rejected on save; a
hand-edited section that fails the same checks is reported and both pages fall
back to their defaults. Saving one page replaces only that page's list and
leaves every other setting untouched.

The library list may also contain `{ "widget": "shelf" }`, which marks where
the page's own books (tabs, search and the book grid) sit: widgets after it
show below the books. It never takes a width or height. A library layout
without it gets it appended at the end, and other pages ignore it.

A layout may also place the reader's own widgets as `{ "widget": "custom:<id>" }`
(see below), with the same optional `width` and `tall` as a panel; a custom
widget that shows a number is a tile and ignores both. A placement whose
widget no longer exists is dropped when the layout is read or saved, and
deleting a widget removes its placements from both pages in the same write.
A layout may hold up to 24 entries beyond the built-in widgets.

The web app keeps layouts per reader and library on its backend instead:
`leaflogue_web.dashboard_layouts` on the server (web schema 2) and the
`dashboardLayouts` table on Convex, through `dashboardRuntime:layouts` and
`dashboardRuntime:saveLayout`. Any reader of the library may save their own;
they are never synced. Both validate with `parseDashboardLayout` from
`@leaflogue/domain`, the same check the settings file uses, with custom
widgets refused.

Custom widgets are off in the web app: its bridge rejects `widgets.*`, and the
interface hides **New widget**, **Import widgets** and the widget toolbar
because the web host does not set `customWidgets`. Someone deploying their
own web app who wants them implements `widgets` in
`apps/web/src/bridge/dashboards.ts`, stores them on their backend, allows
`custom:` placements there, and sets `customWidgets: true` on the host passed
to `createWebBridge`.

## Custom widgets

Widgets built with **New widget** are stored under `widgets` as a list of
recipes. The same recipe, wrapped as
`{ "format": "leaflogue-widget", "widget": { … } }`, is the
`.leaflogue-widget.json` file that **Export** writes and **Import widgets**
reads. A recipe is data only: it names what to count, how to group and filter
it, and which chart draws it. The format, field list and limits are defined in
`@leaflogue/contracts` (`CustomWidget`, `WIDGET_FIELDS`, `WIDGET_LIMITS`);
validation (`parseCustomWidget`) and counting (`evaluateWidget`) live in
`@leaflogue/domain`, so every client counts a shared recipe the same way.

```json
"widgets": [
  {
    "id": "favourites-by-weekday",
    "version": 1,
    "title": "Favourites by weekday",
    "description": "When I tag passages favourite",
    "count": "passages",
    "groupBy": "weekday",
    "where": [{ "field": "tag", "is": "favourite" }],
    "show": "bars",
    "limit": 7,
    "sort": "label"
  }
]
```

| Key | Value |
| --- | --- |
| `id` | Lowercase letters, digits and dashes, at most 48 characters, unique in the list. |
| `version` | `1`. A recipe with any other version is refused. |
| `title` | 1–60 characters. `description` is optional, up to 160. Control and bidirectional-override characters are refused. |
| `count` | `passages`, `books` (on the shelf, not archived), or `notes`. |
| `show` | `number`, `bars`, `ranked`, `heatmap` (passages or notes per local day), or `list` (the newest passages or notes, or books by title). |
| `groupBy` | Required by `bars` and `ranked`, refused by the others. |
| `where` | Up to six filters, each `{ "field", "is" }` or `{ "field", "isNot" }`; all must match. |
| `limit` | 1–50 groups or items; not used by `number` or `heatmap`. Defaults: 24 for `bars`, 6 for `ranked`, 4 for `list`. |
| `sort` | `count` (largest first) or `label` (the field's own order); `bars` and `ranked` only. With `label`, a year grouping keeps the latest years. |

Fields, and the counts that can use them:

| Field | Counts | Values |
| --- | --- | --- |
| `length` | passages, notes | `short` (≤100 characters), `medium` (101–300), `long` (301–600), `longest` (over 600) |
| `hour` | passages, notes | `0`–`23`, local time; only passages whose device recorded a time, notes written in Leaflogue, and imported notes on such passages |
| `weekday` | passages, notes | `mon`–`sun` |
| `month` | passages, notes | `jan`–`dec` |
| `year` | passages, notes | a four-digit year, `this-year`, or `last-year` |
| `has-note` | passages | `yes`, `no` |
| `tag`, `thread` | passages | a name; a passage counts once under each of its tags or threads |
| `book` | all | a title (matches the book's title) |
| `author` | all | a name; a book counts under each author |
| `series`, `publisher`, `language` | all | the book's value, as imported or edited |
| `status` | all | `unread`, `reading`, `finished`, `paused` |
| `finished-year` | all | as `year`; only finished books with a known finish date |

Times are the reader's local time zone. A passage is dated when its device
recorded it being highlighted, otherwise when it was added; an imported note
takes its passage's date. Names match case-insensitively after Unicode
normalisation. Something with no value for the grouping field is left out of
the groups and reported as missing.

Unknown keys, unknown fields or values, a field the count lacks, and repeated
IDs are refused. At most 24 widgets are kept. A hand-edited `widgets` section
that fails these checks is reported when you next choose **Customise**, its
widgets are not shown, and saving a widget from the app replaces it. Widget
files are read once without following symbolic links, must be regular files
of at most 16 KiB, and are validated in full before anything is written: one
bad file refuses the whole import. An imported widget identical to one already
kept (ignoring its ID) is skipped; one whose ID is taken gets a new ID. The
desktop counts recipes in the main process over a snapshot of the library
(`widgets:evaluate`); the renderer never sees the snapshot.

## AI configuration

[`config.ai.example.json`](../config.ai.example.json) records the intended shape.
`ai.enabled` defaults to `false`.

Google Gemini is offered without any catalog in the config, so a free Google AI
Studio key works out of the box. Its default models are the current free-tier
Flash and Flash-Lite models the free tier serves reliably (`gemini-2.5-flash`,
the default, `gemini-2.5-flash-lite`, `gemini-3.5-flash-lite`, and
`gemini-flash-lite-latest`; newer previews are often busy or slow), and its key is read from `GEMINI_API_KEY` unless one is
saved in Settings. A `gemini` entry that omits `models` and `defaultModel`
inherits that list, so it follows Leaflogue releases; declaring both pins your
own list. Saving settings writes only the fields you changed, never a copy of
the inherited list.

To use a free key:

1. Sign in to [Google AI Studio](https://aistudio.google.com/apikey) and create
   an API key.
2. In Leaflogue, open **Settings**, choose **Google Gemini** under Optional AI,
   paste the key, and save. The key is stored only in the permission-`0600`
   config. Alternatively, export `GEMINI_API_KEY` before starting Leaflogue and
   leave the field empty.
3. Free-tier requests are limited per minute and per day, and Google may use
   free-tier prompts and responses to improve its products. Use a paid key or
   another provider for passages you would rather keep out of that.

Other providers still need their own catalog entry.

Before Leaflogue sends anything to a provider it shows exactly what would be
transmitted and records the reader's acceptance as `consentAcceptedAt` on that
provider. The trusted runtime refuses to resolve a provider without it, so
clearing that field in the config asks again on the next request. Each provider declares the models exposed by
the UI and one default model. A provider may use `apiKeyEnv` to avoid putting a
key in JSON, or the desktop setup form may write `apiKey` into its protected
configuration. Logs, exports, IPC responses, and configuration summaries redact
both forms. Disabling AI prevents provider requests as well as hiding AI actions.
Saving AI settings must replace only the `ai` section atomically and preserve
the `sync` section (and vice versa), including when a custom config path is used.
Choosing a different config path copies the complete active protected document
before changing the locator, so provider catalogs and saved credentials remain
available. The active document is authoritative; choosing an existing destination
replaces its old settings after the native overwrite confirmation. The previous
protected file is retained for recovery and the UI tells
the user to remove it manually when it is no longer needed. When
`LEAFLOGUE_CONFIG_FILE` selects the file, the UI cannot override that location.
The storage threat model and the explicit decision to use protected portable
configuration rather than Electron `safeStorage` are recorded in
[`ADR 0002`](decisions/0002-protected-secret-config.md).

## PostgreSQL bootstrap

The desktop settings screen accepts PostgreSQL or Convex configuration and then
exposes only redacted metadata. PostgreSQL provides **Check connection** and
**Initialize schema** actions. Initialization takes an advisory transaction lock
and creates only the versioned `leaflogue` schema. Its migrations include
libraries, devices, books, highlights, notes, creation/update timestamps, and an
ordered sync-change log. Repeating initialization is safe.

## Serving the web client from PostgreSQL

The web client cannot talk to PostgreSQL directly, so a library synced through
PostgreSQL is served to browsers by `apps/server`, a small Node service over
the same library code the desktop's sync uses. Edits made through it reach
desktops like any other device's.

Build and run it:

```bash
npm run build --workspace @leaflogue/server
node apps/server/dist/server.mjs
```

It reads everything from its environment; set these directly or map them in
from a secret manager:

| Variable | Required | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | yes | The PostgreSQL connection string, the same database the desktops sync with. |
| `LEAFLOGUE_PUBLIC_URL` | yes | The origin readers open, such as `https://reading.example.com`. Must be https, except `http://localhost`. |
| `LEAFLOGUE_OIDC_CLIENT_ID`, `LEAFLOGUE_OIDC_CLIENT_SECRET` | yes | An OAuth client for a web application, with `<public URL>/auth/callback` as its redirect URI. |
| `AUTH_ALLOWED_EMAILS` | yes | Comma-separated emails that may sign in. Removing one ends its sessions. |
| `LEAFLOGUE_OIDC_ISSUER` | no | Another OpenID Connect provider; Google (`https://accounts.google.com`) by default. |
| `LEAFLOGUE_LIBRARY_ID` | no | Which library to serve when the database holds several. With one, it is used; with none, one is created at first sign-in. |
| `LEAFLOGUE_WEB_ROOT` | no | The built web client (`apps/web/dist`), served from the same origin. |
| `LEAFLOGUE_AUTH` | no | `oidc` (the default) or `none`: one local reader with no sign-in, refused unless `HOST` and `LEAFLOGUE_PUBLIC_URL` are loopback. The OIDC and email variables are then not needed. |
| `HOST`, `PORT` | no | Where to listen; `127.0.0.1:8787` by default. Put it behind a TLS proxy. |
| AI keys, `LEAFLOGUE_AI_HOURLY_LIMIT`, `GOOGLE_BOOKS_API_KEY` | no | As for Convex, below. |

At start it brings the database up to date: the desktop's `leaflogue` schema
(as **Initialize schema** would; a newer server can therefore ask older
desktops to update) and its own `leaflogue_web` schema, which holds sign-ins,
sessions, AI settings, public links, browser-import history, and each
reader's dashboard layouts. That schema
has its own version, so adding to it never changes the version desktops
check. Nothing in it is synced.

Every allowed email becomes an owner of the library. Sessions are random
tokens in an HttpOnly, SameSite cookie, stored only as hashes; API calls must
come from the public origin as JSON. The server answers `/config.json` with
`{"backend":"server"}`, which is how the web client knows its backend.

`deploy/web/` packages the server and the built web client as one container
(`deploy/web/Dockerfile`, built from the repository root) with a compose
example that adds PostgreSQL 16; the docs site's *Host the web app with
PostgreSQL* walks through it.

For development, `npm run dev:local --workspace @leaflogue/server` runs the
server on an in-memory PostgreSQL (PGlite; `LEAFLOGUE_DEV_DATA` keeps it in a
folder) with `LEAFLOGUE_AUTH=none`. With `LEAFLOGUE_WEB_ROOT` it also serves a
built web client, and `npm run dev --workspace @leaflogue/web` proxies to it
on port 8787. `npm run test:web` builds the client, serves it this way, and
drives it in a browser.

## Convex sync

Convex is an optional, hosted alternative to PostgreSQL. Leaflogue's backend
ships as a release-matched source bundle; you deploy it to your own Convex
project and protect it with a **sync key** that you create once. The desktop
then needs only the deployment URL and that key. You do not need a repository
checkout.

### What the sync key is

- A long random secret stored on the deployment as the environment variable
  `LEAFLOGUE_SYNC_KEY`, and entered once on each desktop.
- Every Leaflogue sync call carries it, and the deployment refuses any call
  whose key does not match. A deployment without the variable refuses all sync.
- It lets a desktop read and write **this deployment's library** and run
  Leaflogue's fixed, bounded compatibility steps before sync. It cannot deploy
  code, change environment variables, select arbitrary functions, or delete the
  deployment; those stay with the Convex CLI and your Convex account (or a
  deploy key in CI). The desktop never asks for a deploy key.
- The deployment URL is **not** a secret: it appears in logs, screenshots, and
  any web client. The key is what protects your library.
- The desktop keeps the key in its protected configuration file (mode `0600`)
  and uses it only in its background process. Settings never shows it again.

### Set up a new deployment

You need Node.js 22.22.2 or later and a free Convex account.

1. Open the GitHub release whose version exactly matches your desktop. Download
   `Leaflogue-Convex-VERSION.tar.gz`, its `.manifest.json`, and
   `SHA256SUMS-convex.txt` into one empty directory. Replace `VERSION` below
   with that release number, without the leading `v`, then verify and extract:

   ```sh
   sha256sum --check SHA256SUMS-convex.txt
   tar -xzf Leaflogue-Convex-VERSION.tar.gz
   ./leaflogue-convex-VERSION/deploy.sh
   ```

   The deploy command installs the bundle's lockfile-pinned Convex CLI locally, asks you
   to log in, creates or selects a project, pushes once to your personal
   development deployment, and saves that selection inside the extracted
   directory. A development deployment is fine for personal use. Convex's
   [official CLI guide](https://docs.convex.dev/cli/overview) describes the same
   `convex dev --once` setup underneath this wrapper.

   A URL in Leaflogue's `.env` or Settings does not select a deployment for the
   Convex CLI. If `npx convex env set` reports that `CONVEX_DEPLOYMENT` is
   missing, configure/select the existing project with `npx convex dev --once`
   from the backend directory first, and verify that its deployment URL matches
   the one in Leaflogue before setting the key. Convex records that CLI selection
   in its local `.env.local`; both `.env` and `.env.local` are ignored by Git.

   To target the project's production deployment, first select/configure the
   project normally or provide a production `CONVEX_DEPLOY_KEY`, then run
   `./leaflogue-convex-VERSION/deploy.sh --production`. Convex documents how
   [`convex deploy` selects production](https://docs.convex.dev/cli/reference/deploy).

2. Create the sync key on that deployment, then print it so you can copy it.
   Use the first pair for a personal development deployment, or the second pair
   after deploying with `--production`:

   ```sh
   cd leaflogue-convex-VERSION

   # Development deployment
   npx convex env set LEAFLOGUE_SYNC_KEY "$(openssl rand -base64 32)"
   npx convex env get LEAFLOGUE_SYNC_KEY

   # Production deployment
   npx convex env set --prod LEAFLOGUE_SYNC_KEY "$(openssl rand -base64 32)"
   npx convex env get --prod LEAFLOGUE_SYNC_KEY
   ```

   Treat the printed value like a password. Keys shorter than 32 characters
   are rejected.
3. In Leaflogue, open **Settings → Remote library**, choose **Convex**, paste
   the deployment URL (printed in step 1 and shown in the Convex dashboard,
   e.g. `https://quiet-otter-123.convex.cloud`) and the sync key,
   then choose **Save connection**.
4. Choose **Check connection**. It confirms the deployment runs a Leaflogue
   version this desktop supports. Then choose **Sync now**. The first sync
   creates the deployment's library and uploads this desktop's reading data.
5. On each other desktop, repeat step 3 with the **same** URL and key, then
   choose **Sync now**.

Once a provider is configured, the desktop syncs a couple of seconds after it
opens, and again whenever you choose **Sync now** or the refresh button in the
header. The header shows whether it is syncing, synced, paused, or failed; a
sync that pulls changes reloads the open page. A run continues pass after pass
while each one makes progress, so a large first sync finishes in one go.

Maintainers with an **empty, disposable development deployment** can run the
opt-in `npm run test:convex:live` from this checkout after deploying this
backend. Put `LEAFLOGUE_CONVEX_URL` and `LEAFLOGUE_CONVEX_SYNC_KEY` in ignored
`.env`, select that exact deployment with the Convex CLI so ignored `.env.local`
contains the matching `CONVEX_DEPLOYMENT`/`CONVEX_URL`, and keep both files
readable only by your user. The test writes synthetic books/notes, drives three
isolated desktop SQLite profiles, rotates the deployment's sync key, checks refusal,
and restores the original key. It does **not** clear remote test data, exercise
the packaged UI, or belong in the default quality gate. Never run it against a
deployment with personal or shared data.

The separate packaged UI check uses the same ignored `.env` and CLI selection.
Build a fresh unpacked Linux package with
`npm run package:dir --workspace @leaflogue/desktop`, then run
`LEAFLOGUE_PACKAGED_EXECUTABLE="$PWD/apps/desktop/dist/linux-unpacked/leaflogue" npm run test:convex:packaged:live`.
It launches two temporary XDG profiles, enters the URL/key through Settings,
exchanges synthetic reading data in both directions, and proves that a wrong
saved key is refused before the correct key restores sync. It does not rotate
the deployment's sync key or stand in for release AppImage/tarball testing on two
physical devices. Like the service test, it writes remote synthetic data and
must never target a deployment with personal or shared data.

For managed or declarative setups, the desktop also reads
`LEAFLOGUE_CONVEX_URL` and `LEAFLOGUE_CONVEX_SYNC_KEY` from its environment,
or a config file entry naming another variable:

```json
{ "version": 1, "sync": { "provider": "convex", "deploymentUrl": "https://quiet-otter-123.convex.cloud", "syncKeyEnv": "MY_LEAFLOGUE_KEY" } }
```

### Change the key or cut off a lost device

Every desktop shares one key, so the way to cut off a lost or retired device
is to replace the key:

```sh
# Development deployment
npx convex env set LEAFLOGUE_SYNC_KEY "$(openssl rand -base64 32)"

# Production deployment
npx convex env set --prod LEAFLOGUE_SYNC_KEY "$(openssl rand -base64 32)"
```

The old key stops working immediately. On each desktop you keep, open
**Settings → Remote library**, leave the URL blank, paste the new key, and
choose **Save connection**. Unsent changes stay queued until then.

### Update Leaflogue on the deployment

After updating the desktop, download and verify that release's Convex bundle,
extract it, and run its `deploy.sh` again (`--production` for production). The
new extracted directory asks you to select the existing project; it never needs
the desktop sync key to deploy. This desktop accepts Convex schema 17 with
mutation contracts 22 or 23. Contract 23 adds thread sync, so **update every
desktop first, then the deployment**: desktops older than this release accept
contracts only up to 22 and refuse a contract-23 deployment until they are
updated. Against a contract-22 deployment this desktop sends its queued
changes in order until it reaches one that deployment cannot store (a thread,
a new or edited passage, a book with reading history, or a daily pick). It
stops there with "Update the Convex deployment…" in Settings, and that change
and everything after it stay queued on this device. Sync does not pull until
then. Once the deployment is updated, the next **Sync now** sends everything
and nothing is dropped. **Check connection** names the exact release archive and
deploy command when the backend is outside the window; sync stays off until it
is compatible. **Sync now** applies bounded data migrations automatically before
exchanging reading data.

### Troubleshooting

| Message in Leaflogue | Meaning and fix |
| --- | --- |
| "Leaflogue could not reach the Convex deployment" | Check the URL and your network. |
| "…status function is unavailable" | The URL is not a Leaflogue deployment, or `npx convex deploy` has not been run. |
| "No CONVEX_DEPLOYMENT set" from the CLI | A Leaflogue URL is not a CLI project selection. Select the existing project with `npx convex dev --once` before setting its key, then verify the URL. |
| "This desktop supports Convex schema N…" | Desktop and deployment versions differ: update whichever is older and redeploy. |
| "Configure a sync provider, and a sync key for Convex…" | The deployment has no `LEAFLOGUE_SYNC_KEY`, or this desktop has no key saved. |
| "The sync provider rejected the configured credentials" | The desktop's key does not match the deployment's. Paste the current key. |
| "Leaflogue could not select a remote library…" | The deployment holds more than one library, which this desktop cannot choose between. |

### Web-client sign-in (not used by the desktop)

The standalone backend signs web-app readers in with Convex Auth and Google
(`convex/auth.ts`, `convex/http.ts`, and the auth tables in `convex/schema.ts`).
`auth.config.ts` trusts only the deployment's own issuer (`CONVEX_SITE_URL`).
The desktop never signs in: it keeps authorizing with the sync key.

| Variable | Meaning |
| --- | --- |
| `AUTH_ALLOWED_EMAILS` | Comma-separated emails that may sign in. Unset, nobody can, so a deployment used only for desktop sync stays closed. Checked when an account is created and before every new session. |
| `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | A Google OAuth web client whose redirect URI is `<deployment>.convex.site/api/auth/callback/google`. |
| `SITE_URL` | Where the web app is served; sign-in returns there. |
| `JWT_PRIVATE_KEY`, `JWKS` | The keys sessions are signed with. The backend bundle's `sign-in-keys.mjs` (from `scripts/convex-sign-in-keys.mjs`) creates and stores them without printing them. |

Each allowed reader is provisioned as owner of the deployment's one library
(`access:provisionHostOwner`) and keyed by user, not session
(`hostIdentity.ts` reads the user from Convex Auth's `userId|sessionId`
subject), so a new sign-in is the same reader. `auth:account` returns the
reader's email for the account panel.

The web client is static (`apps/web/dist`) and names no deployment. Served by
anything other than `apps/server` (which answers `/config.json` with
`{"backend":"server"}`), it asks the reader for their deployment's address,
checks it answers `setup:status` as Leaflogue, keeps it in that browser's
local storage, and signs in to it; Settings can switch to another. A host
never chooses whose library the page opens.

### Hosting Leaflogue's backend in another Convex app

A Convex deployment has one schema and one set of functions, so another app
can share a deployment with Leaflogue only by hosting Leaflogue's backend
inside its own. The desktop then syncs with that deployment as usual, and the
host's signed-in user reads and edits the same library.

1. From this repository, copy the backend into the host project:

   ```sh
   npm run export:convex-host -- ../host-app
   ```

   Leaflogue's modules go into the host's `convex/` under their own names (the
   desktop calls functions such as `syncRuntime:pull` by name). The export
   refuses to overwrite a host module with the same name, so rename those
   first. `schema.ts`, `auth.config.ts`, `auth.ts`, `http.ts`, and `crons.ts` stay the
   host's. `convex/leaflogue-backend.json` records what was copied and the
   schema and contract versions; run the export again after each Leaflogue
   update and redeploy.
2. Add the shared packages to the host's `package.json`, as the export
   prints (by default `file:vendor/leaflogue/ai`, `catalog`, `contracts`,
   `domain`, and `importers`). The modules use the first four; `importers` is
   for a host's browser import, which reads files with the desktop's own
   importers and sends the result to `importRuntime:*`.
3. Spread Leaflogue's tables into the host schema beside its own:

   ```ts
   import { leaflogueTables } from "./tables";
   export default defineSchema({ ...authTables, ...leaflogueTables, ...hostTables });
   ```

   Host table names must not collide with Leaflogue's (`books`, `highlights`,
   `notes`, `tags`, `collections`, `threads`, and the rest in `tables.ts`).
4. Sign-in is the host's: its `auth.config.ts` names its provider. After the
   host has decided a user may sign in, it calls the internal mutation
   `access:provisionHostOwner` with the user's identity key, which makes them
   owner of the deployment's library (creating it if needed). The key is the
   token identifier unless the host supplies its own `convex/hostIdentity.ts`
   (the export keeps it): Convex Auth's token identifier changes with every
   session, so a host using Convex Auth returns a key built from the user ID. The client
   finds the library with `access:myLibraries`, then uses the `reading:*`,
   `runtime:*`, `organizationRuntime:*`, `threadRuntime:*`, and
   `dailyRuntime:*` functions. A deployment still holds one library.
5. Set `LEAFLOGUE_SYNC_KEY` on the deployment, as in
   [Set up a new deployment](#set-up-a-new-deployment), and connect the
   desktop with it.

AI for web clients uses the provider and model the reader picks in
settings (`aiRuntime:settings`, `aiRuntime:setSettings`); the key is read
only from the deployment's environment, never stored or returned. Set the
variable for each provider you want to offer, for example
`npx convex env set GEMINI_API_KEY …`: `GEMINI_API_KEY`, `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `MISTRAL_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`, or
`LEAFLOGUE_AI_OPENAI_COMPATIBLE_KEY` with
`LEAFLOGUE_AI_OPENAI_COMPATIBLE_ENDPOINT`. `LEAFLOGUE_AI_HOURLY_LIMIT`
(default 30) caps requests per reader per hour.

Book lookup (`catalogRuntime:search`) asks Google Books, then Open Library.
`GOOGLE_BOOKS_API_KEY` is optional and raises Google's quota.

Edits made through those web functions carry a writer claim from a fixed web
device ID, so desktops pull them like any synced change, deletions included.
When a desktop and the web edit the same passage from the same starting point,
the desktop's edit wins and the web's is kept as a reviewable conflict, as
between two desktops.

### Upgrading an existing Convex deployment

Deploy a backend bundle within the new desktop's supported window. On the next
**Sync now**, the desktop calls the deployment's fixed migration orchestrator
before it sends or receives reading data. It advances in dependency order:
legacy highlight-tag book references, daily candidates, attached-note bounds,
then pending daily and highlight projections.

Each server call is idempotent and bounded: a backfill touches at most 50 rows,
the attachment step materializes at most two documents and updates one, and the
highlight projection moves or removes one membership. A desktop run makes at
most 100 calls. If work remains, Settings reports how many records changed and
asks you to choose **Sync now** again; it never skips unfinished work.

An oversized attached note, or one beyond the 200-note attachment limit, pauses
with a warning. Nothing changes unless you confirm that exact note. Confirmation
preserves its complete text as a standalone note, then the next bounded step
continues. A stale confirmation cannot detach a different note. Migration and
provider failures are returned as stable product codes; provider error text and
reading data are never shown in Settings or written to logs.

These compatibility calls use the saved sync key and cannot deploy code, change
environment variables, or invoke arbitrary Convex functions. No deploy key or
manual `npx convex run migrations:*` command belongs in the desktop.

### Provisioning an authenticated client by hand

This future-web workflow is not executable with the current key-only backend;
it applies only after a release explicitly enables and verifies OIDC. It does
not apply to desktop sync. Library access is never self-granted. First copy the exact deployment origin from the Convex dashboard and compare it
with the saved Leaflogue configuration. The bootstrap request deliberately
requires HTTPS, an origin-only URL, and no redirects. Validate that origin
before obtaining a short-lived OIDC token through the identity provider's normal
trusted login/tooling. The token's `iss` and `aud` claims must exactly match the
configured issuer and application ID. Then call `access:currentIdentity` once as
that user:

```sh
(
read -rp "Convex deployment URL from the dashboard: " LEAFLOGUE_CONVEX_URL
LEAFLOGUE_CONVEX_URL="$(node -e '
  try {
    const url = new URL(process.argv[1]);
    if (url.protocol !== "https:" || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash) process.exit(1);
    process.stdout.write(url.origin);
  } catch { process.exit(1); }
' "$LEAFLOGUE_CONVEX_URL")" || { echo "Unsafe deployment origin" >&2; exit 1; }
printf 'Verified deployment origin: %s\n' "$LEAFLOGUE_CONVEX_URL"
read -rsp "OIDC token: " LEAFLOGUE_ID_TOKEN; printf '\n'
printf 'Authorization: Bearer %s\n' "$LEAFLOGUE_ID_TOKEN" |
  curl --fail-with-body --silent --show-error \
    --proto '=https' --max-redirs 0 \
    --header @- --header 'Content-Type: application/json' \
    --data '{"path":"access:currentIdentity","args":{},"format":"json"}' \
    "$LEAFLOGUE_CONVEX_URL/api/query"
unset LEAFLOGUE_ID_TOKEN
)
```

This avoids putting the token in shell history or a file. Treat the returned
`tokenIdentifier` as account metadata and do not publish it. Convex CLI's
`--identity` flag is administrator impersonation, not identity-provider
verification, and must not be used to discover or validate this value.

An administrator can then provision a library and role through the internal
CLI-only mutation:

```sh
npx convex run access:provisionLibrary \
  '{"libraryId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","identityTokenIdentifier":"issuer-provided-token-identifier","role":"owner"}'
```

Use `--prod` for the production deployment. Repeating the command is safe and
updates the existing role. `owner` and `editor` may mutate reading data;
`viewer` can use the bounded read APIs but cannot mutate. The public read surface
paginates books, highlights, and notes independently with at most 100 items,
100 rows read, and 1 MiB read per page. Ordered sync changes use a
monotonic numeric sequence cursor and return at most 100 records. Responses omit
Convex document IDs, membership rows, library IDs, and internal byte accounting.
`access:revokeLibraryAccess` removes a membership and revokes that identity's
device sessions. The web client's login flow does not exist yet.

Change cursors pair the sequence with a library sync generation. If a client
receives `resetRequired`, it must discard its saved cursor and perform a full
resync before consuming changes again. After restoring or replacing a Convex
deployment, an administrator must rotate that generation once for every restored
library before allowing a future sync client to reconnect:

```sh
npx convex run access:rotateLibrarySyncGeneration \
  '{"libraryId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}'
```

Use `--prod` for production. This internal operation is idempotent only in the
safety sense—each successful call deliberately advances the generation—so run it
once per restore event. It prevents an old cursor from silently skipping newly
restored or replacement data.

Convex book merge preflights stored item counts and UTF-8 byte estimates before
loading reading documents. It keeps source reading-data rewrites below 400 items
and 8 MiB, organisation membership rewrites below 400 links, and status-history
rewrites below 200 events, leaving headroom under Convex transaction limits.
Larger books require a future staged merge protocol and are rejected atomically;
they are never partially moved.
Online highlight mutations return only the changed highlight. Attached notes are
an independently paginated read so an edit cannot accidentally return an
unbounded aggregate. Deleted and archived record metadata remains visible to an
authorized reader so a future sync client can converge instead of resurrecting
stale data.

The current bootstrap does not enable synchronization. The desktop remains the
offline source of work until the outbox, cursors, tombstones, and conflict rules
are implemented. The web application will use the online database without a
local SQLite layer.

Exports contain reading data and a versioned settings allowlist. They exclude
credentials, device tokens, local paths, temporary import copies, logs, and
deployment configuration.
