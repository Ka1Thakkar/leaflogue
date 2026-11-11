---
title: Install Leaflogue
description: Choose the Linux, macOS, or Windows beta build and understand installation and updates.
---

The experimental **0.1.0-beta.3** targets Linux, macOS, and Windows. Automated
checks pass; clean-desktop installation and actual Orca, VoiceOver, and Narrator
acceptance remain pending. Back up your library before testing. Downloads and
their validation records are on the
[GitHub Releases page](https://github.com/Ka1Thakkar/leaflogue/releases).
Check the [0.1.0 release notes](/start/release-notes/) for the beta's status
and known limitations before installing.

You do not need a Leaflogue account, a sync database, or an AI key to use the
desktop app.

## Choose your download

| Your computer | Beta formats | Filename identifier |
| --- | --- | --- |
| Linux x64 (`x86_64`) | AppImage and `.tar.gz` | `x86_64.AppImage` / `x64.tar.gz` |
| Linux ARM64 (`aarch64`) | AppImage and `.tar.gz` | `arm64.AppImage` / `arm64.tar.gz` |
| Apple Silicon Mac (macOS 13+) | `.dmg` and `.zip` | `mac-arm64` |
| Intel Mac (macOS 13+) | `.dmg` and `.zip` | `mac-x64` |
| Windows x64 | Per-user `.exe` installer and `.zip` | `windows-x64` |

Use **About This Mac** to identify an Apple chip or Intel processor, **Settings
→ System → About** on Windows, or `uname -m` on Linux. Download the version
listed on the beta release. Native Windows ARM64 is not in the first beta matrix.

## Install on Mac

Open the matching DMG and drag **Leaflogue** into **Applications**. Eject the
DMG, then open Leaflogue from Applications. Alternatively, extract the ZIP
and move `Leaflogue.app` into Applications. First-run setup shows where your
library and settings will live.

The experimental beta build uses an **ad-hoc signature, without Apple
notarization**. It is not a Developer ID-signed download. Check the release's
signing status before installing. Gatekeeper may block this download; actual
clean-machine prompts have not yet been recorded. No notarization is claimed.

## Install on Windows

Run the x64 installer and choose the per-user installation. The beta also
provides a ZIP: extract all its files into one folder and run `Leaflogue.exe`.
Keep the extracted files together. The ZIP does not move your library into
that folder; first-run setup shows the normal per-user data location.

The experimental beta build is **unsigned**. Do not treat it as a verified
publisher installer. Windows native CI passed; clean-machine acceptance and
actual SmartScreen prompts remain unrecorded. This signing status is approved
for the experimental beta.

## Linux installation

### Open the AppImage

1. Save the matching AppImage in a folder you want to keep, such as
   `~/Applications`.
2. In your file manager, open its properties and allow it to run as a program,
   or run `chmod +x Leaflogue-0.1.0-beta.3-*.AppImage` in that folder.
3. Double-click the AppImage. First-run setup shows where your library and
   settings will live. Choose **Local only** to get started.

:::tip[If it does not open]
An AppImage may need your distribution's FUSE compatibility package. The
[troubleshooting guide](/help/troubleshooting/#starting-leaflogue) explains
this and the tarball alternative.
:::

### Use the tarball instead

Extract the matching `.tar.gz` into its own folder, then run the `leaflogue`
executable inside it. Keep the extracted files together. Tarball installs
can report a new release but cannot replace themselves; download and extract
the newer version when you want to update.

Your library is stored separately from either download, in your
[data folder](/start/files-and-settings/). Replacing an application file does
not replace your library.

## Check a download

Each beta release provides a platform-specific checksum file: Linux uses
`SHA256SUMS-x64.txt` or `SHA256SUMS-arm64.txt`; Mac uses
`SHA256SUMS-mac-arm64.txt` / `SHA256SUMS-mac-x64.txt`; Windows uses
`SHA256SUMS-windows-x64.txt`. Each build also includes
build provenance, a software bill of materials, and a dependency audit.
To check a direct download, save its matching checksum manifest in the same
folder and run:

```sh
sha256sum --check --ignore-missing SHA256SUMS-x64.txt
```

On Mac, use `shasum -a 256 <downloaded-file>` and compare the result with its
manifest line. On Windows, use PowerShell `Get-FileHash <downloaded-file>
-Algorithm SHA256` and compare the hash. On Linux, use the arm64 manifest for
an Arm build. Every downloaded file that the command
checks should say `OK`. Do not run a file whose checksum differs.

## Updates

Back up your library, then open **Settings → Updates → Check for updates**.
On Mac apps installed in Applications, Windows per-user installer builds, and
Linux AppImages, choose **Install and restart** when a newer beta is available.
Leaflogue verifies the update manifest signature, platform, architecture, size,
and file hash before installing. You do not need to download another installer.
Your library stays in its separate data folder; a newer app may migrate its format.

The optional daily check is off by default. Enabling it checks and notifies;
installation still requires your choice. Beta builds check the signed beta feed.
A network or verification failure leaves the installed version in place.

On Mac, move the app from its disk image into Applications before updating.
Portable Windows ZIP and Linux tarball copies use manual replacement from
[GitHub Releases](https://github.com/Ka1Thakkar/leaflogue/releases).

## In a browser

The optional [self-hosted web app](/web/overview/) runs alongside your Convex
or PostgreSQL library. It is a separate deployment, not an installer for the
desktop app.

Next: [create your first library](/start/first-library/).
