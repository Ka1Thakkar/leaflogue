# ADR 0004: OS credential store for secrets, unsigned builds distributed through package managers

Status: accepted on 25 September 2026 by the maintainer. Its "readers verify a
checksum" model for Linux is amended by
[ADR 0007](0007-signed-updates-and-flathub.md): signed in-app updates from
`v0.1.0`, Flathub as the recommended Linux install, and an optional checksum.

## Context

ADR 0002 protects database and AI credentials in a configuration file held at
permission `0600`, verified on every read. That guarantee is POSIX-shaped.
Windows has no mode bits, and `packages/remote/src/config.ts` already skips the
mode check, the symlink and realpath check, and `O_NOFOLLOW` when
`process.platform === "win32"` — with nothing in their place and no test
coverage of those branches. The Settings screen meanwhile states "permission
0600" on every platform. Shipping a Windows build against that code would
promise a protection that does not exist.

Signing is the second gate. Unsigned applications are blocked by Gatekeeper on
macOS and warned about by SmartScreen on Windows, and both read to most people
as a malware warning. Apple notarization requires the Apple Developer Program,
and a Windows certificate that clears SmartScreen immediately is an EV
certificate. The project has no budget for either.

## Decision

**Secrets move to the operating system's credential store.** Credentials live in
DPAPI on Windows, Keychain on macOS, and the Secret Service API on Linux, behind
a storage port with the same shape as the existing protected-config reader. The
configuration file keeps only non-secret settings and stays at `0600` where the
platform supports it. Whatever a platform actually guarantees is what the
interface says: the "permission 0600" wording becomes platform-specific rather
than a constant.

**macOS and Linux ship unsigned, and distribution carries the trust instead.**
Every artifact keeps its SHA-256 manifest and release evidence. macOS ships as a
Homebrew cask and Linux as AppImage and `.tar.gz`, so the ordinary install path
is a command rather than an executable downloaded from a browser. A cask still
leaves a real desktop application behind: it installs the bundle into
`/Applications`, where Spotlight and Launchpad find it, and `brew` clears the
quarantine attribute, so the application opens without the Gatekeeper detour
that a direct download requires. Install documentation states plainly that the
build is unsigned and how to verify a checksum.

**Windows ships only if it can be signed for nothing.** SignPath's open-source
plan is the candidate, and its current terms are checked before anything depends
on them. If no free programme accepts the project, Windows is not released at
all rather than released unsigned: a SmartScreen warning on an installer that
will hold someone's database and AI credentials asks for more trust than this
project is willing to ask for without a budget behind it. macOS and Linux are
the supported platforms in that case, and nothing in the release process assumes
a certificate exists. Paid signing is revisited before `v1.0.0`.

## Consequences

- Windows cannot ship until the credential store lands, and only then if free
  signing comes through. The gap is recorded as a blocking prerequisite in phase
  5 of the roadmap, not as polish.
- The credential store blocks Windows, not macOS. POSIX modes already deliver
  the promised protection on macOS and Linux, so the macOS release can proceed
  on the existing `0600` model and adopt Keychain afterwards. Sequencing the
  migration behind the macOS release avoids holding a working platform hostage
  to a platform that may never ship.
- Existing Linux installations need a migration that moves saved credentials out
  of the configuration file and into the Secret Service, leaving the file
  readable by older releases without the secrets.
- A headless or minimal Linux session may have no Secret Service. That case
  needs a documented fallback — an environment variable reference, which the
  configuration already supports — rather than a silent downgrade to a
  plaintext file.
- A reader who installs the macOS build through Homebrew sees nothing unusual;
  one who downloads it directly has to clear the quarantine attribute once. The
  documentation owns that difference, and it is the cost of shipping without a
  budget.
- Release evidence gains weight, since checksums are the only integrity signal
  an unsigned build carries.
