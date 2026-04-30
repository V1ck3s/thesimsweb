#!/usr/bin/env bash
# Build a partitioned disk image (MBR + single FAT32 partition) containing the
# minimal Sims footprint. Win98 needs an MBR to recognise a secondary disk —
# a bare FS on the raw image gives "device not ready".
#
# Output: sims-disk/sims.img (~500 MiB)

set -euo pipefail

cd "$(dirname "$0")"

GAME_SRC="/mnt/c/Program Files (x86)/Maxis/Les Sims"
IMG_DIR="sims-disk"
IMG="$IMG_DIR/sims.img"
SIZE_MIB=500

# Partition layout
PART_START_SECTOR=2048              # 1 MiB alignment (standard)
SECTOR_SIZE=512
PART_OFFSET_BYTES=$((PART_START_SECTOR * SECTOR_SIZE))

if [[ ! -d "$GAME_SRC" ]]; then
  echo "ERROR: game directory not found at $GAME_SRC" >&2
  exit 1
fi

mkdir -p "$IMG_DIR"

echo "==> creating $SIZE_MIB MiB blank image"
rm -f "$IMG"
truncate -s "${SIZE_MIB}M" "$IMG"

echo "==> writing MBR + 1 FAT32 LBA partition (sfdisk)"
# type=0c = FAT32 LBA (visible to Win98 SE)
echo "label: dos
start=${PART_START_SECTOR}, type=0c, bootable" | /usr/sbin/sfdisk "$IMG" >/dev/null

echo "==> formatting partition as FAT32 (mformat @@offset)"
mformat -i "${IMG}@@${PART_OFFSET_BYTES}" -F -v SIMS

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
  mcopy -i "${IMG}@@${PART_OFFSET_BYTES}" -s -Q -o "$src" "::/"
done

echo "==> verifying"
echo -n "  MBR signature: "
xxd -s 510 -l 2 "$IMG" | awk '{print $2 $3}'
echo "  partition table:"
/usr/sbin/sfdisk -d "$IMG" | sed 's/^/    /'
echo "  top-level files:"
mdir -i "${IMG}@@${PART_OFFSET_BYTES}" "::/" | sed 's/^/    /' | head -25

echo
echo "==> done"
ls -lh "$IMG"
