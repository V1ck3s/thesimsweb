#!/usr/bin/env bash
#
# Transcode TS1 intro/cutscene videos (.avi, MS MPEG-4 v1 + PCM s16le) to
# web-friendly formats (.webm = VP9 + Opus, .mp4 = H.264 + AAC). The originals
# are read-only assets we don't redistribute; outputs land under
# `server/assets/converted/intro/` which is gitignored.
#
# Usage:
#   ./scripts/transcode-videos.sh           # converts every .avi found
#   ./scripts/transcode-videos.sh --dry-run # list what would be converted
#   ./scripts/transcode-videos.sh --no-mp4  # skip the .mp4 output
#
# Idempotent: skips outputs that already exist and are newer than the source.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_ROOT="${SOURCE_ROOT:-${REPO_ROOT}/server/assets/Sims}"
OUT_ROOT="${OUT_ROOT:-${REPO_ROOT}/server/assets/converted/intro}"
DRY_RUN=0
NO_MP4=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-mp4)  NO_MP4=1 ;;
    -h|--help)
      sed -n '2,15p' "$0"
      exit 0
      ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [ ! -d "$SOURCE_ROOT" ]; then
  echo "source dir not found: $SOURCE_ROOT" >&2
  echo "set SOURCE_ROOT or symlink server/assets/Sims to your TS1 install." >&2
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg not found in PATH" >&2
  exit 1
fi

mkdir -p "$OUT_ROOT"

needs_rebuild() {
  local src="$1" dst="$2"
  [ ! -f "$dst" ] && return 0
  [ "$src" -nt "$dst" ] && return 0
  return 1
}

transcode_one() {
  local src="$1"
  local stem
  stem="$(basename "$src" .avi)"
  stem="$(basename "$stem" .AVI)"
  local webm="$OUT_ROOT/${stem}.webm"
  local mp4="$OUT_ROOT/${stem}.mp4"

  if needs_rebuild "$src" "$webm"; then
    echo "→ ${stem}.webm  ($(du -h "$src" | cut -f1))"
    if [ "$DRY_RUN" -eq 0 ]; then
      ffmpeg -hide_banner -loglevel error -y -i "$src" \
        -c:v libvpx-vp9 -crf 32 -b:v 0 -row-mt 1 -threads 0 \
        -c:a libopus -b:a 96k \
        -movflags +faststart \
        "$webm"
    fi
  else
    echo "✓ ${stem}.webm  (up-to-date)"
  fi

  if [ "$NO_MP4" -eq 0 ] && needs_rebuild "$src" "$mp4"; then
    echo "→ ${stem}.mp4"
    if [ "$DRY_RUN" -eq 0 ]; then
      ffmpeg -hide_banner -loglevel error -y -i "$src" \
        -c:v libx264 -preset medium -crf 22 -pix_fmt yuv420p \
        -c:a aac -b:a 128k \
        -movflags +faststart \
        "$mp4"
    fi
  fi
}

# Walk the asset tree; the EA branding intros live under Music/, but other
# expansions may add further .avi files (cutscenes etc.).
count=0
while IFS= read -r -d '' avi; do
  transcode_one "$avi"
  count=$((count + 1))
done < <(find -L "$SOURCE_ROOT" -type f \( -iname '*.avi' \) -print0 | sort -z)

if [ "$count" -eq 0 ]; then
  echo "no .avi files under $SOURCE_ROOT"
fi
echo "done — outputs in $OUT_ROOT"
