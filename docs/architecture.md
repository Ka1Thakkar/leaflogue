# Architecture

Status: accepted foundation; implementation details remain review-gated.

## Decisions

### One monorepo, several deployable applications

Desktop, web, server, and documentation live together so domain behavior,
import formats, design tokens, and compatibility tests cannot quietly diverge.
Applications may be deployed independently without becoming separate forks.

### Electron first

The first desktop shell uses Electron 44, React, TypeScript, and Vite through
electron-vite. Electron bundles Chromium and Node, which gives the Linux build a
consistent rendering/runtime surface and keeps the first implementation in one
language. A future Tauri shell remains possible because Electron APIs are kept
outside domain, importer, UI, and storage contracts.

The renderer is treated as untrusted:

- `nodeIntegration` is off;
- `contextIsolation` and Chromium sandboxing are on;
- the renderer loads only packaged local application code;
- preload exposes narrow, typed methods rather than `ipcRenderer`;
- every IPC payload and sender is validated in the main process;
- navigation, new windows, permissions, and external URLs are denied by default.

### SQLite belongs to the main process

Desktop reading data lives in one SQLite database under Electron's per-user app
data directory. The main process owns the connection and migrations. The first
adapter targets Electron's bundled `node:sqlite`, behind a storage interface, to
avoid shipping and rebuilding a native npm addon. Its release-candidate status
is an explicit compatibility risk and must be covered by database/migration tests.
The complete proposed model is in [`data-model.md`](data-model.md).

The renderer never receives a database path, SQL execution primitive, Node
filesystem access, or arbitrary file handle. It asks for product operations such
as `library.importFile`, `books.list`, and `notes.save` through typed IPC.

### Online database access stays outside the renderer

The self-hosted server owns its database connection and migrations. A desktop
may also use the explicitly configured self-operated PostgreSQL or Convex profile
through its trusted main process. Browser and Electron renderer code never
receives PostgreSQL URLs, Convex deployment keys, or administrator credentials.

SQLite, PostgreSQL, and Convex adapters share mutation input contracts and
revision/conflict semantics. A local CRUD operation is not considered available
to sync or the web client until its online adapters pass equivalent behavior
tests. The desktop may ship the SQLite behavior earlier while online sync remains
disabled; this must be visible in the roadmap rather than silently diverging.

### Local-first, optional sync

Local mode is a complete product. Sync is an adapter layered over stable entity
IDs, revisions, tombstones, and explicit conflict states. Connecting a server
does not replace the local database or make the desktop app unusable offline.
Import conflicts preserve immutable base, local, and incoming snapshots. Source
provenance advances only after the reader explicitly keeps the local edit or
accepts the incoming source value.

### Configurable authentication with safe combinations

The server supports Google OAuth, username/password, or no authentication. The
no-auth mode is valid only for an explicitly single-user server bound to loopback
or another protected local environment; startup rejects a public no-auth bind.
The private deployment uses Google OAuth plus a server-side email allowlist.

### AI is an optional capability

AI is disabled by default. A provider adapter defines model selection, request
shape, timeout, capability validation, and error normalization. Desktop API keys
may be entered through validated IPC and atomically stored in the same protected
permission-`0600` configuration used for database credentials, or referenced
through environment variables. Hosted keys remain server-side. Saved keys are
never returned to renderer or browser code. Disabling AI removes entry points
and prevents provider network requests rather than merely hiding a setting.

The accepted shell decision and its tradeoffs are recorded in
[`decisions/0001-electron-first.md`](decisions/0001-electron-first.md).

### One interface, two hosts

The desktop renderer (`apps/desktop/src/renderer`) is also the web app. It
talks only to `window.leaflogue`, the `LeaflogueBridge` in
`@leaflogue/contracts`. In Electron the preload script implements it over IPC;
in a browser, `apps/web` implements it over `apps/server`'s `/api/run` or a
Convex client, calling functions by the same names and arguments on either
backend, and boots the interface through `boot.tsx`. The bridge names its
host (`host.kind` is `web`), and the interface hides what a browser cannot do
with `useDesktop()` and the `host` fields of the palette and Settings index,
rather than offering it and failing.

