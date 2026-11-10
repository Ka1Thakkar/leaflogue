# ADR 0007: signed in-app updates from v0.1.0, and Flathub as the recommended Linux install

Status: accepted on 1 October 2026 by the maintainer. Amends
[ADR 0004](0004-cross-platform-secrets-and-signing.md), which kept builds
unsigned and relied on readers running a checksum.

## Context

ADR 0004 shipped unsigned builds and made a published SHA-256 checksum the only
integrity signal. In practice that asks every reader to run `sha256sum` before
the first launch and again for every update, and almost nobody does. A checksum
published on the same release page as the file also protects little: whoever
can replace the file can replace its checksum.

The roadmap planned update channels and signed differential updates only
"after the first stable portable release". An application can only update
itself if the version a reader installed already contains the updater, so
shipping `v0.1.0` without one would make every early reader find and download
the next release by hand.

## Decision

**The desktop updates itself, starting with `v0.1.0`.** The AppImage fetches
the channel's signed manifest from GitHub Releases, verifies its Ed25519
signature against a public key compiled into the app before trusting any
field, then downloads the AppImage that manifest names, checks its size and
SHA-512 while it streams, and only then replaces itself and restarts. The
updater is Leaflogue's own (about 300 lines in `apps/desktop/src/main/update-*.ts`)
rather than `electron-updater`: that library fetches update metadata itself,
so checking our signature first would mean overriding its internal provider
API, and our own code fits the main process's existing narrow HTTPS rules and
can be tested without a network. Block-level differential downloads are left
for later; until then every update is a full download. The private key
lives only in the protected GitHub release environment that publishes that
channel; a compromised repository or release page alone cannot ship an update.

- `v0.1.0` ships the **stable** channel and a manual **Check for updates**. An
  optional periodic check is off by default; nothing downloads or installs
  without the reader choosing it, and requests carry no reading data.
- **Beta** and **dev** follow as separate, separately keyed feeds, with the
  channel-switch warnings, rollback bundle, and schema checks already on the
  roadmap.
- Before replacing itself the app verifies channel, version monotonicity, and
  architecture, and it never downgrades across a library schema it cannot open.
- The `.tar.gz` cannot replace itself; it reports that an update exists.

**Flathub is the recommended Linux install**, listed once the `v0.1.0`
release candidate has passed its end-to-end checks (Flathub reviews a finished
app; until then the AppImage is the install path). Flathub builds the published
manifest, signs the result, and delivers updates through the system's software
centre, so a first install needs no manual verification; it also provides a
beta branch. The cost is the sandbox: data lives under `~/.var/app/`, and
reading a Kobo or Kindle needs a filesystem permission or the file-chooser
portal. A Flathub build disables the in-app updater, because Flathub owns
updates there.

**The direct AppImage remains**, for readers who want one file. Its checksum
becomes an optional step for those who want it, and CI adds free GitHub build
attestations so anyone can confirm the file was built by this repository's
workflow. After the first download, every update is verified by the app.

macOS keeps the Homebrew cask from ADR 0004, which verifies the download hash
itself. There is no DMG: an un-notarized downloaded app must be allowed through
System Settings → Privacy & Security → Open Anyway, and the cask avoids that. Windows is unchanged.

## Consequences

- The updater, its signature check, its signed metadata in the release
  workflow, and its failure tests (bad signature, wrong channel, older
  version, wrong architecture, interrupted download) become `v0.1.0` gates.
- The release environment holds one more secret, the stable update-signing
  key. Losing it means shipping a release with a new public key that existing
  installs cannot trust, so rotation requires one manual download; the key's
  backup and rotation are documented in the release process.
- The Flathub manifest, its permissions, and the sandboxed data paths need
  their own tests and documentation, and the app must detect when it runs
  under Flatpak.
- Install guides lead with Flathub, then the AppImage, and no longer require a
  checksum.
