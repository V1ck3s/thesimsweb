#!/bin/sh
# Import + analyze + dump pseudo-C for the Mac (symbolized) or Windows build.
#   tools/decomp/ghidra.sh mac|win
# Expects: $SIMS_BUILD (default ~/simsweb-build) with opt/ (JDK + Ghidra),
# decomp/sims1_mac_decomp (for mac) and decomp/win/Sims.exe (for win).
set -e
B=${SIMS_BUILD:-$HOME/simsweb-build}
export JAVA_HOME=$(ls -d "$B"/opt/jdk-21*) GHIDRA_MAXMEM=${GHIDRA_MAXMEM:-10G}
G=$(ls -d "$B"/opt/ghidra_*)
S=$(cd "$(dirname "$0")/ghidra" && pwd)
cd "$B/decomp"
case "$1" in
  mac)
    python3 "$S/../mac_rebuild.py" sims1_mac_decomp mac
    "$G/support/analyzeHeadless" ghidra-proj sims_mac -import mac/mac.bin -overwrite \
      -loader BinaryLoader -loader-baseAddr 0x10000000 -processor PowerPC:BE:32:default -cspec default \
      -scriptPath "$S" -preScript ImportSymbols.java "$PWD/mac/symbols.tsv" r2 0x105C1460 10000000-105B9457 \
      -postScript DumpPseudoC.java "$PWD/mac-pseudoc" 60 -analysisTimeoutPerFile 7200 > ghidra-mac.log 2>&1
    ;;
  win)
    "$G/support/analyzeHeadless" ghidra-proj sims_win -import win/Sims.exe -overwrite \
      -scriptPath "$S" -postScript DumpPseudoC.java "$PWD/win-pseudoc" 60 -analysisTimeoutPerFile 7200 > ghidra-win.log 2>&1
    ;;
  *) echo "usage: $0 mac|win" >&2; exit 2 ;;
esac
grep "done:" ghidra-$1.log