## Dependency direction

```text
desktop renderer ─┐
web client ───────┼──> ui ───────────────> contracts
                  │                         ↑
desktop main ─────┼──> domain/importers ───┤
server ───────────┘     storage/sync/ai ────┘
```

Shared packages do not import Electron, Next.js, Convex, PostgreSQL drivers, or
application environment variables. Adapters depend inward on contracts; domain
code never depends outward on an adapter.

## Data flow

```text
Kobo SQLite / Kindle TXT / portable JSON
                    │
                    ▼
          bounded importer + review
                    │
                    ▼
        domain reconciliation transaction
                    │
             ┌──────┴──────┐
             ▼             ▼
      local SQLite    optional sync outbox
                           │
                           ▼
                 HTTPS Leaflogue API
                           │
                           ▼
                       PostgreSQL
```

Importing and sync never write directly from parsed, untrusted input. Validation,
normalization, duplicate review, and one database transaction sit in between.

## Quality guardrails

These are implementation rules, not aspirational style guidance:

- **Ports and adapters:** contracts describe product operations; Electron,
  SQLite, PostgreSQL, Convex, and model-provider code stay in edge adapters.
- **One mutation, one transaction:** related entity revisions, provenance, and
  sync-change records commit or roll back together. A database client cannot
  host overlapping transactions.
- **Membership snapshots:** book-level collection/tag changes advance the book
  and owning container revisions; passage-tag changes advance the passage, its
  book, and its tag. Sync treats collections and tags as entities, book upserts
  own book-level links, and passage upserts own passage-tag links. Deleting a
  container advances every affected owner before removing joins, so link state
  never depends on provider-specific row IDs or composite change identifiers.
  Containers are delivered before those membership-bearing owners. A deleted
  container wins over a stale owner link, while concurrent same-name container
  IDs remain distinct; interactive creates still reject accidental duplicates.
  Each book's collection list and each book/passage tag list is capped at 1,000
  entries at the transactional mutation boundary so every valid local state has
  a bounded sync representation. Book merge validates the distinct union before
  changing either book. Removal and idempotent inclusion remain available at
  the cap for recovery from older data.
  Replay adjusts container counters but never advances a revision it did not
  write: bumping a container or owner the incoming change does not claim would
  orphan that entity's writer claim and stop every later pull. Convex removes a
  large deleted container's links in scheduled batches after the tombstone
  commits; receivers already ignore links to tombstoned containers meanwhile.
  The same rule covers derived book counters: a passage or note replay updates
  them without revising the book. Threads follow the collection/tag model:
  passage snapshots own thread membership and a thread tombstone removes only
  memberships, never passages.
- **Grow-only reading history:** status events are immutable and keyed by ID.
  Book snapshots carry the complete set, receivers merge it even from a
  losing change, and only a winning snapshot may move an event between books.
  Book status itself still resolves by (revision, device) like any field.
- **One daily pick per day and time zone:** picks carry an immutable
  `createdAt`; on a same-slot collision every node keeps the earlier pick
  (then the lower ID) and retires the other as a tombstone, so arrival order
  never matters.
- **One sync credential per provider:** PostgreSQL sync uses its connection
  string and Convex sync uses the deployment's sync key (ADR 0006). Both live
  in the protected config or the environment and never reach the renderer.
- **Coded provider failures:** production Convex redacts plain error text, so
  authorization, session, and migration refusals are `ConvexError`s carrying a
  stable `LEAFLOGUE_*` code. Transports keep only that code and a fixed
  message; the desktop classifies sync problems by code, never by text.
- **Non-owning thematic threads:** thread membership advances the thread and
  highlight revisions in one transaction. Removing a thread deletes joins but
  never deletes the underlying passages or notes.
- **Deletion is a tombstone:** deleting a passage or note sets its deletion
  marker and advances its revision instead of erasing the row, so every
  provider's change feed carries it to other devices. A deleted passage takes
  its notes and memberships with it, advances each affected thread and tag,
  and outranks later imports of the same source record. Attached-note count and
  UTF-8 body limits keep this cascade within every provider's atomic budget;
  legacy rows outside those limits are detected with bounded reads and require
  an explicit migration before online sync is enabled.
