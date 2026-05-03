# HIT — TS1 Audio Engine

The Sims 1 routes all gameplay-driven sound through a tiny stack-machine called
**HIT** (the in-engine name; Niotso also calls it the "audio engine bytecode").
Two paired files describe a soundscape:

- `*.HIT` — the bytecode (binary).
- `*.hot` — a plain-text INI describing how named events map to bytecode entry
  points + which audio patches each track needs. Acts as the symbol table.

The two big pairs the game ships are:

| HIT | HOT | Use |
|---|---|---|
| `simssound.HIT` (~9 KB) | `SimsSound.hot` | Object & UI sounds (alarm clock buzz, doorbell, fridge slam, build-mode jingles). 41 tracks, 62 events, 7 patches. |
| `SimsGeneratedHitSource.HIT` (~110 KB) | `SimsGeneratedHitSource.hot` | Sim voice barks. 649 tracks, 788 events, 2 328 patches. Every "Sul sul!", "fwoosh", complaint, etc. lives here. |

`crates/simantics::hot::HotFile` parses the .hot. `crates/simantics::hit_vm::HitVm`
runs the bytecode. The client wires both via `mountHitSandbox()` →
`runHitTrack` (WASM) → `decodeXa` → `AudioContext`.

---

## .hot — INI sections

Comments start with `;` or `#`. CSV fields support double-quoted strings (with
spaces, commas) and bare tokens.

### `[TrackData]`

Maps the 16-bit `track_id` to its byte offset inside the matching `.HIT`. The
HIT VM enters at this offset when a track is fired.

```
[TrackData]
1=0x10
2=0x40
3=0x68
```

### `[EventMapping]`

