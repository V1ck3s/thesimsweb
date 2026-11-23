# Decompilation reference

The web client reproduces the original game shell (window system, control
panel, neighborhood, dialogs) from the game's own code. We decompile two
builds and read them side by side:

| Build | Source | Names |
|---|---|---|
| Mac OS 9 PowerPC (Complete Collection, 2006) | asm dump from [sims1_mac_decomp](https://github.com/simdecomp/sims1_mac_decomp) | ~16,000 C++ function names (linker map) |
| Windows x86 `Sims.exe` (French Complete Edition, 2003) | the local install | RTTI class names only |

The Mac build is the primary reading source because every function is named
(`cWinCPanel::Init`, `cTSWinBtn::TSPaint`, ...). The Windows build confirms
constants and catches platform differences.

**Nothing produced here is committed**: the rebuilt image, Ghidra projects and
pseudo-C are derived from proprietary code and live under `~/simsweb-build/`.

## Setup

```sh
B=~/simsweb-build
mkdir -p $B/opt $B/decomp/win
# JDK 21 + Ghidra 12.1.x unpacked into $B/opt (no root needed)
git clone --depth 1 https://github.com/simdecomp/sims1_mac_decomp $B/decomp/sims1_mac_decomp
cp "<game folder>/Sims.exe" $B/decomp/win/

tools/decomp/ghidra.sh mac   # -> $B/decomp/mac-pseudoc/<Class>.c
tools/decomp/ghidra.sh win   # -> $B/decomp/win-pseudoc/_global.c
```

## How the Mac image is rebuilt

`tools/decomp/mac_rebuild.py` turns the asm dump back into a flat big-endian
image based at `0x10000000`:

- code bytes come from the `/* VMA OFFSET  BYTES */` comments,
- data comes from `.4byte/.byte/.asciz/.skip` directives (pointers resolved
  through label addresses),
- every `bl __ptr_glue; lwz r2,0x14(r1)` pair (CFM indirect call) is rewritten
  as `mtctr r12; bctrl` so Ghidra shows ordinary virtual calls,
- `symbols.tsv` carries the demangled names from `The Sims Complete.map`.

Ghidra then gets `r2` (TOC) pinned to `0x105C1460` for the whole code range.

## UI resources

UI bitmaps are referenced by numeric id (`nsSMResFac::LoadBuffer(0x132e)`).
`UIGraphics/Res_*.h` gives the names (`kUniversalCPBkg = 4910`) and
`Res_*.RT` the bitmap paths. `client/src/game/res/uires.ts` implements the
same lookup, so decompiled code can be ported with its ids unchanged.
