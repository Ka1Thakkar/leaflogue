# ADR 0003: AGPL-3.0-or-later licence

Status: accepted on 24 September 2026 by the maintainer.

## Context

Leaflogue ships a local desktop application and will ship a self-hostable server
and web client. A permissive licence would let a modified hosted service be
offered without sharing its changes, which conflicts with the project's
reader-owned, self-hosted intent. The phase 0 checklist required an explicit
maintainer choice rather than one inferred from the code.

## Decision

All Leaflogue source, packages, and release artifacts are licensed under the GNU
Affero General Public License, version 3 or (at your option) any later version.
`LICENSE` holds the canonical FSF text, and every workspace `package.json`
declares `AGPL-3.0-or-later`.

Copyright belongs to Kavan Thakkar and the Leaflogue contributors. Contributions
are accepted under the same licence, inbound = outbound, without a separate
copyright assignment.

Distributed desktop builds include `LICENSE` and a generated
`THIRD_PARTY_NOTICES.md` beside the application. The notices generator refuses
to build when a production dependency declares a licence outside the
AGPL-compatible allowlist (`0BSD`, `Apache-2.0`, `BlueOak-1.0.0`,
`BSD-2-Clause`, `BSD-3-Clause`, `CC0-1.0`, `ISC`, `MIT`, `OFL-1.1`), so a new
licence is reviewed before it ships.

## Consequences

- Anyone who runs a modified Leaflogue server for other users over a network
  must offer those users the corresponding source. The future web client must
  link to its source, and the deployment guide must say so.
- Dependencies with incompatible licences cannot be bundled; the allowlist is
  the review point.
- The OFL-licensed fonts remain under their own licence and are listed in the
  notices.
