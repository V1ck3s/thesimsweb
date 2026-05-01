#!/usr/bin/env bash
# Differential test: extract a FAR archive with our Rust parser and with TS1-FAR-Unpack,
# then byte-compare every entry. Usage: ./scripts/diff/far.sh <archive.far>
#
# TS1-FAR-Unpack is a Python script. If it's not available the script clones it on the fly
# into target/diff/TS1-FAR-Unpack/ (gitignored, throwaway).
#
# Exits 0 on byte-identical match, 1 on any divergence, 2 on setup failure.

set -euo pipefail

ARCHIVE="${1:-}"
if [[ -z "$ARCHIVE" || ! -f "$ARCHIVE" ]]; then
    echo "usage: $0 <archive.far>" >&2
    exit 2
fi

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$REPO_ROOT/target/diff/far"
ORACLE_DIR="$REPO_ROOT/target/diff/TS1-FAR-Unpack"
OUR_OUT="$WORK/ours"
THEIR_OUT="$WORK/theirs"

mkdir -p "$WORK"
rm -rf "$OUR_OUT" "$THEIR_OUT"

if [[ ! -d "$ORACLE_DIR" ]]; then
    if ! command -v git >/dev/null; then
        echo "git missing — install git or clone TS1-FAR-Unpack manually into $ORACLE_DIR" >&2
        exit 2
    fi
    echo "cloning TS1-FAR-Unpack into $ORACLE_DIR…"
    git clone --depth 1 https://github.com/samulated/TS1-FAR-Unpack "$ORACLE_DIR" >/dev/null
fi

if ! command -v python3 >/dev/null; then
    echo "python3 missing — needed to run TS1-FAR-Unpack" >&2
    exit 2
fi

echo "→ ours: cargo run -p far --example dump"
cargo run --quiet -p far --example dump -- extract "$ARCHIVE" "$OUR_OUT" >/dev/null

echo "→ theirs: TS1-FAR-Unpack"
# TS1-FAR-Unpack assumes Windows paths (splits on backslashes). Stage the archive in a flat
# tmp dir under a simple basename, pre-create the expected output subfolder so its broken
# "Invalid drive specified" branch is skipped, then run.
STAGE="$WORK/stage"
rm -rf "$STAGE"
mkdir -p "$STAGE" "$THEIR_OUT"
ARCHIVE_BASE="$(basename "$ARCHIVE" .far)"
cp "$ARCHIVE" "$STAGE/$ARCHIVE_BASE.far"
mkdir -p "$THEIR_OUT/$ARCHIVE_BASE"
( cd "$STAGE" && python3 "$ORACLE_DIR/main.py" "$ARCHIVE_BASE.far" "$THEIR_OUT" >/dev/null )

# Flatten $THEIR_OUT/<archive_base>/* → $THEIR_OUT/*
shopt -s nullglob
for d in "$THEIR_OUT"/*/; do
    mv "$d"/* "$THEIR_OUT/" 2>/dev/null || true
    rmdir "$d" 2>/dev/null || true
done

echo "→ diff"
fail=0
for ours in "$OUR_OUT"/*; do
    name="$(basename "$ours")"
    theirs="$THEIR_OUT/$name"
    if [[ ! -f "$theirs" ]]; then
        echo "MISSING in oracle: $name"
        fail=1
        continue
    fi
    if ! cmp -s "$ours" "$theirs"; then
        echo "MISMATCH: $name"
        fail=1
    fi
done
for theirs in "$THEIR_OUT"/*; do
    name="$(basename "$theirs")"
    if [[ ! -f "$OUR_OUT/$name" ]]; then
        echo "MISSING in ours: $name"
        fail=1
    fi
done

if [[ $fail -eq 0 ]]; then
    echo "OK — byte-identical extraction"
    exit 0
fi
exit 1
