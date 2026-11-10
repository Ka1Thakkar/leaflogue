# Contributing to Leaflogue

Thank you for helping build a private, local-first home for reading notes.
Leaflogue is licensed under AGPL-3.0-or-later, and contributions are accepted
under the same licence: by opening a pull request you agree that your change
may be distributed under it. There is no separate copyright assignment.

## Before you start

- Read [`docs/status.md`](docs/status.md), [`docs/roadmap.md`](docs/roadmap.md),
  and the quality guardrails in
  [`docs/architecture.md`](docs/architecture.md#quality-guardrails).
- For anything larger than a small fix, open an issue first so the approach can
  be agreed before you invest time. Roadmap items are good starting points.
- Never include personal reading data, real Kobo databases or Kindle clippings,
  credentials, or copyrighted book text in issues, fixtures, or screenshots. Use
  the synthetic fixtures in `packages/importers/src/fixtures` as a model.
- Security problems go through the private process in [`SECURITY.md`](SECURITY.md),
  never a public issue.

## Development

Use Node 22.22.2 or newer (see `.nvmrc`) and the npm version pinned in
`package.json` through Corepack:

```sh
corepack enable
npm ci
npm run dev                                        # the desktop app
npm run dev:local --workspace @leaflogue/server    # the web app's API, no sign-in
npm run dev --workspace @leaflogue/web             # the web app, on http://localhost:5180
```

The [README](README.md#build-and-run) explains how to keep a development run
away from an installed Leaflogue.

`npm run check` is the quality gate: formatting hygiene, ESLint with the
architectural import boundaries, every workspace typecheck, all tests, and the
production build. It must pass before a pull request is reviewed. Interface
changes should also pass `npm run test:e2e` (desktop) and `npm run test:web`
(the web app against a local server); CI runs both.

## Making a change

- Keep a change to one reviewable slice. A reading-data mutation is complete
  only when SQLite, PostgreSQL, and Convex implement the same behaviour and pass
  the same cases; the desktop may ship SQLite first only while sync is disabled,
  and the roadmap must say so.
- Match the surrounding code: its naming, comment density, and idioms. Comments
  explain why, not what.
- The renderer is untrusted. New desktop capabilities go through a fixed,
  validated IPC channel registered with `registerTrustedHandler`; the renderer
  never receives paths, SQL, credentials, or Node APIs.
- The desktop and web apps share one interface (`apps/desktop/src/renderer`)
  over the `window.leaflogue` bridge in `@leaflogue/contracts`. A new bridge
  method needs a web implementation in `apps/web/src/bridge`, and, if it stores
  something, a function with the same name and arguments in `convex/` and in
  `apps/server/src/functions.ts`. Something a browser cannot do is hidden with
  `useDesktop()` (or a host check such as `hasCustomWidgets`) and left out of
  the palette and Settings through the `host` field in
  `palette/settings-index.ts`, never shown and left to fail.
- The desktop and web interfaces share the design system; see
  [`docs/design-system.md`](docs/design-system.md) and
  [release readiness](docs/release-readiness.md) before changing layout.
- Add or update tests for the behaviour you change, and update `docs/status.md`,
  `docs/roadmap.md`, or `docs/oss-transition.md` when a checklist item moves.

## Commits and pull requests

Write commit subjects in the imperative with a conventional prefix (`feat:`,
`fix:`, `docs:`, `chore:`, `ci:`), and use the body to explain why the change is
needed. Fill in the pull-request template, including how you verified the change.

## Maintainer expectations

The maintainer aims to acknowledge new issues and pull requests within one week
and security reports within three working days. Review focuses on correctness,
data safety, privacy, accessibility, and parity across storage providers. A pull
request may be closed if it adds a dependency with an incompatible licence,
weakens a security boundary, or duplicates planned work without discussion.
Participation is governed by the [code of conduct](CODE_OF_CONDUCT.md).
