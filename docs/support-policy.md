# Support policy

Status: experimental beta. The targets below have automated checks; they are
not a claim of completed clean-machine or screen-reader acceptance.

## Desktop beta targets

| Platform | Architecture | Downloads | Update path |
| --- | --- | --- | --- |
| Linux | x64, ARM64 | AppImage, tarball | In-app signed updates for AppImage; tarballs are manual |
| macOS 13+ | Apple Silicon, Intel | DMG, ZIP | In-app signed updates for an app moved to Applications |
| Windows | x64 | Per-user NSIS installer, portable ZIP | In-app signed updates for installer builds; portable ZIPs are manual |

Linux CI uses Ubuntu 24.04; native container checks additionally exercise
Linux ARM64. No blanket acceptance claim is made for other distributions,
desktop sessions, or all supported OS versions. Actual clean-desktop and
Orca/VoiceOver/Narrator records remain pending in
[release readiness](release-readiness.md).

Mac packages are ad-hoc signed without Apple notarization; Windows packages are
unsigned. The maintainer approved experimental distribution with those limits.
An Ed25519-signed update manifest authenticates the update bytes; it does not
establish Apple/Windows publisher trust. There are no published package-manager
or app-store distributions.

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
- The first beta has no long-term compatibility guarantee. Consult the exact
  release notes before opening an older development library. JSON exports can
  be imported into another library; they merge data rather than restoring a
  previous database file.
- Older builds refuse to open a newer library, configuration, or remote schema
  rather than guessing. Keep a backup before downgrading.

## Security fixes

- Before `v1.0.0`, only the latest release receives fixes.
- From `v1.0.0`, the latest minor release receives all fixes, and the previous
  minor release receives security fixes for three months after its successor
  ships.
- Vulnerabilities are reported and disclosed as described in
  [`SECURITY.md`](../SECURITY.md).
