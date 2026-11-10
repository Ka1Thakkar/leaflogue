# Release process

## Cross-platform beta

1. Review the exact source, licence notices, dependency audit and release notes.
2. Keep the desktop manifest and lockfile at the same version; verify with
   `node scripts/verify-release-version.mjs v0.1.0-beta.2`.
3. Pass the Quality workflow, including native package and MCP client checks.
4. Dispatch **Cross-platform beta candidate** on the reviewed source. It creates
   an unpublished draft prerelease and uploads Linux x64/ARM64, Mac ARM64/Intel,
   Windows x64, backend and evidence files directly to that draft. It does not
   use GitHub Actions artifact storage and does not publish automatically.
5. Check every checksum manifest, SBOM, dependency audit and build-input record.
   A failed or incomplete candidate remains a draft and must not be promoted.
6. Complete [native beta acceptance](beta-desktop-validation.md), including
   normal installation and screen-reader testing, and retain the actual results.
   For the experimental beta the maintainer approved experimental publication with these
   human checks explicitly pending. Do not mark them passed.
7. Create the matching beta tag from the reviewed source, dispatch the candidate
   workflow on that tag so the backend version matches, and verify tagged CI and
   all assets. Publish as a prerelease with the pending checks and signing limits
   in its notes. A stable release still requires all manual acceptance gates.

The beta uses ad-hoc Mac signing without notarization and unsigned Windows
packages. Release notes must disclose that status and observed OS prompts.
Beta updates are explicit manual replacement; do not claim a signed stable feed.

## Stable releases

Stable Linux update manifests use the separately protected release environment
and Ed25519 key described in [ADR 0007](decisions/0007-signed-updates-and-flathub.md).
Verify environment protection, the offline key backup and final signing evidence
before enabling that path. Never put signing credentials in source or release
assets. Store source provenance and third-party notices with each release.

## Beta update feed

The tagged cross-platform workflow signs five beta manifests with the separate
`LEAFLOGUE_BETA_UPDATE_SIGNING_KEY` in the `release` environment. That environment
accepts only `v*` tags. The private key is never included in source, logs, or
release files. Keep an offline backup; the public beta key is compiled into
`apps/desktop/src/main/update-keys.ts`. Rotate with an overlap release so
installed copies continue to trust updates.

Before publishing, verify each manifest/signature pair with the compiled public
key and verify its exact filename, platform, architecture, size, version, and
SHA-512 against the uploaded artifact. Keep beta and stable channels separate.
The existing stable Linux signing key does not authorize beta manifests.

The native smoke tests upgrade isolated fixture installations using the real
Mac ZIP/Windows installer and preserve a separate profile sentinel. They do not
replace human clean-desktop or screen-reader acceptance.
