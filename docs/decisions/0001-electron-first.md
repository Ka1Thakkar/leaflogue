# ADR 0001: Electron is the first desktop shell

- Status: accepted
- Date: 2026-09-14

## Context

Leaflogue needs a Linux desktop application that works entirely offline, can
read Kobo SQLite and text/JSON imports, shares a UI and domain layer with a
self-hosted web edition, and can later ship to more desktop platforms. The
existing product is TypeScript and React. Introducing Rust during the first
open-source extraction would add a second toolchain while the data and sync
boundaries are still moving.

## Decision

Use Electron 44 for the first desktop implementation, with electron-vite for
main/preload/renderer builds and electron-builder for Linux artifacts. Package
x64 and arm64 AppImage and tar archives. Tauri remains a later
shell evaluation, not a parallel implementation.

Electron is an adapter at the edge. Domain, import, storage, AI, metadata, and
UI contracts must not import Electron. The only Electron-specific surfaces are:

- application/window lifecycle and native menus;
- file-picking and external-link confirmation;
- the main-process SQLite and filesystem adapters;
- a narrow context-isolated preload API;
- packaging, update notification, and OS secret integration.

## Process responsibilities

```text
renderer (sandboxed)      preload (bridge)       main (privileged)
React views               serializable API       SQLite + migrations
view state          <──>  one method/operation <──> file import/export
Markdown rendering        no raw ipcRenderer      secrets + network adapters
```

The main window loads packaged local code over an application protocol. It does
not navigate to the hosted Leaflogue site. External links require an HTTPS URL
allowlist check and explicit opening in the system browser. No `webview`, remote
code, shell command, raw filesystem method, SQL method, or arbitrary IPC channel
is exposed to the renderer.

## Data and secrets

The main process copies a selected import into an application-owned temporary
directory, validates its size/signature, opens SQLite inputs read-only, and
removes the copy after review expiry. The persistent library uses `node:sqlite`
behind a repository interface. We accept its release-candidate status for the
first prototype because it avoids a native addon/rebuild chain; migration,
backup, locking, FTS, and representative distribution tests are release gates.
The adapter can be replaced without changing application contracts.

Electron `safeStorage` is not treated as universally secure on Linux. The later
credential-storage decision in [ADR 0002](0002-protected-secret-config.md)
supersedes this paragraph with a protected, portable config-file policy and an
explicit local threat model.

## Packaging and updates

The initial builds are unsigned community artifacts with published SHA-256
checksums. Automatic self-update is deferred: even with a single AppImage
channel, silently fetching executable code conflicts with
the local-first trust model. The app may check an opt-in release manifest and
open the release page; installation remains explicit.

Release CI builds each architecture in a clean Linux environment, installs each
package in a disposable image, launches it, creates a library, imports fixtures,
backs up/restores, and confirms AI/sync make no network requests when disabled.

## Consequences

The application download and idle memory footprint will be larger than a native
webview shell. In return, Linux rendering is consistent, the implementation
stays in TypeScript, and future Windows/macOS packaging is feasible. A Tauri pass
can later compare startup time, package size, memory, accessibility, and
maintenance cost against this contract-stable Electron implementation.
