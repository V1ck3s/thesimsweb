// IFF chunk walker + STR# decoder (TS1 / TSO).
// Spec: docs/formats/_niotso/IFF.md §5.35 (STR#).
//
// Layout: 64-byte file header, then back-to-back chunks of:
//   kind  : 4 ASCII bytes
//   size  : u32 BE (entire chunk incl. 76-byte header)
//   id    : u16 BE
//   flags : u16 BE
//   label : 64 ASCII bytes
//   data  : (size - 76) bytes, little-endian
//
// STR# data starts with a 2-byte signed version: 0, -1, -2, -3, -4.

const HEADER_LEN = 64;
const CHUNK_HEADER_LEN = 76;

const decoders = {
  1: new TextDecoder("windows-1252"), // English (US)
  2: new TextDecoder("windows-1252"), // English (intl)
  3: new TextDecoder("windows-1252"), // French
  4: new TextDecoder("windows-1252"), // German
  5: new TextDecoder("windows-1252"), // Italian
  6: new TextDecoder("windows-1252"), // Spanish
  7: new TextDecoder("windows-1252"), // Dutch
  8: new TextDecoder("windows-1252"), // Danish
  9: new TextDecoder("windows-1252"), // Swedish
  10: new TextDecoder("windows-1252"), // Norwegian
  11: new TextDecoder("windows-1252"), // Finnish
  14: new TextDecoder("windows-1252"), // Portuguese
};
const defaultDec = new TextDecoder("windows-1252");

function decodeBytes(bytes, langCode) {
  return (decoders[langCode] ?? defaultDec).decode(bytes);
}

export function isIff(buf) {
  if (buf.length < HEADER_LEN) return false;
  const ascii = buf.subarray(0, 15).toString("ascii");
  return ascii === "IFF FILE 2.5:TY" || ascii === "IFF FILE 2.0:TY";
}

export function* chunks(buf) {
  if (!isIff(buf)) throw new Error("not a Maxis IFF (bad magic)");
  let cursor = HEADER_LEN;
  while (cursor + CHUNK_HEADER_LEN <= buf.length) {
    const kind = buf.subarray(cursor, cursor + 4).toString("ascii");
    const size = buf.readUInt32BE(cursor + 4);
    if (size < CHUNK_HEADER_LEN) break;
    const id = buf.readUInt16BE(cursor + 8);
    const flags = buf.readUInt16BE(cursor + 10);
    const labelRaw = buf.subarray(cursor + 12, cursor + 76);
    const labelEnd = labelRaw.indexOf(0);
    const label = labelRaw.subarray(0, labelEnd === -1 ? labelRaw.length : labelEnd).toString("ascii");
    const chunkEnd = cursor + size;
    if (chunkEnd > buf.length) break;
    const data = buf.subarray(cursor + CHUNK_HEADER_LEN, chunkEnd);
    yield { kind, size, id, flags, label, data, offset: cursor };
    cursor = chunkEnd;
  }
}

// Parse a single STR# chunk's data.
// Returns { version, entries: [{ lang, text, comment }] } where lang=0 for
// formats that don't carry a language code (treated as "default").
export function parseStrChunk(data) {
  if (data.length < 2) return { version: null, entries: [] };
  const version = data.readInt16LE(0);
  let p = 2;
  const entries = [];

  if (version === 0) {
    // Pascal strings, no language code.
    if (p + 2 > data.length) return { version, entries };
    const n = data.readUInt16LE(p);
    p += 2;
    for (let i = 0; i < n && p < data.length; i += 1) {
      const len = data[p];
      p += 1;
      if (p + len > data.length) break;
      const text = decodeBytes(data.subarray(p, p + len), 0);
      p += len;
      entries.push({ lang: 0, text, comment: "" });
    }
    return { version, entries };
  }

  if (version === -1) {
    // C strings, no language code.
    if (p + 2 > data.length) return { version, entries };
    const n = data.readUInt16LE(p);
    p += 2;
    for (let i = 0; i < n; i += 1) {
      const s = readCString(data, p, 0);
      entries.push({ lang: 0, text: s.text, comment: "" });
      p = s.next;
    }
    return { version, entries };
  }

  if (version === -2) {
    // C string pairs (text, comment), no language code.
    if (p + 2 > data.length) return { version, entries };
    const n = data.readUInt16LE(p);
    p += 2;
    for (let i = 0; i < n; i += 1) {
      const t = readCString(data, p, 0);
      p = t.next;
      const c = readCString(data, p, 0);
      p = c.next;
      entries.push({ lang: 0, text: t.text, comment: c.text });
    }
    return { version, entries };
  }

  if (version === -3) {
    // C string pairs, each pair prefixed by a 1-byte language code.
    if (p + 2 > data.length) return { version, entries };
    const n = data.readUInt16LE(p);
    p += 2;
    for (let i = 0; i < n && p < data.length; i += 1) {
      const lang = data[p];
      p += 1;
      const t = readCString(data, p, lang);
      p = t.next;
      const c = readCString(data, p, lang);
      p = c.next;
      entries.push({ lang, text: t.text, comment: c.text });
    }
    return { version, entries };
  }

  if (version === -4) {
    // TSO-only variable-length Pascal strings, grouped by language.
    if (p + 1 > data.length) return { version, entries };
    const langSets = data[p];
    p += 1;
    for (let s = 0; s < langSets && p + 2 <= data.length; s += 1) {
      const n = data.readUInt16LE(p);
      p += 2;
      for (let i = 0; i < n && p < data.length; i += 1) {
        const lang = data[p] + 1;
        p += 1;
        const t = readVarPascal(data, p, lang);
        p = t.next;
        const c = readVarPascal(data, p, lang);
        p = c.next;
        entries.push({ lang, text: t.text, comment: c.text });
      }
    }
    return { version, entries };
  }

  return { version, entries };
}

function readCString(buf, p, lang) {
  let end = p;
  while (end < buf.length && buf[end] !== 0) end += 1;
  const text = decodeBytes(buf.subarray(p, end), lang);
  return { text, next: end + 1 };
}

function readVarPascal(buf, p, lang) {
  let len = 0;
  let shift = 0;
  while (p < buf.length) {
    const b = buf[p];
    p += 1;
    if ((b & 0x80) === 0) {
      len |= b << shift;
      break;
    }
    len |= (b & 0x7f) << shift;
    shift += 7;
  }
  const text = decodeBytes(buf.subarray(p, p + len), lang);
  return { text, next: p + len };
}

// Collect every STR#-like chunk from an IFF file. Returns array of
// { id, label, version, byLang: { 1: [...], 3: [...] } }.
export function collectStringSets(buf) {
  const out = [];
  for (const c of chunks(buf)) {
    if (c.kind !== "STR#" && c.kind !== "CTSS" && c.kind !== "CST\0" && c.kind !== "FAMs") continue;
    const parsed = parseStrChunk(c.data);
    const byLang = {};
    for (const e of parsed.entries) {
      if (!byLang[e.lang]) byLang[e.lang] = [];
      byLang[e.lang].push(e.text);
    }
    out.push({ id: c.id, label: c.label, kind: c.kind, version: parsed.version, byLang });
  }
  return out;
}
