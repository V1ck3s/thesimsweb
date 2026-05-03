# SimAntics VM trace — diff format

> Used by `scripts/diff/vm.sh` to compare our VM's trace against any oracle
> (FreeSO/Simitone, an instrumented hexdump of TS1 under Wine, or any other
> implementation that adopts the same schema).

The trace is a **JSONL** stream (one JSON object per line) emitted to
stdout by `cargo run -p simantics --example trace_json`. The schema is
deliberately minimal so adapter shims can produce equivalent output without
needing to mirror our `VmEffect` enum exactly.

## Step record

```json
{
  "kind": "step",
  "depth": 0,
  "bhavId": 4106,
  "ip": 0,
  "opcode": 2,
  "branch": "continue:7"
}
```

| Field    | Type            | Meaning                                                       |
|----------|-----------------|---------------------------------------------------------------|
| `kind`   | `"step"`        | Discriminator.                                                |
| `depth`  | u32             | Call stack depth at the time the instruction ran.             |
| `bhavId` | u16             | Chunk ID of the BHAV currently executing.                     |
| `ip`     | u16             | 0-based instruction index inside that BHAV.                   |
| `opcode` | u16             | The `Instruction.opcode` of the executed step.                |
| `branch` | string          | One of: `"continue:<next-ip>"`, `"returned_true"`, `"returned_false"`, `"error"`. |

## Outcome record

Always the **last** line:

```json
{
  "kind": "outcome",
  "outcome": "ran_true",
  "steps": 12,
  "effects": { "Sleep": 1, "AnimateSim": 2 }
}
```

| Field      | Type     | Meaning                                                     |
|------------|----------|-------------------------------------------------------------|
| `kind`     | `"outcome"` | Discriminator.                                           |
| `outcome`  | string   | `"idle"`, `"skipped"`, `"ran_true"`, `"ran_false"`, `"ran_error"`, `"budget_exhausted"`, or `"vm_error"`. |
| `steps`    | u32      | Total number of step records emitted before this line.      |
| `effects`  | `Record<EffectKind, count>` | Histogram of `VmEffect` variant names. |
| `error`    | string   | Present only when `outcome === "vm_error"`.                 |

## Diff strategy

`scripts/diff/vm.sh` does a plain `diff -u` between our trace and the
oracle's. For sound differential testing we want:

1. **Bit-exact alignment**: same `(depth, bhavId, ip, opcode, branch)`
   tuples in the same order.
2. **Same effect histogram**: name + count match. Effect ordering is *not*
   compared — many engines emit them in a slightly different rhythm.

If the oracle uses a different effect naming, write a small adapter that
remaps its keys to the names listed in [`vm.rs`](../../crates/simantics/src/vm.rs).

## Running it

Once an oracle trace is available at e.g. `oracle/AlarmClock-event1.jsonl`:

```bash
just diff-vm  # convenience recipe (TODO)
# or
./scripts/diff/vm.sh \
  --object samples/iff/AlarmClock.iff \
  --event 1 \
  --globals-far "/mnt/c/Program Files (x86)/Maxis/Les Sims/GameData/Global/Global.far" \
  --oracle oracle/AlarmClock-event1.jsonl
```

## Status

Two layers of testing:

### Self-regression (active)

`crates/simantics/tests/trace_golden.rs` runs `trace_json` on
`AlarmClock.iff` and `unsnacker.iff` event 1 and compares against frozen
goldens in `tests/golden/vm/`. Catches accidental changes to the JSONL
schema or the VM's deterministic step ordering. Run via:

```bash
cargo test --release -p simantics --test trace_golden
```

To regenerate goldens after an intentional VM behaviour change:

```bash
cargo run --release -p simantics --example trace_json -- \
  samples/iff/AlarmClock.iff --event 1 \
  > tests/golden/vm/alarmclock_event1.jsonl
cargo run --release -p simantics --example trace_json -- \
  samples/iff/unsnacker.iff --event 1 \
  > tests/golden/vm/unsnacker_event1.jsonl
```

### FreeSO oracle (deferred — toolchain blocker)

We do **not** ship a FreeSO-side oracle. The blocker is genuinely
non-trivial:

- FreeSO targets .NET Framework 4.5 with MonoGame XNA — the VM source
  (`TSOClient/tso.simantics/VM.cs`) imports `Microsoft.Xna.Framework`,
  `FSO.LotView.Components`, `FSO.SimAntics.NetPlay.Drivers`, etc. (30+
  namespaces).
- Migrating the project to .NET 9 (which we have locally) means resolving
  XNA → MonoGame.Framework + extracting just the VM core out of the
  netplay/drivers/marshals tangle. Multi-day yak-shave.
- Once isolated, patch `VMSimanticsThread::Run` to emit the JSONL schema
  above (~30 lines of C# wrapping the `bhav.Instructions[ip]` access).

The contract is locked: any oracle that emits this schema can be plugged
into `scripts/diff/vm.sh` to validate our VM byte-for-byte against
FreeSO/Simitone. Until then, the self-regression goldens guard against
accidental drift.
