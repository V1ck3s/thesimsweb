#!/usr/bin/env bash
# Build a FAT32 disk image containing the minimal Sims footprint.
# Output: sims-disk/sims.img (~500 MiB)
#
# Win98 in v86 will mount this as D:. From there, Sims.exe can run directly
# (the no-CD crack does not require an installer).

set -euo pipefail

cd "$(dirname "$0")"

GAME_SRC="/mnt/c/Program Files (x86)/Maxis/Les Sims"
IMG_DIR="sims-disk"
IMG="$IMG_DIR/sims.img"
SIZE_MIB=500

if [[ ! -d "$GAME_SRC" ]]; then
  echo "ERROR: game directory not found at $GAME_SRC" >&2
  exit 1
fi

mkdir -p "$IMG_DIR"

echo "==> creating $SIZE_MIB MiB blank image"
truncate -s "${SIZE_MIB}M" "$IMG"

echo "==> formatting FAT32 (label SIMS)"
mkfs.vfat -F 32 -n SIMS "$IMG" >/dev/null

# Components — total ~400 MiB. Music omitted (~480 MiB, not required to boot).
COMPONENTS=(
  "Sims.exe"
  "gimex.dll"
  "ijl10.dll"
  "GameData"
  "UIGraphics"
  "SoundData"
  "UserData"
)

for c in "${COMPONENTS[@]}"; do
  src="$GAME_SRC/$c"
  if [[ ! -e "$src" ]]; then
    echo "  skip $c (not found)"
    continue
  fi
  echo "==> copying $c"
  mcopy -i "$IMG" -s -Q -o "$src" "::/"
done

echo "==> done"
ls -lh "$IMG"
echo
echo "Top-level contents:"
mdir -i "$IMG" "::/" | head -20
