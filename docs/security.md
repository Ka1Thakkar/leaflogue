# Security model

## Protected assets

- Reading content, notes, status history, and unpublished threads.
- Imported source files, local database backups, and JSON library exports.
- AI provider keys, sync tokens, OAuth secrets, and database credentials.
- Public-sharing decisions and revocation state.

## Trust boundaries

Import files, book metadata, Markdown, cover URLs, companion prompts, sync peers,
and renderer messages are untrusted. The Electron main process and self-hosted
server are privileged, but neither is trusted to receive more data or credentials
than its active feature requires.

## Required controls

- Parse imports with byte/record limits and no executable markup.
- Render Markdown without raw HTML and apply a restrictive content security policy.
  The renderer never navigates to a link: it asks the main process, which opens
  only credential-free `https` URLs in the system browser after a native
  confirmation that shows the full address.
- Keep the Electron renderer sandboxed and expose only validated product IPC.
- Use parameterized SQL and transactional, versioned migrations.
- Accept pasted covers from any standard HTTPS host, but resolve every request
  and redirect in the main process, reject loopback/private/link-local/reserved
  or mixed public/private DNS answers, and pin the socket to the validated
  address. The pinned resolver implements both single-address and all-addresses
  Node lookup callback forms so runtime connection policy cannot bypass or
  break the validated result. Refuse oversized responses and MIME/signature
  mismatches; never give the renderer general network access.
- Read saved desktop database credentials only in the Electron main process,
  from its environment, a permission-protected config file, or an OS-backed
  secret facility. The setup renderer may submit a new value through one narrow,
  validated IPC command; it must clear the field and can never retrieve the
  stored value.
- Desktop Convex sync is authorized by the deployment's `LEAFLOGUE_SYNC_KEY`
  (ADR 0006), compared in constant time; a deployment without it refuses all
  sync. The key is stored like a database credential (protected config or an
  environment variable), used only in the main process, and reported to the
  renderer only as saved or not. It cannot deploy code, change environment
  variables, or choose arbitrary functions; it can invoke only Leaflogue's
  fixed, bounded compatibility migrations before sync. A deployment URL is
  never treated as a credential. Rotating the key is the only way to cut off a
  device. All four exchange endpoints refuse pending migration work even for
  clients that do not call the migration orchestrator; desktop preparation is
  cancellable on quit and validates exact bounded progress responses.
- Tagged releases contain a deterministic Convex source bundle with an adjacent
  SHA-256 manifest. It includes public backend and shared-domain source plus
  integrity-locked dependency metadata: no `.env` files, generated deployment
  state, sync keys, deploy keys, credentials, tests, or `node_modules`.
  Deployment credentials stay in the Convex CLI/account environment and are
  never copied into the archive.
- Keep server secrets in deployment configuration, never browser bundles.
- Redact passages, notes, imported payloads, credentials, and tokens from logs.
- Write local exports atomically with restrictive permissions, and include only
  reading records: never credentials, configuration, source paths, sync device
  state, or other operational metadata.
- Treat the protected config directory as the trust root for referenced files.
  Canonicalize it once, accept links at or above it, and reject any link
  between it and a referenced custom theme; require absolute references to be
  canonical, open the final component without following links, and require
  owner-only `0600` regular files. Watch the same canonical paths that are
  validated.
- Make telemetry opt-in and document every transmitted field before adding it.
- Require TLS for non-loopback sync and scope tokens to a user and device.
- Make AI and sync independently opt-in and test that their disabled modes perform
  no corresponding network requests.

Direct PostgreSQL access is an explicit self-operated desktop profile. Its role
must be restricted to the intended Leaflogue database/schema and its URL remains
inside the Electron main process. Privileged Convex deployment credentials are
setup-only; desktop runtime sync uses the deployment URL and a shared sync key
kept in protected config or an environment variable. The web client uses the server/OIDC or standalone Convex identity integrations
described below. General multi-user deployments should use the Leaflogue server API
rather than distributing one database role to unrelated users.

The unauthenticated Convex `setup:status` query is metadata-only: it returns
fixed product and contract versions and never reads reading records. The
standalone backend now supports its own Google sign-in, closed unless
`AUTH_ALLOWED_EMAILS` is configured. The provider must supply a positive
verified-email claim before the auth profile is normalized. A deployment used
only for desktop sync can leave web sign-in closed.

Public reading-data queries and mutations require a Convex-verified identity
and an exact identity/library membership. Viewer memberships cannot write;
authorization completes before internal mutations run. Membership provisioning
and revocation remain operator-only operations. Read limits bound items, rows,
and bytes, and responses omit storage identifiers and internal accounting.
Change cursors carry a library generation; restores must rotate it so old
cursors request a reset instead of skipping replacement data.

The self-hosted server uses a separate reviewed OIDC authorization-code flow
with PKCE, state, nonce, verified-email allowlisting, and hashed session tokens
in HttpOnly cookies. Mutations require the configured origin. Its unauthenticated
profile is permitted only on loopback; do not expose it through a proxy.

AI request limits and authenticated library access enforce authorization. The
model's passage-scope classifier is defence in depth, not an access-control
mechanism or a guarantee against prompt injection. Both the current prompt and
caller-supplied conversation history are considered for scope classification;
models can still make mistakes. Provider keys never enter the renderer.
