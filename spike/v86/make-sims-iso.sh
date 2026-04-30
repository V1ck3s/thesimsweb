#!/usr/bin/env bash
# Build an ISO 9660 image of the minimal Sims footprint, with Joliet
# extensions so Win98 sees the long filenames correctly.
#
# Why ISO instead of a partitioned hard disk:
#   - v86 wires `hdb` as primary IDE slave, which Win98's IFSMGR/IOS handles
#     poorly (we hit "Invalid VxD dynamic link call from VMM" on cold boot).
#   - The `cdrom` slot is on the secondary IDE channel (master), unrelated to
#     the boot disk — Win98 mounts it via its native ATAPI driver. Stable.
#
# Output: sims-disk/sims.iso (~410 MiB)

set -euo pipefail

cd "$(dirname "$0")"

GAME_SRC="/mnt/c/Program Files (x86)/Maxis/Les Sims"
STAGING="sims-disk/staging"
ISO="sims-disk/sims.iso"

if [[ ! -d "$GAME_SRC" ]]; then
  echo "ERROR: game directory not found at $GAME_SRC" >&2
  exit 1
fi

if ! command -v genisoimage >/dev/null; then
  echo "ERROR: genisoimage not found. Install with:" >&2
  echo "  sudo apt-get install -y genisoimage" >&2
  exit 1
fi

mkdir -p "$STAGING"

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

echo "==> staging files in $STAGING"
for c in "${COMPONENTS[@]}"; do
  src="$GAME_SRC/$c"
  if [[ ! -e "$src" ]]; then
    echo "  skip $c (not found)"
    continue
  fi
  echo "  copy $c"
  # cp -u: only update if source is newer (cheap re-runs)
  cp -ru "$src" "$STAGING/"
done

echo "==> building ISO 9660 (with Joliet for Win9x long names)"
rm -f "$ISO"
genisoimage \
  -quiet \
  -J \
  -joliet-long \
  -r \
  -V SIMS \
  -o "$ISO" \
  "$STAGING/"

echo "==> done"
ls -lh "$ISO"
