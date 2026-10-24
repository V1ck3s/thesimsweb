# Porting guide: game UI classes → TypeScript

Goal: the browser client must look and behave exactly like The Sims. We get
there by porting the game's own UI code, class by class, from the decompiled
Mac build (named) cross-checked with the Windows build. **Nothing is invented**:
positions, sizes, resource ids, colors, fonts and behaviors come from the code.

## Where things are

| What | Where |
|---|---|
| Annotated pseudo-C, one file per class | `~/simsweb-build/decomp/mac-pseudoc-annotated/<Class>.c` |
| Recovered vtables (class, slot, method) | `~/simsweb-build/decomp/mac/vtables.tsv` |
| Mac symbols (address, kind, name) | `~/simsweb-build/decomp/mac/symbols.tsv` |
| Mac PPC asm with bytes (ground truth when Ghidra drops arguments) | `~/simsweb-build/decomp/sims1_mac_decomp/asm/code/*.s` |
| Windows pseudo-C (virtual methods named) | `~/simsweb-build/decomp/win-pseudoc/_global.c` |
| Windows named functions (address → name) | `~/simsweb-build/decomp/win/symbols.tsv` |
| UI resource tables | `/mnt/c/Program Files (x86)/Maxis/Les Sims/UIGraphics/Res_*.h|.RT` (also inside UIGraphics.far) |
| Game strings | `GameData/UIText.iff`, `Live.iff`, `Build.iff`, ... (STR# chunks) |

## Reading the pseudo-C

- `param_1` is `this`. Fields are word indexes: `param_1[0x1d]` = byte offset
  0x74. cTSWin layout: 0x74..0x80 = area (left, top, right, bottom) relative to
  the parent, 0x0c..0x18 = absolute area, 0x94 = flags.
- Virtual calls are annotated: `(**(code **)(*param_1 + 0x68))/*cTSWin::SetArea*/`.
  When the receiver's class is unknown the comment lists candidates
  (`/*cTSWin::X | cTSBuffer::Y | cTSFont::Z ?*/`); pick by the receiver's type.
  Objects returned by `nsSMResFac::LoadBuffer` are cTSBuffers (bitmaps);
  `cTSBuffer::SetTransparency` after loading = magenta color key (already done
  by `UIRes`).
- `nsSMResFac::LoadBuffer(0x7e7 /*kLevel1*/, ...)` loads a bitmap by resource id;
  use `ctx.res.image("kLevel1")` (or the number).
- `func_105885B0(size)` is `operator new`; the following constructor call
  creates a child window.
- Globals: `lbl_105Bxxxx` are TOC entries (pointers). Static initializers
  (`___sinit__<File>_cpp` in `_global.c`) set many of them (positions!). Read
  initialized data from `~/simsweb-build/decomp/mac/mac.bin` (base 0x10000000,
  big-endian). Values living in BSS (> 0x106353E0) are set at runtime: grep for
  the label to find the writer.
- When Ghidra drops arguments (e.g. a 5th SetArea argument), read the asm in
  `asm/code/*.s` (r3 = this, r4..r10 = args).
- Cross-check numbers with the Windows build when they look odd. Find the PC
  function via `win/symbols.tsv` (virtual methods) or via string/immediate
  references.

## The TypeScript side

`client/src/game/`:

| File | Original |
|---|---|
| `ui/tswin.ts` | cTSWin (area, flags, children, plot, hit testing, TSOn* handlers) |
| `ui/winmgr.ts` | cTSWinMgrW95 (input routing, capture, hover, paint loop); `winMgr` singleton |
| `ui/btn.ts` | cTSWinBtn (frame columns, push/toggle modes, commands) |
| `res/uires.ts` | nsSMResFac + Res_*.RT tables (`ctx.res.image(id)`) |
| `res/ffn.ts`, `res/fonts.ts` | cTSFont / cTSFontSys (`await ctx.fonts.acquire(size, style)`) |
| `res/strings.ts` | StringSet (`ctx.strings.get("UIText", id, index)`) |
| `cpstate.ts` | CPState (mode, speed, zoom, level, walls, funds, family...) |
| `cpanel/cpanel.ts` | cWinCPanel (container, geometry, panel switching) |
| `cpanel/*.ts` | one module per subpanel class |
| `context.ts` | `GameContext` handed to every window |

Rules:

1. One TS class per game class, same name minus the `c` (`cWinMotive` →
   `WinMotive`), methods named after the original in camelCase
   (`TSOnMouseDownL` → `tsOnMouseDownL`, `UpdateViewFromCPState` →
   `updateViewFromCPState`).
2. Windows take `ctx: GameContext` in the constructor; `init()` is async: load
   bitmaps and fonts there (painting is synchronous and uses what init cached),
   create children, set areas exactly as the original does.
3. Paint in `tsPaint(g)` with `g.blit`, `g.blitPart`, `g.fill`, `font.drawText(g.ctx, text, g.ox + x, g.oy + y, color)`.
   Colors come from the code (RGB triplets passed to MakeFillColor/SetFontColor...).
4. Buttons: `new TSWinBtn(id, image, cols, rows)`; react in `tsOnCommand(id, src)`
   of the parent or via `btn.onClick`.
5. Strings: never hardcode UI text. Find the STR# id/index the original uses
   (`StringSetBase::GetString(..., index)` after a `Load(...)` naming the chunk)
   and read it from `ctx.strings`. Load extra IFFs in your init if needed.
6. Shared files (`tswin.ts`, `btn.ts`, `cpstate.ts`, `context.ts`, `winmgr.ts`)
   are used by everyone: you may **add** methods/fields, never change or remove
   existing signatures. Keep such edits small.
7. Data the panel shows (sims, motives, jobs, objects...) comes through
   `CPState`. If something is missing, add a field/method to CPState with a
   neutral default and a comment; the simulation will fill it later.
8. Sounds (`PlayUISound`, `cSoundPlayer`) are out of scope for now: leave a
   one-line `// sound: <event>` comment where the original plays one.
9. Match the surrounding code style; comments in English; no dead code.

## Testing

- Dev server: `http://localhost:5173/game.html` (full game shell) and
  `http://localhost:5173/game.html?test=<name>` for a test page you add as
  `client/src/game/dev/tests/<name>.ts` exporting
  `export async function mount(ctx: GameContext, mgr: WinMgr): Promise<void>`.
- Screenshots: `node tools/interact.mjs <url> <out-dir>/<prefix> wait:8000 shot:a click:100,700 wait:300 shot:b`
  (coordinates in game pixels, 1024x768), then look at the PNGs.
- Typecheck: `cd client && npx tsc -p . --noEmit`.
- Vite watches /mnt/c with polling; if a change does not show up, check that
  `curl localhost:5173/src/game/<file>.ts` serves the new code.
