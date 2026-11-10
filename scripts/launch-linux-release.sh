#!/usr/bin/env bash
set -euo pipefail
artifact_directory="$(realpath "${1:?artifact directory required}")"
app_image="$(find "$artifact_directory" -maxdepth 1 -type f -name '*.AppImage' -print -quit)"
chmod +x "$app_image"
extraction_directory="$(mktemp -d)"
profile_directory="$(mktemp -d)"
trap 'rm -rf "$extraction_directory" "$profile_directory"' EXIT
(cd "$extraction_directory" && "$app_image" --appimage-extract >/dev/null)
set +e
timeout --signal=TERM --kill-after=5s 20s xvfb-run -a env \
  HOME="$profile_directory" \
  XDG_CONFIG_HOME="$profile_directory/config" \
  XDG_DATA_HOME="$profile_directory/data" \
  "$extraction_directory/squashfs-root/leaflogue" --no-sandbox \
  >"$profile_directory/leaflogue.stdout" 2>"$profile_directory/leaflogue.stderr"
status=$?
set -e
if [ "$status" -ne 124 ] && [ "$status" -ne 137 ]; then
  cat "$profile_directory/leaflogue.stdout" >&2
  cat "$profile_directory/leaflogue.stderr" >&2
  exit 1
fi
test -n "$(find "$profile_directory" -type f -name library.sqlite -print -quit)"
