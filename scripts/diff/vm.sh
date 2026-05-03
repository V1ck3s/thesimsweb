#!/usr/bin/env bash
# Differential test: run our SimAntics VM trace against an oracle
# (FreeSO/Simitone or any other implementation that emits the same JSON
# schema documented in `docs/diff/vm-trace.md`).
#
# This script captures *our* trace via `cargo run -p simantics --example
# trace_json` and `diff`s it line-by-line against `<oracle-trace>.jsonl`.
# It does NOT build or run FreeSO itself — that requires .NET 6+ and is
# outside the sandbox. The expected workflow:
#   1. Run FreeSO/Simitone with an instrumented harness, dump JSONL.
#   2. Pass the path here as the oracle.
#
# Exits 0 on byte-identical match, 1 on any divergence, 2 on setup failure.

set -euo pipefail

ours_trace=""
oracle_trace=""
object_iff=""
event=1
globals_far=""

usage() {
    cat <<EOF >&2
usage: $0 --object <object.iff> --oracle <trace.jsonl> [--event N] [--globals-far <path>]

Optional:
  --globals-far PATH      Resolve semi-global BHAVs through Global.far
  --event N               OBJf event index (default 1 = Main)
  --keep-ours PATH        Save our generated trace to PATH for inspection
EOF
}

keep_ours=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --object) object_iff="$2"; shift 2 ;;
        --oracle) oracle_trace="$2"; shift 2 ;;
        --event) event="$2"; shift 2 ;;
        --globals-far) globals_far="$2"; shift 2 ;;
        --keep-ours) keep_ours="$2"; shift 2 ;;
        *) usage; exit 2 ;;
    esac
done

if [[ -z "$object_iff" || -z "$oracle_trace" ]]; then
    usage
    exit 2
fi
if [[ ! -f "$object_iff" || ! -f "$oracle_trace" ]]; then
    echo "missing input file(s)" >&2
    exit 2
fi

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ours_trace="$(mktemp)"
trap 'rm -f "$ours_trace"' EXIT

cmd=(cargo run --release --quiet --manifest-path "$REPO_ROOT/Cargo.toml" -p simantics --example trace_json --
     "$object_iff" --event "$event")
[[ -n "$globals_far" ]] && cmd+=(--globals-far "$globals_far")

"${cmd[@]}" > "$ours_trace"

if [[ -n "$keep_ours" ]]; then
    cp "$ours_trace" "$keep_ours"
    echo "saved our trace → $keep_ours"
fi

if diff -u "$oracle_trace" "$ours_trace" >/tmp/vm_diff.txt; then
    echo "OK — traces match (object=$object_iff event=$event)"
    exit 0
fi

echo "MISMATCH:"
cat /tmp/vm_diff.txt | head -80
exit 1
