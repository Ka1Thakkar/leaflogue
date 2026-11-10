# ADR 0006: a deployment sync key authorizes desktop Convex sync

Status: accepted on 29 September 2026 by the maintainer; amended the same day
to authorize only Leaflogue's bounded compatibility migrations.

## Context

A Convex deployment URL is public by design: it appears in logs, screenshots,
and every web bundle that talks to the deployment. Something other than the URL
must therefore authorize reading-data sync.

The first implementation used OpenID Connect: each desktop signed in through the
system browser against a provider the deployment trusted, with a per-identity
library membership and per-device sessions. It worked end to end in tests, but it
required every self-hoster to register an OAuth client with a provider such as
Google before syncing their own library, and it added an OIDC client, a loopback
listener, token refresh, a refresh-token sidecar, and a provisioning step. Convex
sync is optional, and the desktop is a single-owner application.

## Decision

Desktop sync is authorized by one operator-chosen secret, `LEAFLOGUE_SYNC_KEY`,
set on the deployment with `npx convex env set`. Every public sync function
(`syncRuntime:*`) compares the presented key against it in constant time and
refuses all calls when it is missing or shorter than 32 characters. The desktop
stores the URL and key in its protected configuration (ADR 0002), or reads them
from `LEAFLOGUE_CONVEX_URL`/`LEAFLOGUE_CONVEX_SYNC_KEY`, and uses them only in the
main process. The deployment's single library is created on first sync.

The key authorizes reading-data sync and one fixed `syncRuntime` migration
orchestrator. That orchestrator can run only Leaflogue's ordered, bounded,
idempotent compatibility steps; it cannot select an arbitrary function. A
legacy attachment can be detached only when the desktop repeats the exact note
ID returned for review, and its complete body remains as a standalone note.
Every sync exchange endpoint checks migration readiness through bounded indexed
lookups. An older client that cannot invoke the orchestrator cannot exchange
changes while migration work remains.
Deploying code, changing environment variables, and arbitrary function calls
remain Convex CLI operations authenticated by the operator's Convex account or
deploy key.

The OIDC-authenticated functions and device sessions stay in the deployment for
the future self-hosted web client, closed unless its issuer is configured. The
desktop OIDC client was removed; it remains in history at `2c14690`.

## Consequences

- Setup is three commands and one paste per desktop, with no identity provider.
- All desktops share one credential. Revoking a device means rotating the key
  and re-entering it on the devices that remain; there is no per-device
  revocation, and a shared-key device session would add none.
- A deployment has one owner and one library. Shared libraries with roles need
  the web client's real authentication, which this decision does not preclude.
- Anyone who obtains the key can read and rewrite the library, as with a
  PostgreSQL connection string. Documentation must say so plainly.
- A normal **Sync now** drains at most 100 migration calls. It reports progress
  and pauses for another explicit run rather than turning a large upgrade into
  an unbounded client operation.
