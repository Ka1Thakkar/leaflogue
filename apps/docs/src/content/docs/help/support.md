---
title: Beta platforms and support
description: Where Leaflogue runs, how updates work, and how to report a security problem.
---

## Where Leaflogue runs

- **Linux** on regular PCs (x64) and Arm computers (arm64). Release notes and attached validation records say which systems were checked
  for that build. Ubuntu 24.04 is the Linux CI environment; a successful CI
  run does not establish support on every desktop distribution.
- **macOS beta target:** Apple Silicon and Intel, macOS 13 or newer, with DMG
  and ZIP packages. Both architectures require native acceptance records.
- **Windows beta target:** x64, with a per-user installer and ZIP package.
  Initial human acceptance targets Windows 11; other Windows versions need
  their own recorded checks. Native Windows ARM64 is not yet included.

The experimental beta has automated source and native packaging checks.
Clean-desktop installation and actual screen-reader acceptance remain pending
on these targets. Mac downloads are ad-hoc signed without notarization; Windows
downloads are unsigned. No verified publisher trust is claimed. Consult the
[release notes](/start/release-notes/) before testing.

For sync, Leaflogue works with [Convex](/sync/convex/) and
[PostgreSQL](/sync/postgresql/) 16 or newer.

## Updates

For this beta, download the next release from
[GitHub Releases](https://github.com/Ka1Thakkar/leaflogue/releases) and replace
the application manually. Back up your library first. Prereleases are not
offered by the app's signed-stable update checker. Read the release notes for
any schema or sync compatibility changes before updating.

## Security problems

Please report security problems privately, following the
[security policy](https://github.com/Ka1Thakkar/leaflogue/security/policy),
rather than in a public issue.

## Licence

Leaflogue is free, open-source software under the
[GNU Affero General Public License](https://github.com/Ka1Thakkar/leaflogue/blob/main/LICENSE).
