# Release process

## Cross-platform beta

1. Review the exact source, licence notices, dependency audit and release notes.
2. Keep the desktop manifest and lockfile at the same version; verify with
   `node scripts/verify-release-version.mjs v0.1.0-beta.1`.
3. Pass the Quality workflow, including native package and MCP client checks.
4. Dispatch **Cross-platform beta candidate** on the reviewed source. It creates
   an unpublished draft prerelease and uploads Linux x64/ARM64, Mac ARM64/Intel,
   Windows x64, backend and evidence files directly to that draft. It does not
   use GitHub Actions artifact storage and does not publish automatically.
5. Check every checksum manifest, SBOM, dependency audit and build-input record.
   A failed or incomplete candidate remains a draft and must not be promoted.
6. Complete [native beta acceptance](beta-desktop-validation.md), including
   normal installation and screen-reader testing, and retain the actual results.
7. Once all [release gates](release-readiness.md) are resolved, create the matching
   beta tag from the exact verified source and publish its prerelease notes/assets.

The beta uses ad-hoc Mac signing without notarization and unsigned Windows
packages. Release notes must disclose that status and observed OS prompts.
Beta updates are explicit manual replacement; do not claim a signed stable feed.

## Stable releases

Stable Linux update manifests use the separately protected release environment
and Ed25519 key described in [ADR 0007](decisions/0007-signed-updates-and-flathub.md).
Verify environment protection, the offline key backup and final signing evidence
before enabling that path. Never put signing credentials in source or release
assets. Store source provenance and third-party notices with each release.
