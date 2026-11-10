---
title: Supported systems
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

The beta is in preparation. Ad-hoc Mac and unsigned Windows candidates are
validation builds, not notarized or verified-publisher downloads. Release
notes must state the validation and signing status of the files offered.

For sync, Leaflogue works with [Convex](/sync/convex/) and
[PostgreSQL](/sync/postgresql/) 16 or newer.

## Updates

Leaflogue checks that every update comes from Leaflogue before installing it.
There is no Flathub listing yet. Signed stable AppImages can update from
**Settings → Updates**; Mac, Windows, and beta archive builds use manual downloads. Release notes say clearly when an update
changes anything you need to know about, such as a sync database update.

## Security problems

Please report security problems privately, following the
[security policy](https://github.com/Ka1Thakkar/leaflogue/security/policy),
rather than in a public issue.

## Licence

Leaflogue is free, open-source software under the
[GNU Affero General Public License](https://github.com/Ka1Thakkar/leaflogue/blob/main/LICENSE).
