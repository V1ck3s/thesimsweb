# Sound system port (cSoundPlayer / cBoxX / cHitMan)

Status: working in the dev test page (`game.html?test=audio`). It is not wired
into the game shell yet (see "Wiring" below).

## Files (`client/src/game/audio/`)

| File | Original |
|---|---|
| `soundplayer.ts` | cSoundPlayer (`soundPlayer` singleton): PlayBySource, QuietBySourceID, QuietAll, Pause/ResumeSounds, Enable*, Set*Volume; cSimsApp::Start/StopLoadMusic |
| `boxx.ts` | cBoxX (Init, LoadDataDirectory, MappedEvent, Event switch, KillSource), cBoxxReceiver (music folders → hitlists), cGameModeManager::SetMode |
| `hitman.ts` | cHitMan (sound objects, labels, global registers, control groups, duck map, seq groups, TimerCallback), cHitList (Choose), cHitControlGroup |
| `trackplayer.ts` | cTrackPlayer (DoCommand = the HIT VM, PlayPause, Stop, Kill, SetLocalRegister, UpdateVolPan, HandleTimerCallback, SetPatch, ChainPatch), cTrack |
| `samplepatch.ts` | cSoundObject, cSamplePatch, cSampleChannel (Web Audio nodes) |
| `hitdata.ts` | .hot (cHitIniFile), .hsm (LoadSymbolFile), .hit parsing |
| `registers.ts` | HIT register names (SimsSound.hsm) and the default register tables of cHitMan::Init |
| `audiosys.ts` | AudioContext + unlock on first gesture, cTSSnd::SetVolume dB curve, file access (FAR or loose), XA/WAV/MP3 decoding |
| `uisound.ts` | UI event names used by the UI code, music mode events, `speedTransitionSound` |
| `index.ts` | re-exports |

`ui/btn.ts` got an additive hook: cTSWinBtn::PlayUISound / OverrideUISound /
OverrideDefaultUISound (`TSWinBtn.uiSoundHook`, `btn.overrideUISound`,
`TSWinBtn.overrideDefaultUISound`, `btn.uiSoundActions`). Buttons stay silent
until `soundPlayer.initialize()` installs the hook.

## How it works (from the Mac build)