Maps an **event name** (string emitted by BHAVs and the client) to a track id +
an integer "duck level" (priority/ducking hint we don't model precisely yet).

```
[EventMapping]
phone_ringing,1,0
phone_busy,2,0
phone_pickup,"3",1
```

The C-string event name is exactly what `parseFwav` returns from a `.iff`'s
`FWAV` chunk (see SimAntics doc), and `BHAV` primitive #23 (Play Sound Event)
takes the FWAV chunk id as operand → the FWAV resolves to this event name →
this section resolves to a track → that track's bytecode plays patches.

### `[Patch]`

Lists the audio assets each track may load. Each row maps a `patch_id` (used by
the bytecode `playnote` opcode) to a `.xa` filename relative to the install's
audio root.

```
[Patch]
@PchPhoneRing,phone\ring.xa
@PchPhoneBusy,phone\busy.xa
3,phone\pickup.xa
```

`@Pch…` symbolic patch IDs are common in `SimsGeneratedHitSource.hot` and are
resolved by name. Numeric ids are also legal.

### `[Track]`

Optional metadata ribbon binding a `track_id` to a default patch hint:

```
[Track]
1,@PchPhoneRing,80
```

(loudness as 3rd column when present.)

### `[EventMappingEquate]`

Aliases. `event_name_a = event_name_b` means firing A is the same as firing B.

---

## .HIT bytecode

Variable-length, byte-addressed. The VM has:

- Program counter `pc`.
- 17 track-local vars (`var0..var16`) + a global pool addressed by var ids
  ≥ 0x40.
- A `current_hitlist` (which patch table to draw from for `smart_choose`).
- Zero / sign flags set by `cmp` and `test`.
- A loop point register (set by `set_loop`, jumped to by `loop`).
- A small call stack (entry from a `goto_subroutine`-shape opcode pushes a
  return PC, `return` pops).

### Opcode reference (subset actually observed in TS1 .HITs)

| Hex | Mnemonic | Operands | Semantic |
|---|---|---|---|
| `08` | return | – | Pop call-stack; if empty, end thread (yield `Return`). |
| `0B` | wait_samp | – | Yield until current sample finishes. |
| `0C` | end | – | Kill thread (yield `End`). |
| `0F` | nop | – | – |
| `20` | loop | – | `pc := loop_point`. |
| `21` | set_loop | – | `loop_point := pc + 1`. |
| `3A`–`3D` | test1..4 | – | Niotso "Unknown" — VM treats as nop. |
| `53` | duck | – | Lower other channels (yield `Duck`). |
| `54` | unduck | – | Restore (yield `Unduck`). |
| `02 v` | playnote | var | Play patch id var (yield `PlayNote`). |
| `03 v` | stopnote | var | Yield `StopNote`. |
| `09 v` | wait | var | Yield `Wait { ms }`. |
| `0E v` | test | var | Set zero/sign flags from var. |
| `27 v` | smart_choose | var | Pick patch from current hitlist via host; write to var. |
| `32 v` | playtrack | var | Yield `PlayTrack`. |
| `33 v` | killtrack | var | Yield `KillTrack`. |
| `44 v` | smart_setlist | var | `current_hitlist := var`. 0 = local. |
| `45 v` | seqgroup_kill | var | Yield. |
| `47 v` | seqgroup_return | var | Yield. |
| `5A v` | stoptrack | var | Yield `StopTrack`. |
| `60 v` | playnote_loop | var | Yield `PlayNoteLoop`. |
| `04 v i` | seti | var, u8 | `var := imm`. |
| `06 a b` | set | var, var | `a := b`. |
| `10 a b` | add | var, var | `a := a + b`. |
| `11 a b` | sub | var, var | `a := a − b`. |
| `12 a b` | div | var, var | `a := a / b` (zero if b == 0). |
| `13 a b` | mul | var, var | `a := a * b`. |
| `14 a b` | cmp | var, var | Flags as if `(a − b)`. |
| `4A`–`4B` | setlow_low / setlow_time | var, var | Yield. |
| `4D`–`52` | wait_var_eq/ne/gt/lt/ge/le | var, var | Yield with `WaitKind`. |
| `5F a b` | smart_index | var, var | Host-pick from hitlist by index. |
| `49 a b` | seqgroup_trkid | u8, u8 | Yield. |
| `18 d l h` | rand | var, var, var | `d := host.rand(l, h)`. |
| `48 d s f` | getsrcdatafield | var, var, var | Read object field through host. |
| `59 v s f` | setsrcdatafield | var, var, var | Write object field. |
| `55 …` | testx | 4 B | Niotso "Unknown" — VM treats as nop. |

5-byte `+ u32` and longer forms exist for jumps (conditional & unconditional).
`HitVm` fully dispatches them; see `crates/simantics/src/hit_vm.rs` for the
authoritative list including jump table layouts.

### Effects (vs. host)

The VM never produces audio itself. Instead each "play" / "wait" / "duck" op
yields a `HitEffect` (e.g. `PlayNote { note_id }`, `Wait { ms }`,
`PlayTrack { track_id }`). The host loop drives time:

1. Caller calls `HitVm::run_until_yield(host)`.
2. On `Yielded(HitEffect::Wait { ms })`, host sleeps `ms` (or schedules a
   resume).
3. On `Yielded(HitEffect::PlayNote { note_id })`, host loads the resolved
   `.xa` patch, decodes via `decodeXa`, and queues it through Web Audio.
4. Repeat until `Return` / `End`.

This makes the VM trivially testable (no sound device, no time) and lets the
client run multiple HIT threads cooperatively.

---

## End-to-end resolution chain

A BHAV emits `Play Sound Event` with operand `event_id`:

```
BHAV opcode 23, operand event_id=42
   ↓ FWAV chunk #42 in the same .iff
   ↓ event_name = "phone_ringing" (UTF-8 C-string)
   ↓ HOT [EventMapping] phone_ringing → track_id 1
   ↓ HOT [TrackData] track_id 1 → HIT byte offset 0x10
   ↓ HitVm.run from 0x10
       … bytecode references @PchPhoneRing
   ↓ HOT [Patch] @PchPhoneRing → "phone\ring.xa"
   ↓ decodeXa("phone\ring.xa") → PCM s16le 11025 Hz mono
   ↓ AudioContext.decodeAudioData → playback
```

The full chain is exercised by `mountHitSandbox()` (event picker + track
runner) and `runInteraction()` (auto-plays patches resolved during a trace).

---

## What we *don't* model (yet)

- **Real ducking** — `duck`/`unduck` yield effects but the host doesn't lower
  other AudioContext channels.
- **Sample timing precision** — `WaitSamp` returns control immediately; we
  don't track per-channel sample completion.
- **`testx`** and the four `test1..4` opcodes — Niotso has them as "Unknown";
  treat as nop. Doesn't seem to break any of the 19 sample SimsSound tracks
  we exercise.
- **Per-Sim voice variation** — `SimsGeneratedHitSource` selects voice
  patches based on Sim personality fields (read via `getsrcdatafield`); we
  return constants from the test host, so all Sims sound the same right now.

These are tracked in Phase 5 stretch / Phase 7 polish.
