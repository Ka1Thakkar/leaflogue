# Security policy

Leaflogue holds people's private reading data and, when configured, database
credentials and AI provider keys. Please report vulnerabilities privately so
they can be fixed before they are disclosed.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting:
**Security → Report a vulnerability** on
[github.com/Ka1Thakkar/leaflogue](https://github.com/Ka1Thakkar/leaflogue/security/advisories/new).
Do not open a public issue, pull request, or discussion for a suspected
vulnerability.

Include the affected version or commit, your platform, clear reproduction steps,
and the impact you observed. Use synthetic data only; never send real reading
libraries, credentials, or keys.

## What to expect

- Acknowledgement within three working days.
- An initial assessment, including severity and whether a fix is planned,
  within ten working days.
- Coordinated disclosure: we agree a disclosure date with you, normally within
  90 days of the report or sooner once a fixed release is available. Reporters
  are credited in the advisory unless they prefer otherwise.

## Scope

In scope: the desktop application and its IPC boundary, importers, local
storage, backups and exports, protected configuration, the PostgreSQL and
Convex adapters, and (once released) the self-hosted server and web client.
Security-relevant design is recorded in [`docs/security.md`](docs/security.md).

Out of scope: vulnerabilities in third-party services you connect (for example
your own database or AI provider), attacks that require control of the same
operating-system account, and reports generated only by automated scanners
without a demonstrated impact.

## Supported versions

Security fixes follow [`docs/support-policy.md`](docs/support-policy.md). Before
the first public release, only the default branch receives fixes.
