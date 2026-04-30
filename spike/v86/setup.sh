#!/usr/bin/env bash
# spike/v86 — bootstrap script.
# Idempotent: re-running is safe.

set -euo pipefail

cd "$(dirname "$0")"

echo "==> npm install"
npm install --no-audit --no-fund

if [[ ! -d v86-source ]]; then
  echo "==> shallow-cloning v86 source (needed for BIOS files)"
  git clone --depth=1 https://github.com/copy/v86.git v86-source
fi

echo "==> copying BIOS files"
mkdir -p bios
cp v86-source/bios/seabios.bin bios/
cp v86-source/bios/vgabios.bin bios/

echo "==> done. Run: npm run serve"
echo "    then open http://localhost:8080/ in Firefox"
