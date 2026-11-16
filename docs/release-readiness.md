# Release readiness

## Published 0.1.1-beta.4

- [x] Publish the experimental reader beta with matching guides and downloads.
- [x] Pass exact tagged source, browser/desktop, native packaging and MCP checks.
- [x] Retain 44 assets with checksums, SBOMs, audits and build-input records.
- [x] Independently verify package versions, checksums, signed beta manifests
  and extracted application secret scans.
- [x] Verify the deployed documentation points to the published beta.4 release.
- [ ] Record clean-machine install, import, backup/restore, restart, update and
  uninstall acceptance across Linux x64/ARM64, Mac ARM64/Intel and Windows x64.
- [ ] Record keyboard-only and actual Orca, VoiceOver and Narrator acceptance.
- [ ] Record observed Gatekeeper and SmartScreen installation prompts.

Evidence: [tagged checks](https://github.com/Ka1Thakkar/leaflogue/actions/runs/43165887343),
[release builds](https://github.com/Ka1Thakkar/leaflogue/actions/runs/43165888713),
[independent artifact verification](https://github.com/Ka1Thakkar/leaflogue/actions/runs/43165949049),
and [published release](https://github.com/Ka1Thakkar/leaflogue/releases/tag/v0.1.1-beta.4).
Manual acceptance remains required for stable publication. Mac packages are
ad-hoc signed without notarization, and Windows packages are unsigned.
Community testers can use the [beta feedback form](https://github.com/Ka1Thakkar/leaflogue/issues/new?template=beta_feedback.yml)
to report their OS, architecture, version and results; untested items stay open.

## Historical 0.1.0-beta.3 preparation


Status: experimental public beta authorized, 10 November 2026.
This is a prerelease, with the manual checks below explicitly deferred.

## Scope

Linux x64/ARM64, Mac Apple Silicon/Intel (macOS 13+), and Windows x64.
Includes the offline dictionary, opt-in read-only MCP, optional sync and AI,
the self-hosted web client, and a matching Convex backend bundle.

## Validation recorded during preparation

- Source quality gate: formatting, lint, types, unit tests and all builds passed.
- Desktop source workflows, including real stdio MCP client/revocation, passed
  locally on Apple Silicon with isolated sample libraries.
- Apple Silicon DMG/ZIP packages passed architecture, signature-integrity,
  archive-integrity and packaged-app/MCP tests. These checks do not establish
  notarization, clean-machine installation or screen-reader acceptance.
- Documentation browser checks passed at desktop, mobile and narrow widths.
- Production dependency audit has no high or critical vulnerabilities.
- Linux browser baselines were reviewed in an Ubuntu Playwright container.

Retain the final candidate's own logs, hashes and audit reports. These records
must not be treated as evidence for later source changes or an untested target.

## Automated publication gates and outstanding manual acceptance

- [ ] Pass full CI and native packaging/MCP checks for the exact public source.
- [ ] Retain every target's checksums, SBOM, audit and build-input records.
- [ ] Rescan the final public source and extracted release artifacts.
- [ ] Record clean Linux x64/ARM64, Mac ARM64/Intel and Windows x64 installation,
      import, backup/restore, restart, manual update and uninstall acceptance.
- [ ] Record keyboard and screen-reader acceptance: Orca, VoiceOver and Narrator.
- [x] Beta signing decision: ad-hoc Mac and unsigned Windows builds are permitted.
      Record observed Gatekeeper/SmartScreen prompts; claim no publisher trust.
- [x] Maintainer approved experimental publication with the manual acceptance
      checks above still pending, disclosed in the release notes (10 November 2026).
      This exception applies to 0.1.0-beta.3, not a stable release.
- [ ] Review final tagged CI, notes, checksums and publish the matching prerelease.

The unchecked human checks are unperformed, not passed or replaced by CI.
Stable publication requires those checks; this experimental beta is intended
for testing with backed-up data.

See [beta validation](beta-desktop-validation.md) for the native checklist and
[release process](release-process.md) for candidate preparation. Stable Linux
update signing is a separate protected release path, not an unsigned beta feed.

## Update-enabled candidate

The first candidate remains unpublished. Beta.2 adds a separately keyed beta
feed and in-app installation for Mac app bundles, Windows per-user NSIS
installations, and Linux AppImages. Portable Windows ZIP/Linux tarballs remain
manual installations. Native fixture upgrade checks must pass on each target
before publishing this candidate. No human acceptance box is marked passed
by those automated checks.
