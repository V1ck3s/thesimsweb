#!/usr/bin/env python3
"""Name the Windows build's virtual methods from the Mac build's vtables.

MSVC RTTI: vtable[-1] -> CompleteObjectLocator { sig, offset, cdOffset,
TypeDescriptor*, ... } and TypeDescriptor = { vftable*, spare, ".?AVName@@" }.
For every class with RTTI we find its primary vtable (offset 0) and map slot i
to the Mac vtable entry at offset 8 + 4*i (CodeWarrior keeps RTTI and the
this-adjustment in the first two words). Declaration order is the same on
both platforms, so the names line up.

  python3 tools/decomp/win_vtables.py <Sims.exe> <mac vtables.tsv> <out symbols.tsv>
"""

import re
import struct
import sys
from collections import defaultdict


def main():
    exe, mac_vt, out = sys.argv[1:4]
    data = open(exe, "rb").read()
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    nsec = struct.unpack_from("<H", data, pe + 6)[0]
    opt = struct.unpack_from("<H", data, pe + 20)[0]
    base = struct.unpack_from("<I", data, pe + 24 + 28)[0]
    sections = []
    for i in range(nsec):
        s = pe + 24 + opt + 40 * i
        name = data[s : s + 8].rstrip(b"\0").decode()
        vsize, va, rsize, raw = struct.unpack_from("<IIII", data, s + 8)
        sections.append((name, base + va, max(vsize, rsize), raw, rsize))

    def file_off(addr):
        for _, va, size, raw, rsize in sections:
            if va <= addr < va + size and addr - va < rsize:
                return raw + addr - va
        return None

    def u32(addr):
        o = file_off(addr)
        return struct.unpack_from("<I", data, o)[0] if o is not None else None

    def to_addr(off):
        for _, va, size, raw, rsize in sections:
            if raw <= off < raw + rsize:
                return va + off - raw
        return None

    text = next(s for s in sections if s[0] == ".text")
    in_text = lambda a: a is not None and text[1] <= a < text[1] + text[2]

    # TypeDescriptors: the name string sits 8 bytes into the structure.
    tds = {}
    for m in re.finditer(rb"\.\?AV([A-Za-z_][A-Za-z0-9_]*)@@\0", data):
        a = to_addr(m.start())
        if a:
            tds[a - 8] = m.group(1).decode()

    # CompleteObjectLocators with offset 0 point at a TypeDescriptor.
    cols = {}
    for off in range(0, len(data) - 20, 4):
        sig, offset, cd, td = struct.unpack_from("<IIII", data, off)
        if sig == 0 and offset == 0 and td in tds:
            a = to_addr(off)
            if a:
                cols[a] = tds[td]

    # vtables: a word equal to a COL address, followed by code pointers.
    vtables = {}
    col_set = set(cols)
    for off in range(0, len(data) - 8, 4):
        w = struct.unpack_from("<I", data, off)[0]
        if w not in col_set:
            continue
        vt = to_addr(off) + 4
        slots = []
        while True:
            p = u32(vt + 4 * len(slots))
            if not in_text(p):
                break
            slots.append(p)
        if slots and len(slots) > len(vtables.get(cols[w], [])):
            vtables[cols[w]] = slots

    mac = defaultdict(dict)
    for line in open(mac_vt):
        cls, off, name = line.rstrip("\n").split("\t", 2)
        mac[cls][int(off, 16)] = name

    names = {}
    for cls, slots in vtables.items():
        mslots = mac.get(cls)
        if not mslots:
            continue
        for i, fn in enumerate(slots):
            name = mslots.get(8 + 4 * i)
            if not name:
                continue
            # Inherited, non-overridden methods keep their base class name; the
            # most specific class wins only when the name says it is its own.
            owner = re.sub(r"\(\(.*$", "", name)
            if fn not in names or owner.startswith(cls + "::"):
                names[fn] = name
    with open(out, "w") as f:
        for fn in sorted(names):
            f.write(f"{fn:08X}\tfunc\t{names[fn]}\n")
    print(f"{len(tds)} type descriptors, {len(cols)} locators, {len(vtables)} vtables, {len(names)} named functions")


if __name__ == "__main__":
    main()
