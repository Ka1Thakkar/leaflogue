# ADR 0002: protected configuration for desktop credentials

Status: accepted. This supersedes the AI-key storage paragraph in ADR 0001.

## Context

Linux `safeStorage` may use `basic_text`, varies across desktop environments, and
does not support the portable, user-selected configuration workflow required for
Leaflogue packages and declarative installations. The product owner explicitly
requires database and AI credentials to share the same local config-file or
environment-variable workflow.

## Decision

The desktop may store database URLs and AI API keys in the explicitly selected
Leaflogue JSON configuration file. Writes are atomic, capped at 64 KiB, and use
mode `0600`; parent directories created by Leaflogue use mode `0700`. Environment
references remain preferred for managed systems. Key input is transient in the
renderer, saved values are never returned over IPC, and diagnostics, logs,
exports, backups, screenshots, and crash reports must contain only redacted
credential state. Session-only key support may be added later.

This protects against other non-privileged local users and accidental disclosure,
not against the same OS account, root, malware running as that account, memory
inspection, or a compromised Electron main process. The setup guide must state
that boundary plainly. Leaflogue refuses group/world-readable config files and
does not claim at-rest encryption.

## Consequences

Configuration remains inspectable, portable, and compatible with dotfile and
package-managed Linux workflows. Users who require stronger separation should
reference environment variables supplied by their service/session manager. An
OS keyring backend may be added as an optional storage mode without changing the
redacted renderer contract.
