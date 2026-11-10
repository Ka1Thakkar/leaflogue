#!/usr/bin/env bash
set -euo pipefail
ARCHITECTURE="${1:?architecture required}"
artifact_directory="${2:?artifact directory required}"
validation_directory="$(mktemp -d)"
trap 'rm -rf "$validation_directory"' EXIT
manifest="$artifact_directory/SHA256SUMS-${ARCHITECTURE}.txt"
test -f "$manifest"
(
  cd "$artifact_directory"
  sha256sum --check "$(basename "$manifest")"
)

test "$(find "$artifact_directory" -maxdepth 1 -type f -name '*.AppImage' | wc -l)" = 1
test "$(find "$artifact_directory" -maxdepth 1 -type f -name '*.tar.gz' | wc -l)" = 1
test -z "$(find "$artifact_directory" -maxdepth 1 -type f -name '*.rpm')"

app_image="$(find "$artifact_directory" -maxdepth 1 -type f -name '*.AppImage' -print -quit)"
case "$ARCHITECTURE" in
  x64) expected_machine='Advanced Micro Devices X86-64' ;;
  arm64) expected_machine='AArch64' ;;
  *) echo "Unsupported architecture: $ARCHITECTURE" >&2; exit 1 ;;
esac
readelf --file-header "$app_image" | grep --fixed-strings "Machine:                           $expected_machine"

payload_directory=''
while IFS=: read -r squashfs_offset _; do
  candidate_directory="$(mktemp -d "$validation_directory/payload.XXXXXX")"
  rmdir "$candidate_directory"
  if unsquashfs -offset "$squashfs_offset" -dest "$candidate_directory" "$app_image" >/dev/null 2>&1; then
    payload_directory="$candidate_directory"
    break
  fi
  rm -rf "$candidate_directory"
done < <(LC_ALL=C grep --binary-files=text --byte-offset --only-matching 'hsqs' "$app_image")
test -n "$payload_directory"
test -x "$payload_directory/leaflogue"
readelf --file-header "$payload_directory/leaflogue" |
  grep --fixed-strings "Machine:                           $expected_machine"

tarball="$(find "$artifact_directory" -maxdepth 1 -type f -name '*.tar.gz' -print -quit)"
tar -tzf "$tarball" > "$validation_directory/archive-paths.txt"
if grep --extended-regexp '(^/|(^|/)\.\.(/|$))' "$validation_directory/archive-paths.txt"; then
  echo 'Unsafe archive path' >&2
  exit 1
fi
tar -tvzf "$tarball" > "$validation_directory/archive-members.txt"
if grep --extended-regexp '^[lh].*( -> | link to )(\.\.(/|$)|/|.*/\.\.(/|$))' "$validation_directory/archive-members.txt"; then
  echo 'Unsafe archive link' >&2
  exit 1
fi
tar_directory="$validation_directory/tar"
mkdir -p "$tar_directory"
tar -xzf "$tarball" --directory "$tar_directory"
tar_executable="$(find "$tar_directory" -type f -name leaflogue -perm /111 -print -quit)"
test -n "$tar_executable"
readelf --file-header "$tar_executable" | grep --fixed-strings "Machine:                           $expected_machine"