- **Book-balanced rediscovery:** daily selection chooses an eligible book before
  choosing one of its passages, persists one timezone-scoped local-day record,
  canonicalizes equivalent timezone aliases, and avoids a bounded recent window
  when alternatives exist.
- **Provider-neutral full snapshots:** a full-sync payload groups book contents,
  organisation, and reading-status history under shared contracts. Provider
  credentials, local paths, and installation identity remain outside it. Local
  assembly runs inside one read transaction; protected file export streams
  status rows rather than materialising an unbounded timeline.
- **Parity by contract:** a mutation is not exposed to sync or web until SQLite,
  PostgreSQL, and Convex pass the same behavior cases.
- **Bounded remote aggregates:** online mutations return the entity they changed;
  child collections use paginated reads so provider transaction limits cannot
  turn an otherwise valid edit into an unbounded response.
- **Preserve local intent:** imports use stable source identities and never
  silently overwrite detached reader edits. Ambiguous reconciliation becomes a
  reviewable conflict.
- **Forward-only schemas:** older builds reject newer SQLite, PostgreSQL, and
  configuration schema versions instead of guessing or rewriting them.
- **Crash recovery:** destructive file replacement uses a durable journal, a
  last-known-good copy, and startup recovery. In-process rollback alone is not
  sufficient.
- **Secret confinement:** credentials are accepted transiently by trusted code,
  stored only in permission-`0600` config or environment variables, redacted at
  every outward boundary, and never mixed with reading-data exports.
- **Honest automation:** `npm run check` examines tracked and untracked source
  hygiene, enforces ESLint and architectural import boundaries, runs every
  workspace typecheck and test, and produces the production build.
- **Rendered-interface regression:** `npm run test:visual` drives the renderer
  preview in a real browser at a wide and a compact width, in Rosé Pine Main
  (dark), and compares each destination against a committed screenshot. It also
  exercises the keyboard and screen-reader workflows that need real layout and
  focus. It stays out of `npm run check` because it needs a downloaded browser
  (`npx playwright install chromium`) and because its baselines are
  per-platform: a run without an approved platform baseline fails rather than
  blessing the current output. Use `npm run test:visual -- --update-snapshots`
  explicitly to create or refresh one after an intentional change. Baselines
  live in `tests/visual/baselines`; review a changed one the way you would review
  the code that changed it.
- **Desktop end-to-end acceptance:** `npm run test:e2e` drives the built
  Electron app with Playwright's `_electron` API rather than the preview bridge.
  Each test gets a throwaway profile (XDG variables on Linux, `--user-data-dir`
  elsewhere), synthetic import files, and main-process answers to native file
  dialogs; renderer confirmations are answered in the page, because Electron
  shows them outside both. A `webRequest` guard denies non-application requests,
  and Chromium's net log must show no network activity at all. No product code
  carries a test-only seam. It stays out of `npm run check` because it needs the
  Electron binary and a display (`xvfb-run` on Linux CI).
- **Packaged boundary acceptance:** `npm run test:e2e:packaged` launches the
  executable extracted from the verified x64 AppImage with its ASAR intact. It
  reads the executable's fuse wire and requires every configured production
  fuse, then uses renderer CDP on a reserved loopback port to verify the
  production CSP blocks inline script and renderer connections and that Node
  globals remain absent. The test drives first-run setup and one persisted
  library mutation through the real preload/IPC boundary, verifies the isolated
  SQLite result, and requires Chromium's renderer/browser-service net log to be
  empty. That net log does not observe Node sockets opened by optional
  main-process providers; those adapters retain their own denial tests. Hosted
  Linux CI passes `--no-sandbox` because its runner cannot provide Chromium's
  user namespaces, so it does not prove the OS sandbox. The test does not enable
  Node inspection: Playwright's Electron main-process driver depends on that
  channel and therefore cannot automate native dialogs after production fuses
  are burned. The built-shell suite retains deep dialog/import/backup coverage
  until a black-box system driver can exercise those packaged paths.
