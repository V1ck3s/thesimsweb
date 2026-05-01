# SimAntics — Behavior bytecode (BHAV) + Constants (BCON)

> Sources:
> - Niotso wiki, [`SimAntics`](http://wiki.niotso.org/SimAntics) page §Disassembly. Local snapshot in [`_niotso/SimAntics.md`](./_niotso/SimAntics.md).
> - Niotso wiki, [`IFF`](http://wiki.niotso.org/IFF) page §BCON / §BHAV / §TRCN.
> - Empirical hexdump of two BHAV chunks in `samples/iff/unsnacker.iff` (both magic `0x8002`, 8 instructions, 12-byte header + 96 bytes of instruction data = 108 B → matches IFF chunk size 184 − 76 header).
>
> Designed by **Jamie Doornbos** with **Patrick J. Barrett III** and **Don Hopkins**. SimAntics is the bytecode VM that drives every gameplay object in The Sims.
> Bytecode and chunks are **little-endian** throughout.

## BHAV — Behavior chunk

A BHAV is a subroutine of SimAntics bytecode. Stored as the data payload of an IFF `BHAV` chunk (76-byte chunk header preceding it).

### Header

The first 2 bytes are a magic that determines the rest of the header layout. Total header size depends on the magic; instructions always follow.

| Magic    | Layout (after the magic u16)                                                  | Header bytes total |
|----------|-------------------------------------------------------------------------------|--------------------|
| `0x8000` | `count: u16`                                                                  | 4                  |
| `0x8001` | `count: u16`                                                                  | 4 (+ flags after instructions, per FreeSO) |
| `0x8002` | `count: u16`, `type: u8`, `args: u8`, `locals: u8`, `flags: u8`, `extra: u32` | 12                 |
| `0x8003` | `type: u8`, `args: u8`, `locals: u8`, `unknown: u8`, `flags: u8`, `count: u16`, padding | 10–12 (TBD when seen) |

Field meanings (Niotso):

- **count**: total number of instructions in this behavior.
- **type**: usually `0`, occasionally `1`, `2`, `3`, or `22`. Purpose not fully nailed down.
- **args**: number of constant arguments the call instruction passes through (max 4); larger argument lists go through temps.
- **locals**: number of subroutine-local variables, lifetime = object lifetime.
- **flags**: subroutine attribute bits.
- **extra** (`0x8002`): observed values include `0`, `2`, `3` in this install — likely a flags2 or version-derived field. We persist it but don't interpret.

For the install we have, **all observed BHAVs are `0x8002`** (verified on `unsnacker.iff`). We support `0x8000`/`0x8001` defensively for completeness; we'll grow `0x8003` support when we encounter a sample.

### Instruction (12 bytes)

| Offset | Size | Field        | Notes |
|--------|------|--------------|-------|
| 0      | 2    | `opcode`     | u16 LE. `< 256` = primitive, `< 4096` = semi-global subroutine, `< 8192` = private subroutine, `≥ 8192` = global subroutine (Niotso §Primitives). |
| 2      | 1    | `t_dest`     | Branch index when result is **true** |
| 3      | 1    | `f_dest`     | Branch index when result is **false** |
| 4      | 8    | `operand`    | Opaque to the parser; interpreted per primitive |

`t_dest` / `f_dest` semantics:
- `< count`: jump to that 0-based instruction index.
- `255` (= `0xFF`): return **true** from the subroutine.
- `254` (= `0xFE`): return **false** from the subroutine.
- `253` (= `0xFD`): return **error**, kill the calling object.

### Worked example — BHAV @ `0x6c3` of `unsnacker.iff`

```
000006C3  42 48 41 56                          chunk type "BHAV"
000006C7  00 00 00 B8                          chunk size = 184 (BE)
000006CB  10 0A                                chunk id = 4106
000006CD  00 10                                chunk flags = 0x0010
…64-byte label, all zero…
0000070F  02 80                                magic = 0x8002
00000711  08 00                                count = 8 instructions
00000713  00                                   type = 0
00000714  00                                   args = 0
00000715  00                                   locals = 0
00000716  00                                   flags = 0
00000717  03 00 00 00                          extra = 3
0000071B  02 00 07 FD 00 00 00 00 00 05 0A 07  instr[0] opcode=2 t=7 f=253 (return error) — primitive 2 = "Expression"
…7 more instructions…
```

Chunk-data length = 184 − 76 = 108. Header (12) + 8·12 = 108 ✓.

## BCON — Constants chunk

A small block of u16 constants referenced by BHAV instructions via the "literal" scope or the BCON access scope. Stored as the data payload of an IFF `BCON` chunk.

| Offset | Size | Field      | Notes |
|--------|------|------------|-------|
| 0      | 1    | `count`    | u8 number of constants |
| 1      | 1    | `flags`    | u8 typically `0x00` or `0x80`; meaning unknown |
| 2      | 2·n  | `entries`  | `count` u16 LE constants, accessed by 0-based index |

Total payload bytes = `2 + 2·count`. Labels for these constants live in a `TRCN` chunk with the same `id`.

## TRCN — Constant labels (planned, not yet parsed)

Pairs each BCON constant with a human-readable name. We'll add a parser when we need it for the VM debugger.

## Relationship between chunks

```
BHAV (id = N) --references--> primitives (opcode < 256)
                              subroutines (opcode ≥ 256)
                              constants  (via Expression operands → BCON id = M)
BCON (id = M) <--labels-----> TRCN (id = M)
```

## Edge cases observed

- All BHAV magics in `unsnacker.iff` are `0x8002`. The `extra` u32 field at offset 8 is sometimes non-zero (`3`, `2`) — we expose it raw.
- `f_dest = 0xFD` (return error) appears in real code as a safety branch.
- Operand bytes are *not* guaranteed to be zero where unused — they hold per-primitive packed data. Always read the full 8 bytes.

## Differential test references

- **Edith** (Maxis's editor) is the canonical disassembler. Closed-source. Niotso documents the disassembly format that Edith emits.
- **Simitone** / **FreeSO** open-source VMs are reference implementations — read-only inspiration, not code to copy.
- **Self-consistency tests**: every `t_dest`/`f_dest` < `count` must be a valid instruction index. Our parser flags out-of-range branches that aren't in `{0xFD, 0xFE, 0xFF}`.

## Open questions

- Exact layout of `0x8003` headers — none in this install.
- The `type` field's full semantics (`0`/`1`/`2`/`3`/`22`).
- How `flags` interacts with the SimAntics scheduler.
