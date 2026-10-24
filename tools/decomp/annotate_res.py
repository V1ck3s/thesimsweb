#!/usr/bin/env python3
"""Name UI resource ids in pseudo-C: `LoadBuffer(0x7e7,` -> `LoadBuffer(0x7e7 /*kName*/,`.

  python3 tools/decomp/annotate_res.py <UIGraphics dir> <pseudo-C dir (edited in place)>
"""
import re
import sys
from pathlib import Path

ui, src = Path(sys.argv[1]), Path(sys.argv[2])
names = {}
for h in ui.glob("*.h"):
    for m in re.finditer(r"const\s+Sint32\s+(\w+)\s*=\s*(-?(?:0x[0-9a-fA-F]+|\d+))\s*;", h.read_text(errors="replace")):
        names.setdefault(int(m.group(2), 0), m.group(1))
call = re.compile(r"(nsSMResFac::\w+\()(0x[0-9a-f]+|\d+)(?=[,)])")
n = 0
for f in src.glob("*.c"):
    text = f.read_text(errors="replace")
    def sub(m):
        global n
        name = names.get(int(m.group(2), 0))
        if not name:
            return m.group(0)
        n += 1
        return f"{m.group(1)}{m.group(2)} /*{name}*/"
    f.write_text(call.sub(sub, text))
print(f"named {n} resource ids")
