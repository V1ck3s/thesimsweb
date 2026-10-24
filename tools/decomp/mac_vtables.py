#!/usr/bin/env python3
"""Recover C++ vtables from the rebuilt Mac image and annotate pseudo-C.

CodeWarrior PPC vtables look like:
    +0  -> RTTI record { const char *class_name; bases... }
    +4  0 (this adjustment)
    +8  -> TVector { code address, TOC }   (slot 0x08)
    +12 -> TVector ...
So `(**(code **)(*obj + 0x68))(...)` in Ghidra output is slot 0x68.

  python3 tools/decomp/mac_vtables.py <out dir from mac_rebuild.py> [pseudo-C dir]

Writes <out>/vtables.tsv (class, slot, method) and, when a pseudo-C dir is
given, a sibling "<dir>-annotated" where virtual calls carry the method name:
calls on `param_1` (this) use the method's own class, others fall back to
cTSWin when the slot exists there.
"""

import re
import struct
import sys
from pathlib import Path

BASE = 0x10000000
CODE_END = 0x105B9458
TOC = 0x105C1460


def main():
    out = Path(sys.argv[1])
    image = (out / "mac.bin").read_bytes()
    names = {}
    for line in (out / "symbols.tsv").read_text().splitlines():
        addr, kind, name = line.split("\t", 2)
        if kind == "func":
            names[int(addr, 16)] = name

    def word(a):
        return struct.unpack_from(">I", image, a - BASE)[0] if BASE <= a < BASE + len(image) - 3 else None

    def cstr(a):
        if not (BASE <= a < BASE + len(image)):
            return None
        end = image.find(b"\0", a - BASE, a - BASE + 200)
        s = image[a - BASE : end]
        return s.decode("latin-1") if end > 0 and re.fullmatch(rb"[A-Za-z_][A-Za-z0-9_<>:,* ]{1,150}", s) else None

    def tvector_target(p):
        code, toc = word(p), word(p + 4)
        if code is None or toc != TOC or not (BASE <= code < CODE_END):
            return None
        return code

    vtables = {}
    for a in range(CODE_END + 8 - (CODE_END % 4), BASE + len(image) - 12, 4):
        rtti = word(a)
        if word(a + 4) != 0 or rtti is None:
            continue
        cls = cstr(word(rtti) or 0)
        if not cls:
            continue
        slots = []
        p = a + 8
        while True:
            t = word(p)
            code = tvector_target(t) if t else None
            if code is None:
                break
            slots.append((p - a, names.get(code, f"func_{code:08X}")))
            p += 4
        if len(slots) >= 2 and (cls not in vtables or len(slots) > len(vtables[cls])):
            vtables[cls] = slots

    with open(out / "vtables.tsv", "w") as f:
        for cls in sorted(vtables):
            for off, name in vtables[cls]:
                f.write(f"{cls}\t0x{off:x}\t{name}\n")
    print(f"{len(vtables)} vtables")

    if len(sys.argv) > 2:
        annotate(Path(sys.argv[2]), vtables)


def short(name):
    return re.sub(r"\(\(.*$", "", name)


def annotate(src, vtables):
    dst = src.with_name(src.name + "-annotated")
    dst.mkdir(exist_ok=True)
    by_class = {c: dict(s) for c, s in vtables.items()}
    # Receivers of unknown type: the decompiler loses the class, so list the
    # slot's meaning in the most common interfaces.
    fallbacks = [by_class.get(c, {}) for c in ("cTSWin", "cTSBuffer", "cTSFont")]
    call = re.compile(r"\(\*\*\(code \*\*\)\(\*(\(int \*\))?(\w+(?:\[0x[0-9a-f]+\])?) \+ (0x[0-9a-f]+)\)\)")
    header = re.compile(r"^// [0-9a-f]+  (?:(\w+)::)?")
    for f in src.glob("*.c"):
        cls = None
        lines = []
        for line in f.read_text(errors="replace").splitlines():
            m = header.match(line)
            if m:
                cls = m.group(1)

            def sub(m):
                obj, off = m.group(2), int(m.group(3), 16)
                table = by_class.get(cls, {}) if obj == "param_1" else {}
                if off in table:
                    return m.group(0) + f"/*{short(table[off])}*/"
                names = [short(t[off]) for t in fallbacks if off in t]
                return m.group(0) + (f"/*{' | '.join(names)} ?*/" if names else "")

            lines.append(call.sub(sub, line))
        (dst / f.name).write_text("\n".join(lines) + "\n")
    print("annotated ->", dst)


if __name__ == "__main__":
    main()
