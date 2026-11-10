#!/usr/bin/env bash
set -euo pipefail
artifact_directory="$(realpath "${1:?artifact directory required}")"
(cd "$artifact_directory" && sha256sum --check SHA256SUMS-convex.txt)
archive="$(find "$artifact_directory" -maxdepth 1 -name '*.tar.gz' -print -quit)"
extract_directory="$(mktemp -d)"
trap 'rm -rf "$extract_directory"' EXIT
if tar -tzf "$archive" | grep --extended-regexp '(^/|(^|/)\.\.(/|$)|node_modules|\.test\.ts$|/_generated/)'; then
  echo 'Unexpected Convex bundle member' >&2
  exit 1
fi
tar -xzf "$archive" --directory "$extract_directory"
bundle="$(find "$extract_directory" -mindepth 1 -maxdepth 1 -type d -print -quit)"
test -x "$bundle/deploy.sh"
(cd "$bundle" && npm ci --ignore-scripts --no-audit --no-fund)
"$bundle/deploy.sh" --production --help
