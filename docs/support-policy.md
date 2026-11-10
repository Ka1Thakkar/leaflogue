# Support policy

Status: adopted for the first public release; the maintainer reviews it before
each minor release.

## Desktop platforms

| Area | Supported |
| --- | --- |
| Architectures | Linux x64 and arm64 |
| Distributions | Ubuntu 22.04 LTS and 24.04 LTS; Debian 12 and 13; the two most recent Fedora releases; current Arch Linux |
| Sessions | Wayland and X11 |
| Packages | AppImage and `.tar.gz` per architecture, with validation evidence, checksums, SBOM, audit, and notices; signed AppImage updates after a public release. Flathub is planned and is not yet an install option. |

Other distributions with glibc 2.35 or newer usually work but are not tested
before release.

macOS is planned for phase 5 of the roadmap and will be published as a Homebrew
cask, which is what makes an unsigned build open normally. It is not supported
until its clean-machine gate passes.

Windows is conditional. It ships only if the project obtains free code signing
for open source, and only after the credential-store work in
[ADR 0004](decisions/0004-cross-platform-secrets-and-signing.md), because the
protected-configuration guarantee this project makes about saved credentials has
no Windows equivalent today. If neither lands, macOS and Linux are the supported
platforms.

Builds carry no paid code-signing certificate. Flathub signs what it
distributes, and the AppImage verifies every update against Leaflogue's own
signing key ([ADR 0007](decisions/0007-signed-updates-and-flathub.md)); a
first direct download can optionally be checked against its published checksum
or build attestation. ADR 0004 records why an unsigned Windows installer is
the one case this project would rather not ship at all.

## Databases for sync and self-hosting

- **PostgreSQL:** major versions 16 and newer that the PostgreSQL project still
  supports. Connections to non-loopback servers must use TLS.
- **Convex:** the cloud service or a self-hosted backend running a Leaflogue
  function bundle within the desktop's documented compatibility window. The
  current window is schema 17 and mutation contracts 22–23. Contract 23 adds
  thread replay; update desktops before the deployment, because older desktops
  accept contracts only up to 22.

Sync and the self-hosted web client are implemented and optional. They require
the configuration described in the guides; release validation records must
state which provider and runtime checks were actually run.

## Upgrades

- Local SQLite libraries upgrade forward automatically when a newer release
  opens them. Each migration runs in one transaction, and a failed migration
  leaves the library at its previous schema.
- Before migrating, Leaflogue saves the library as the previous release left it,
  beside the library as `library.before-upgrade.schema-<N>.sqlite`, keeping the
  two most recent. It is an ordinary backup that the previous release can
  restore; if it cannot be written, the library stays closed and unmigrated.
- A release can upgrade libraries created by any release from the previous
  twelve months. For anything older, upgrade through an intermediate release.
  JSON exports can be imported into another library; they merge data rather
  than restoring a previous database file.
- Older builds refuse to open a newer library, configuration, or remote schema
  rather than guessing. Keep a backup before downgrading.

## Security fixes

- Before `v1.0.0`, only the latest release receives fixes.
- From `v1.0.0`, the latest minor release receives all fixes, and the previous
  minor release receives security fixes for three months after its successor
  ships.
- Vulnerabilities are reported and disclosed as described in
  [`SECURITY.md`](../SECURITY.md).
