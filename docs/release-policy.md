# Desktop release policy

Leaflogue's Linux downloads are community builds without an operating-system
code-signing certificate. AppImage updates use Leaflogue's Ed25519 signature,
not an Electron or OS certificate. [ADR 0007](decisions/0007-signed-updates-and-flathub.md)
supersedes the earlier manual-download-only policy.

## What a candidate contains

For each architecture being offered, provide an AppImage and tarball, a
SHA-256 manifest, a CycloneDX SBOM, a production dependency-audit report,
build-input metadata, third-party notices, and the matching Convex backend
bundle. Check the files themselves before distributing them; a successful
source build alone is not artifact verification.

The production dependency audit must contain no high or critical findings.
Also review the Electron runtime's advisories: its package is a development
dependency, but its binary is shipped to readers.

## Updates require a reader's choice

The optional daily setting checks for metadata only. Downloading and installing
an update requires **Install and restart**. The AppImage verifies the signed
manifest against a public key compiled into the app, then checks the payload's
size, SHA-512, version, architecture, and channel before replacing itself.
Tarball installations report that an update exists but do not replace themselves.

The signing key belongs in the protected GitHub `release` environment. It must
not appear in source, logs, screenshots, or release assets. Final releases
include the stable update manifests and their signatures. A validation draft
without them is not an update feed and must say so.

`npm run verify:release-policy --workspace @leaflogue/desktop` rejects the
`electron-updater` dependency, Electron Builder publishing, external Builder
configuration, and Electron `autoUpdater` calls. It permits Leaflogue's own
reviewed updater; it does not permit installation without a reader's choice.

## Before the first public release

Run the source quality gate and production audit, validate both artifact sets,
scan the final source and extracted assets, and record the results. Complete
the clean Linux desktop and screen-reader checks in
[clean-linux-validation.md](clean-linux-validation.md). Do not mark a check as
passed from unit tests or container coverage when it requires a human desktop.

A draft candidate may hold artifacts for these checks. Keep it a draft and do
not create the final `v0.1.0` tag until the remaining release gates are met.
Flathub submission follows a validated candidate; until there is a listing,
the install guide leads with direct downloads.
