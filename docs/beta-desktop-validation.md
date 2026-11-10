# Cross-platform beta validation

The first beta targets Linux x64/ARM64, Mac Apple Silicon/Intel (macOS 13+),
and Windows x64. Windows human acceptance initially targets Windows 11.
A passing build is not a completed support claim.

## Artifacts and native checks

| Target | Build command (desktop workspace) | Downloads | Native CI runner |
| --- | --- | --- | --- |
| Linux x64 | `package:linux:x64` | AppImage, tar.gz | Ubuntu 24.04 |
| Linux ARM64 | `package:linux:arm64` | AppImage, tar.gz | Ubuntu artifact checks; clean ARM64 desktop acceptance required |
| Mac Apple Silicon | `package:mac:arm64` | DMG, ZIP | macos-15 (ARM64) |
| Mac Intel | `package:mac:x64` | DMG, ZIP | macos-15-intel |
| Windows x64 | `package:windows:x64` | Per-user NSIS installer, ZIP | windows-2025 |

Native packaging scripts reject the wrong host OS. They verify Mach-O/PE
architecture, the hardened app bundle and bundled dictionary, generate
checksums, production dependency audit, CycloneDX SBOM and source-input hashes.
Native CI also drives the desktop workflow, dictionary and packaged security
boundary against temporary profiles. No real personal library is used.

## Candidate workflow

After reviewing and committing the final source, dispatch **Cross-platform
beta candidate** (`.github/workflows/beta-desktop.yml`) on that exact commit.
It runs the quality gate and production audit, creates one draft prerelease,
and builds/validates each platform on its native runner. Linux packages and
the Convex bundle use the existing validators. Assets go directly into the
draft GitHub Release; no Actions artifact storage is used.

The initial draft is explicitly incomplete. Its notes are updated only when
all native jobs and the Linux/backend job pass. Failed or partial candidates
must not be published. Ordinary Quality CI also runs the three native Mac/Windows
matrix jobs. The legacy Linux stable-tag publisher does not handle beta tags.

Before publication, set the matching beta version across versioned packages
and lockfile, rebuild the candidate, and review its assets and notes. Promote
only the exact verified source to the corresponding prerelease tag; do not
reuse artifacts from an earlier source or silently substitute local files.

## Beta signing decision — 10 November 2026

- Mac beta packaging currently uses an **ad-hoc signature**, without Apple
  notarization. The native build verifies bundle integrity, not Developer ID
  trust or Gatekeeper acceptance of a quarantined internet download.
- Windows candidate packages are **unsigned**. Artifact hashes and security
  fuses do not establish a verified publisher or SmartScreen reputation.
- The maintainer approved ad-hoc Mac and unsigned Windows builds for the
  public beta on 10 November 2026. Record the observed OS prompts during
  clean-machine acceptance; verified publisher signing is not a beta gate.
  Apple/Windows signing credentials are not embedded in the repository or
  collected by this workflow.
- Linux stable-update Ed25519 signing remains a separate protected gate.
  Mac, Windows and beta archives use explicit manual replacement, not silent
  installation or a stable update feed.

## Human acceptance per native target

Download the candidate from the release, rather than copying the unpacked CI
folder. Record source SHA, artifact hash, OS version, architecture and actual
signature/notarization status. On a clean non-development account/machine:

1. Install the DMG, installer or AppImage normally. Exercise ZIP/tar.gz as an
   alternative distribution. Record Gatekeeper/SmartScreen prompts as observed.
2. Complete local setup, import a real supported reader fixture, add/edit a
   book, passage and note, and exercise collections, tags, threads and search.
3. Select a word, define it offline, reopen the dictionary through the command
   palette, and confirm no provider or network configuration is needed.
4. Export, back up, change the library, restore the backup, restart, and verify
   the restored data. Check file dialogs and paths containing spaces/non-ASCII.
5. Update manually to a second candidate, verifying library/settings are retained.
6. Uninstall the application; confirm personal data is preserved unless the
   tester explicitly removes it. Reinstall and verify the retained library.
7. Test keyboard-only and screen-reader use: Orca on Linux, VoiceOver on Mac,
   Narrator on Windows. Include dialogs, sidebar, dictionary, import preview,
   errors, focus return and both colour modes.

Linux-specific details remain in [clean-linux-validation.md](clean-linux-validation.md).
Container/Xvfb automation and a Windows Server CI desktop do not replace these
human checks on the advertised desktop systems.

## Evidence recorded locally

The 10 November ARM64 Mac candidate produced DMG and ZIP packages, passed
architecture, bundle-signature and archive-integrity checks, and retained
audit/SBOM/checksums. The hardened unpacked app passed the isolated packaged
test, including local library creation, offline dictionary and security fuses.
Repeat that test after each source change. Intel Mac
and Windows jobs have been configured but have not yet run for this source.
No public beta, signing/notarization, or native Windows acceptance is claimed.