- Data: every data directory (`SoundData\`, `ExpansionPack\`, `ExpansionShared\Sound\`,
  `ExpansionPackN\Sound\`) has `.hit` (bytecode), `.hsm` (symbols), `.hot` (INI:
  TrackData labels, Patch, Track, GlobalHitList, EventMapping). 11 .hit files,
  4204 tracks, 17224 patches, 4382 event names load in the Complete Collection.
- `PlayBySource(name, source)` → cBoxX::MappedEvent: the .hot `[EventMapping]`
  entry `name=kind,arg,...` → cBoxX::Event(kind, arg, source). kSndobPlay (1)
  plays track `arg`; kSetMusicMode (36) goes to cGameModeManager.
- A track (cTrack, which *is* a cTrackPlayer: one instance per track) runs its
  HIT code from its `[TrackData]` label. Jump/call/if operands are label ids,
  not addresses. Opcodes 0x00..0x53 (jump table 0x10618514); 0x53 is
  chain_patch; 0x2d caps at a maximum (min), 0x2e at a minimum (max).
- Clock: cBoxX::Update every 20 ms (cTSCallbackTimer started with 0x14);
  HIT `wait` counts ticks (e.g. `wait 50` = 1 s between songs).
- Every register write sets the flags. Register 0x35 (`target`) redirects
  reads/writes to another track (FadeAndKillTrack*, SetMainMusicSongAndHitList).
- Volume: UpdateVolPan = extvol(0x13) × group volume × vol(0x12) / 1024², halved
  when ducked; cTSSnd::SetVolume maps 0..1024 linearly in dB from −40 dB to 0 dB.
  Options volumes 0..10 → table `[0,300,390,490,590,690,790,840,895,960,1024]`
  → control groups 1 sfx, 2 music, 3 vox.
- Music: cBoxX::Init makes a receiver per music folder (`Music\Modes\Buy` →
  hitlist 0xdd, `Build` → 0xde, `Nhood` (NhoodUS on the US build) → 0xdf,
  stations 0xe8.., TV stations 0x210..). cGameModeManager::SetMode plays the
  HIT tracks 516/517 (SetMainMusicSongAndHitList / ...KillFirst) which set the
  globals main_musichitlistid/main_songnum and start MainMusicLoop (515):
  pick a folder, then a song (cHitList::Choose: random, no repeat), play, wait
  for the end, wait 1 s, loop. Live mode fades it out (519, FadeAndKillTrackSlow).
  Hood also starts the river ambience (track 2957). Mode changes are ignored
  until the neighborhood (mode 3) was entered once (lbl_105C1C80).
- Mode music is sent by CPState::UpdateWorldFromCPState when the mode changes:
  `QuietBySourceID(-1)` then `PlayBySource(<event>, -1)` with Build →
  `bkground_build`, Buy → `bkground_buy1`, Live → `bkground_live`,
  Options → `bkground_option`, Camera → `bkground_camera` (community lots in
  Buy/Build pick `station_*` / `music_magictown*` by house number).
- Radio stations: object events `stereo_rock` etc. (kTurnOnTv) play the station
  tracks (260/270/269/280) which choose songs from the station hitlists; a new
  station on the same object kills the previous one (KillSource).
- Buttons (cTSWinBtn::PlayUISound): action 1 = press (default `UI_click`),
  8 = press while disabled (`UI_error`), 4 = mouse enter, 2 = release after the
  command; the mask (+0x148) defaults to 1|8. PlaySoundA = PlayBySource(name, -4).
- Browser: the AudioContext is created on demand and resumed on the first
  pointerdown/keydown (capture phase). Channels started before that wait and
  start on the unlock, so mode music requested at boot starts on the first click.

## Verified (headless Chrome, `audioTest` in the test page)

- 51 `ui_*` events; 41 distinct UI samples decoded (XA → WASM → WAV →
  decodeAudioData): no NaN, durations 0.022 s (ui_click) .. 3.8 s, peaks 0.17–1.1.
  `ui_remove` points at `UI_remove.xa`, absent from SoundData.far (game data);
  `ui_terrain_raise/lower` use a hitlist track (no default patch).
- Expansion samples: FAR entries of ExpansionPack, ExpansionShared, EP5–7 decode.
  EP6/EP7 (and 5 base files) are tagged `XA\x12\0`; decoded as `XA\0\0`, the
  duration matches the header size exactly (e.g. smoothie_brain3 2.127 s);
  needs an ear check.
- Music: buy1.mp3 164 s, latin2.mp3 389 s, loadloop.wav 38 s, sting_baby.wav 7.6 s.
- Flows: mode 3 → river_loop.xa + MainMusicLoop playing `Music\Modes\Nhood\latin*.mp3`;
  mode 0 → 515 faded and killed in ~7 s; stereo_rock then stereo_jazz on the same
  source → rock killed, Latin station playing; tv_action plays a TV_Action clip;
  hovering/clicking a TSWinBtn plays its enter/press sounds.

## Wiring left to do (coordinator)

1. Boot (`main.ts`): `soundPlayer.initialize(getOptionsMgr())` once (before the
   splash), `void soundPlayer.startLoadMusic(getOptionsMgr())` while the splash
   shows and `soundPlayer.stopLoadMusic()` when it closes.
2. CPState mode changes (cpstate.ts, UpdateWorldFromCPState): see "Mode music"
   above (`soundPlayer.quietBySourceID(-1); soundPlayer.playBySource("bkground_buy1", -1)` ...).
   CPState::SetCPMode(0) (panel opening) and SetMode(Camera) with the panel
   open play `UI_whoosh`.
3. `// sound:` sites:

| Site | Call |
|---|---|
| `cpanel/people.ts:559` house button refused | `soundPlayer.playUISound(UI.error)` (verify in cWinLivePanel) |
| `cpanel/viewcontrol.ts:548` speed click | `soundPlayer.playUISound(speedTransitionSound(paused ? 0 : oldSpeed, newSpeed))` |
| `cpanel/viewcontrol.ts:613` pause toggle | `soundPlayer.playUISound(speedTransitionSound(from, to))` with 0 = paused |
| `cpanel/options.ts:829` | `soundPlayer.playUISound(UI.error)` |
| `cpanel/livepopup.ts:227`, `:240` | `soundPlayer.playUISound(UI.whoosh)` |
| `cpanel/buy/catalogpopup.ts:148` | `soundPlayer.playUISound(UI.whoosh)` |
| `cpanel/catalog.ts:400` cTool::DoDeniedSound | `soundPlayer.playUISound(UI.error)` |
| `nbhd/winneighborhoodul.ts:221` | `btn.overrideUISound(null, UI.nhoodClick)` (cWinNeighborhoodUL::Init; Init also calls `TSWinBtn.overrideDefaultUISound(null, UI.nhoodClick)` and the screen's close restores it with `TSWinBtn.overrideDefaultUISound()`) |
| `nbhd/winneighborhoodul.ts:238` | `soundPlayer.playBySource(MUSIC.hood, -1)` |
| `nbhd/winneighborhoodul.ts:346`, `:366` | `soundPlayer.playBySource(MUSIC.fade, -1)` |
| `ui/piemenu.ts:328` popup | `soundPlayer.playUISound(UI.pieAppear)` |
| `ui/piemenu.ts:449` rollover | `soundPlayer.playUISound(UI.pieHighlight)` |
| `ui/piemenu.ts:480` select | `soundPlayer.playUISound(UI.pieSelect)` |
| `world/winlotview.ts:283` tools | cTool: DoSlideSound `UI.objectRotate`, DoExplodeSound `UI.archtoolDelete`, DoRefundSound `UI.moneyback`, DoKachingSound `UI.buyMoneyback`, DoDeniedSound `UI.error` (each throttled: not within 400 ms of its previous one); placing: `UI.objectPlace` / `UI.buyPlace` / `UI.objectMovePlace` |

Button overrides found in the code (OverrideUISound(enter, down, up, disabled)):
cWinLotBtn::Init (house buttons) `UI_Nhood_rollover / UI_Nhood_click`, mask 5
(enter + press) or 1; cWinDesignCharacter::Init `UI_CAC_CycleParts`,
`UI_CAC_Cyclehead` (press); neighborhood screens (UL, VC, Downtown, Magicland,
Studiotown, Vacation) Init + BuildFilterToolbar `UI_Nhood_click` (press);
cWinArch and cWinCatalog set the mask to 0 (silent buttons).

## Gaps

- Positional sound: GetSndobVolPan (object position → vol/pan) and 3D patches
  are not done; object sounds play at full volume, centred.
- cBoxX::UpdateAmbienceLoop / cFreshPlayer (outdoor ambience `.fsc` scores in
  live mode) not ported.
- Gender/vox selection in MappedEvent (`…m/…f/…k` by sim gender, `vox` lookups
  via cAudioInfo::GetObjectData) falls back to the first existing variant.
- `getsrcdatafield` needs `hm.sourceDataHandler` (object data); without it the
  instruction logs an error and continues.
- A stopping (fading) track no longer executes commands; the original keeps
  stepping (it would run past `end`).
- MP3 songs stream through `<audio>` + MediaElementSource; Pause/Unpause of
  sample (non-MP3) channels mutes them instead of resuming at the same offset.
- CheckPriority (voice limits per SPL), cHitTimer drift, the debug events and
  kSndobUpdate / SetPosition are not implemented.
- Expansion flags (+0x66) are assumed all set; neighborhood music uses
  `Music\Modes\Nhood` (French build) unless `initialize(options, true)`.
