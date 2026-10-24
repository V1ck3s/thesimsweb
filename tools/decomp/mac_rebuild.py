#!/usr/bin/env python3
"""Rebuild the Mac PPC image of The Sims from the sims1_mac_decomp asm dump.

The repo ships the disassembly with raw bytes in comments (code) and data
directives (data), plus a symbol map. We turn it back into a flat big-endian
image so Ghidra can decompile it with the original C++ names.

Outputs (never commit them, they are derived from proprietary code):
  <out>/mac.bin        flat image, base 0x10000000
  <out>/symbols.tsv    address<TAB>kind<TAB>name   (kind: func|data)

  python3 tools/decomp/mac_rebuild.py <sims1_mac_decomp dir> <out dir>
"""

import re
import struct
import sys
from pathlib import Path

BASE = 0x10000000
END = 0x106353E0

CODE_LINE = re.compile(r"^/\* ([0-9A-F]{8}) [0-9A-F]{8}  ((?:[0-9A-F]{2} ?)+)\*/")
ROM = re.compile(r"#\s*ROM: 0x([0-9A-Fa-f]+)")
LABEL = re.compile(r'^("?)([^":\s]+)\1:\s*$')
GLOBAL_ADDR = re.compile(r'^\.global\s+("?)([^"\s]+)\1\s*#\s*0x([0-9A-Fa-f]+)')
DIRECTIVE = re.compile(r"^\s+\.(4byte|byte|2byte|asciz|skip)\s+(.*?)\s*(;#.*)?$")


def parse_c_string(s):
    assert s.startswith('"') and s.endswith('"'), s
    body = s[1:-1]
    out = bytearray()
    i = 0
    while i < len(body):
        c = body[i]
        if c == "\\":
            n = body[i + 1]
            simple = {"n": 10, "t": 9, "r": 13, "\\": 92, '"': 34, "'": 39, "0": 0, "a": 7, "b": 8, "f": 12, "v": 11}
            if n == "x":
                m = re.match(r"[0-9A-Fa-f]{1,2}", body[i + 2 :])
                out.append(int(m.group(0), 16))
                i += 2 + len(m.group(0))
                continue
            if n in "01234567" and re.match(r"[0-7]{1,3}", body[i + 1 :]):
                m = re.match(r"[0-7]{1,3}", body[i + 1 :])
                out.append(int(m.group(0), 8) & 0xFF)
                i += 1 + len(m.group(0))
                continue
            out.append(simple[n])
            i += 2
        else:
            out.extend(c.encode("latin-1"))
            i += 1
    return bytes(out) + b"\0"


def main():
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    image = bytearray(END - BASE)
    symbols = {}  # name -> address
    func_names = set()

    # Pass 1: code (bytes are in the comments) and label addresses.
    code_files = sorted((src / "asm/code").glob("*.s"))
    for f in code_files:
        pending = []
        for line in f.read_text(errors="replace").splitlines():
            m = CODE_LINE.match(line)
            if m:
                addr = int(m.group(1), 16)
                data = bytes.fromhex(m.group(2).replace(" ", ""))
                image[addr - BASE : addr - BASE + len(data)] = data
                for name in pending:
                    symbols[name] = addr
                pending = []
                continue
            m = LABEL.match(line)
            if m:
                pending.append(m.group(2))

    # Pass 2: data. Pointers may name symbols, so resolve them after a layout pass.
    data_lines = []
    for f in sorted((src / "asm/data").glob("*.s")):
        data_lines += f.read_text(errors="replace").splitlines()

    def layout(emit):
        addr = None
        for line in data_lines:
            m = GLOBAL_ADDR.match(line)
            if m:
                symbols.setdefault(m.group(2), int(m.group(3), 16))
                continue
            m = ROM.search(line)
            if m:
                addr = BASE + int(m.group(1), 16)
                continue
            m = LABEL.match(line)
            if m and addr is not None:
                symbols.setdefault(m.group(2), addr)
                continue
            m = DIRECTIVE.match(line)
            if not m:
                continue
            kind, arg = m.group(1), m.group(2)
            if kind == "asciz":
                b = parse_c_string(arg)
            elif kind == "skip":
                b = bytes(int(arg, 0))
            elif kind == "byte":
                b = bytes(int(x, 0) & 0xFF for x in arg.split(","))
            elif kind == "2byte":
                b = b"".join(struct.pack(">H", int(x, 0) & 0xFFFF) for x in arg.split(","))
            else:
                vals = []
                for x in arg.split(","):
                    x = x.strip().strip('"')
                    if re.fullmatch(r"-?(0x[0-9A-Fa-f]+|\d+)", x):
                        vals.append(int(x, 0) & 0xFFFFFFFF)
                    else:
                        mm = re.fullmatch(r"(?:lbl|func|sub)_([0-9A-Fa-f]{8})", x)
                        vals.append(int(mm.group(1), 16) if mm else symbols.get(x, 0))
                b = b"".join(struct.pack(">I", v) for v in vals)
            emit(addr, b)
            addr += len(b)

    layout(lambda a, b: None)
    layout(lambda a, b: image.__setitem__(slice(a - BASE, a - BASE + len(b)), b))

    # Names from the linker map (demangled), keyed by segment offset.
    map_text = (src / "The Sims Complete.map").read_text(errors="replace")
    demangled = {}
    for m in re.finditer(r"^ 0001:([0-9A-F]{8})\s+(.+?)\s*$", map_text, re.M):
        demangled[BASE + int(m.group(1), 16)] = m.group(2)
        func_names.add(BASE + int(m.group(1), 16))

    rows = {}
    for name, addr in symbols.items():
        if not (BASE <= addr < END):
            continue
        in_code = addr < 0x105B9458
        kind = "func" if in_code and (addr in func_names or not name.startswith("lbl_")) else "data"
        rows.setdefault(addr, (kind, name))
    for addr, name in demangled.items():
        rows[addr] = ("func", name)
    with open(out / "symbols.tsv", "w") as f:
        for addr in sorted(rows):
            kind, name = rows[addr]
            f.write(f"{addr:08X}\t{kind}\t{name}\n")
    # CFM cross-TOC calls go through __ptr_glue (0x10599B50): "lwz r12,off(r12);
    # bl __ptr_glue; lwz r2,0x14(r1)". Rewrite the last two instructions as
    # "mtctr r12; bctrl" so decompilers see a plain indirect (virtual) call.
    glue = 0x10599B50
    patched = 0
    for off in range(0, 0x105B9458 - BASE, 4):
        insn = struct.unpack_from(">I", image, off)[0]
        if insn >> 26 != 18 or insn & 3 != 1:
            continue
        disp = insn & 0x03FFFFFC
        if disp & 0x02000000:
            disp -= 0x04000000
        if BASE + off + disp != glue:
            continue
        if struct.unpack_from(">I", image, off + 4)[0] != 0x80410014:
            continue
        struct.pack_into(">II", image, off, 0x7D8903A6, 0x4E800421)
        patched += 1
    print(f"rewrote {patched} __ptr_glue calls")
    (out / "mac.bin").write_bytes(image)
    print(f"image {len(image)} bytes, {len(rows)} symbols, {len(demangled)} named functions")


if __name__ == "__main__":
    main()
