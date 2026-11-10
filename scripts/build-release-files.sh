#!/usr/bin/env bash
set -euo pipefail
version="$(node -p 'JSON.parse(require("node:fs").readFileSync("apps/desktop/package.json")).version')"
for architecture in x64 arm64; do
  npm run "package:linux:$architecture" --workspace @leaflogue/desktop
  directory="release-files/$architecture"
  mkdir -p "$directory"
  appimage_arch="$architecture"
  if [ "$architecture" = x64 ]; then appimage_arch=x86_64; fi
  cp "apps/desktop/dist/Leaflogue-$version-$appimage_arch.AppImage" \
    "apps/desktop/dist/Leaflogue-$version-$architecture.tar.gz" \
    "apps/desktop/dist/Leaflogue-$version-$architecture.build-inputs.json" \
    "apps/desktop/dist/Leaflogue-$version-$architecture.production-audit.json" \
    "apps/desktop/dist/Leaflogue-$version-$architecture.supply-chain.cdx.json" \
    "apps/desktop/dist/SHA256SUMS-$architecture.txt" "$directory/"
done
if [[ "${GITHUB_REF:-}" == refs/tags/v* ]]; then
  backend_version="${GITHUB_REF_NAME#v}"
else
  backend_version="0.0.0-ci.${GITHUB_SHA:0:12}"
fi
node scripts/package-convex-backend.mjs --version "$backend_version"
mkdir -p release-files/convex
cp "release/convex/Leaflogue-Convex-$backend_version.tar.gz" \
  "release/convex/Leaflogue-Convex-$backend_version.manifest.json" \
  release/convex/SHA256SUMS-convex.txt release-files/convex/
(cd release-files/convex && sha256sum --check SHA256SUMS-convex.txt)
