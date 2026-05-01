#!/usr/bin/env python3
"""Convert a Niotso wiki HTML snapshot to a clean Markdown file.

Usage: niotso-to-md.py <input.html> <output.md>

Strips the MediaWiki chrome (navigation, footer, edit links, TOC widget) and
preserves headings, lists, tables, and inline code. Used to build local copies
of the Niotso reference under docs/formats/_niotso/.
"""
import html
import re
import sys
from pathlib import Path


def extract_content(raw: str) -> str:
    m = re.search(
        r'<div id="mw-content-text"[^>]*>(.*?)<div class="printfooter"',
        raw,
        re.S,
    )
    if not m:
        raise SystemExit("could not locate mw-content-text block")
    return m.group(1)


def clean(text: str) -> str:
    text = re.sub(r"<style[^>]*>.*?</style>", "", text, flags=re.S)
    text = re.sub(r"<script[^>]*>.*?</script>", "", text, flags=re.S)
    text = re.sub(r'<div id="toc".*?</div>\s*</div>', "", text, flags=re.S)
    # mw-editsection is a span containing nested spans + an <a>edit</a>. Strip iteratively.
    for _ in range(5):
        new = re.sub(
            r'<span class="mw-editsection[^"]*">(?:[^<]|<(?!/?span\b))*'
            r"(?:<span[^>]*>(?:[^<]|<(?!/span))*</span>(?:[^<]|<(?!/?span\b))*)*"
            r"</span>",
            "",
            text,
            flags=re.S,
        )
        if new == text:
            break
        text = new
    text = re.sub(r"\[\s*<a[^>]*>edit</a>\s*\]", "", text, flags=re.S)
    text = re.sub(r'<table[^>]*class="[^"]*metadata[^"]*"[^>]*>.*?</table>', "", text, flags=re.S)
    text = re.sub(r'<table[^>]*class="[^"]*navbox[^"]*"[^>]*>.*?</table>', "", text, flags=re.S)
    return text


def convert(text: str) -> str:
    for tag, repl in [
        (r"<h1[^>]*>(.*?)</h1>", r"# \1"),
        (r"<h2[^>]*>(.*?)</h2>", r"## \1"),
        (r"<h3[^>]*>(.*?)</h3>", r"### \1"),
        (r"<h4[^>]*>(.*?)</h4>", r"#### \1"),
        (r"<h5[^>]*>(.*?)</h5>", r"##### \1"),
        (r"<li[^>]*>(.*?)</li>", r"- \1"),
        (r"<code[^>]*>(.*?)</code>", r"`\1`"),
        (r"<tt[^>]*>(.*?)</tt>", r"`\1`"),
        (r"<b[^>]*>(.*?)</b>", r"**\1**"),
        (r"<strong[^>]*>(.*?)</strong>", r"**\1**"),
        (r"<i[^>]*>(.*?)</i>", r"*\1*"),
        (r"<em[^>]*>(.*?)</em>", r"*\1*"),
    ]:
        text = re.sub(tag, repl, text, flags=re.S)
    text = re.sub(r"<p[^>]*>", "\n\n", text)
    text = re.sub(r"</p>", "\n", text)
    text = re.sub(r"<br\s*/?>", "\n", text)
    text = re.sub(r"<pre[^>]*>(.*?)</pre>", lambda m: f"\n```\n{m.group(1).strip()}\n```\n", text, flags=re.S)
    text = re.sub(r"<dl[^>]*>(.*?)</dl>", r"\n\1\n", text, flags=re.S)
    text = re.sub(r"<dt[^>]*>(.*?)</dt>", r"\n**\1**\n", text, flags=re.S)
    text = re.sub(r"<dd[^>]*>(.*?)</dd>", r": \1\n", text, flags=re.S)
    text = convert_tables(text)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip() + "\n"


def convert_tables(text: str) -> str:
    def one(match: re.Match) -> str:
        body = match.group(0)
        rows = re.findall(r"<tr[^>]*>(.*?)</tr>", body, re.S)
        out = []
        for i, row in enumerate(rows):
            cells = re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", row, re.S)
            cleaned = []
            for c in cells:
                stripped = re.sub(r"<[^>]+>", "", c)
                stripped = " ".join(stripped.split())
                stripped = stripped.replace("|", "\\|")
                cleaned.append(stripped)
            if not cleaned:
                continue
            out.append("| " + " | ".join(cleaned) + " |")
            if i == 0:
                out.append("|" + "|".join(["---"] * len(cleaned)) + "|")
        return "\n" + "\n".join(out) + "\n"
    return re.sub(r"<table[^>]*>.*?</table>", one, text, flags=re.S)


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: niotso-to-md.py <input.html> <output.md>")
    src = Path(sys.argv[1])
    dst = Path(sys.argv[2])
    raw = src.read_text(encoding="utf-8")
    title_m = re.search(r"<title>([^<]+)</title>", raw)
    title = title_m.group(1).replace(" - Niotso Wiki", "") if title_m else src.stem
    body = clean(extract_content(raw))
    md = convert(body)
    header = (
        f"# Niotso wiki snapshot — {title}\n\n"
        f"> Source: <http://wiki.niotso.org/{src.stem}>  \n"
        f"> Snapshot: 2026-05-01. Cleaned from HTML.\n\n"
    )
    dst.write_text(header + md, encoding="utf-8")


if __name__ == "__main__":
    main()
