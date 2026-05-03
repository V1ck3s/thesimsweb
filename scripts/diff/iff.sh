#!/usr/bin/env bash
# Regression test for the IFF parser.
#
# Re-dumps every IFF in samples/iff/ via `cargo run -p iff --example dump`
# and diffs the output against a checked-in golden under tests/golden/iff/.
#
# Acts as a stand-in for a true differential test against IFFSnooper (which
# is a Windows-only GUI). Goldens are user-promoted: if you intentionally
# change the dump format, regenerate them by re-running dump and copying
# the output into tests/golden/iff/<file>.txt.
#
# Exits 0 on match, 1 on any divergence, 2 on missing samples.

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SAMPLES_DIR="$REPO_ROOT/samples/iff"
GOLDEN_DIR="$REPO_ROOT/tests/golden/iff"

if [[ ! -d "$SAMPLES_DIR" ]]; then
    echo "samples/iff/ missing — copy reference IFFs there first" >&2
    exit 2
fi

shopt -s nullglob
fail=0
checked=0

for golden in "$GOLDEN_DIR"/*.txt; do
    name="$(basename "$golden" .txt)"
    sample="$SAMPLES_DIR/$name"
    if [[ ! -f "$sample" ]]; then
        echo "SKIP: $name (no sample at $sample)"
        continue
    fi
    actual="$(cargo run --quiet -p iff --example dump -- "$sample" 2>/dev/null)"
    if ! diff -u "$golden" <(echo "$actual") >/dev/null; then
        echo "MISMATCH: $name"
        diff -u "$golden" <(echo "$actual") | head -40
        fail=1
    else
        echo "OK: $name"
    fi
    checked=$((checked + 1))
done

if [[ $checked -eq 0 ]]; then
    echo "no goldens to check (looked under $GOLDEN_DIR)" >&2
    exit 2
fi

if [[ $fail -eq 0 ]]; then
    echo "OK — $checked golden(s) match"
    exit 0
fi
exit 1
