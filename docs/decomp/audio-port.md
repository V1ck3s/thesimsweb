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
  Pan: cTSSnd::SetPan maps 0..1024 to a DirectSound pan −10000..10000 (1/100 dB
  of attenuation on the far side, none at the centre): `DSPanner` in
  samplepatch.ts (not a StereoPannerNode, which is equal-power).
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
  EP6/EP7 (and 5 base files) are tagged `XA\x12\0`: same layout (cWaveXA::Init
  only checks "XA" and wFormatTag 1).
- XA decoder (2026-10-31, U21): high nibble first, rounding `+0x80`, channel
  count at 0x0a (WAVEFORMATEX), stereo rows interleaved by byte, output
  trimmed to the declared size, as cWaveXA (Windows FUN_005fc013). Identical
  to `ffmpeg -f xa` (adpcm_ea_maxis_xa) on 91 random files of every FAR. The
  earlier decoder swapped every sample pair (harsh noise on all XA sounds).
- Pitch / frequency (2026-10-31, U29): cSampleChannel::SetPitch is an absolute
  frequency, `22050 * 1.0594631^((p - 3600) / 100)` Hz, through cTSSnd::SetFrequency,
  which is a no-op until the sound's DirectSound buffer exists (cTSSnd::Load on the
  first Play after cSamplePatch::AddRef / CreateSnd, or a Preload patch) and for MP3s.
  note / note_on re-apply vol/pan/pitch after NoteOn only for streamed patches (reg
  0x26). Port: `SamplePatch.addRef/release` (from TrackPlayer.setPatch), `sndLoaded`,
  `sndFrequency`; rate = frequency / the file's own rate (`fileSampleRate`, audiosys.ts;
  the AudioBuffer itself is at the context rate). The TV station tracks set pitch 2400
  (11025 Hz): the port's old relative rate halved their 11025 Hz clips. FreshSnd
  Get/SetFrequency also use the file rate now (was the 44100 Hz context rate).
- Shipped formats: XA 22050 mono / stereo, XA 11025 mono (TV stations only), WAV PCM16
  22050 mono / stereo, MP3 44100 stereo; one of each decoded in the browser matches
  ffmpeg (rate, channels, duration, waveform).
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
Studiotown, Vacation) Init + BuildFilterToolbar `UI_Nhood_click` (press).
cWinArch and cWinCatalog keep the default button mask (press `UI_click`, disabled `UI_error`):
the `param_1[0x52] = 0` once read as a mask is a field of the panel, not of a button.

## Lot ambience and positional sound (cBoxX::Event 52, cFreshPlayer, cAudioInfo)

Files: `audio/audioinfo.ts` (cAudioInfo interface + `setAudioInfo`), `audio/fresh.ts`
(cFreshPlayer / cFreshScore / cFreshCellPlayer / cFreshTimer, `.fsc` v7 grid scores,
rand_override MSVC LCG, prob and semitone tables), `audio/lotaudio.ts` (the lot-side
cAudioInfo + VM sound hooks), `audio/boxx.ts` (event switch rewritten after the jump
table lbl_106172A0).

- cBoxX::Init loads the 4 fresh players (sim_amb, beach, hotdatepark_amb, magic_amb)
  and sets `hm.sourceDataHandler` (BoxxGlobalGetSourceParamValue: field > 0x15 → 0,
  else cAudioInfo::GetObjectData).
- Event 52 kSetAmbienceMode / 36 kSetMusicMode / 33 kNotifyChange
  (OutdoorTileRatio → SetYPos(ratio * 10 / 100 scale), hour table → SetXPos) /
  25 kActivateApp / 21-22 kPause-kUnpause, as in the original. UpdateAmbienceLoop:
  BeachLoop 0x10aa3 on beach lots, nite_loop 0xba9 at night on lots outside 0x14..0x1d,
  fade to VOLUME_TABLE[fx] at speed 5000.
- Positional: instance multimap (sound object id → sources), GetInstanceVolPan
  (screen position, zoom and level attenuation), GetSndobVolPan (max volume,
  volume-weighted pan), UpdateSndobVolPan on every NotifyViewChange and periodically.
  KillSource stops (fades) tracks left without instances.
- VM hooks (additive, VM agent's files): `SimModule.soundHooks`
  (`playSound(behavior, soundId, source)` / `killSounds(source)`) called from
  `xobject.ts` primitives 23 (cXObject::TryPlaySound: FWAV string from the private
  then the global file; source = stack object when operand byte 4 != 0xff && &2) and
  48 (TryKillSounds). `installLotAudio` (main.ts enterLot) installs them.
- main.ts onChange (CPState::UpdateWorldFromCPState): Pause/ResumeSounds on mode
  change and live pause, then NotifyViewChange, then the mode music.

Verified (headless Chrome, full game.html flow then `game.enterLot(1)`; `window.soundPlayer`
dev handle, `boxx.ambienceState()`): hood backyard player + river loop + music; lot 1
ratio 77 → Y 19, hour 5 → X 1, nite_loop fades in, stops at 6 h with X → 2, cells
reach playing; buy mode stops the player (buy music), back to live restarts it;
pause toggles; radio vol 923 pan 546; stereo_rock on a sim 1024 at zoom 3, 800
(kSplStereo floor) at zoom 2/1; beach lot player 1 + BeachLoop; magictown player 3.
BeachLoop plays with pan register 0: cTrackPlayer::PlayPause with kArgsIdVolPan sets
reg 0x13 = a2, 0x14 = a3, and UpdateAmbienceLoop passes (0, 0, 0) — same as original.

## Mode music, towns (U7 / U8, 2026-10-29)

- cGameModeManager::SetMode ported for every mode from the Windows build
  (FUN_005752c4; the Mac 0x102d8fb0 differs only in the credits hitlist):
  0/4/9 kill MainMusicLoop at once when coming from Buy / Build / MM Buy /
  MM Build, else FadeAndKillTrackSlow; 1/2 SetMainMusicSongAndHitList 0xdd /
  0xde (the playing song goes on); 3 hood (+ river 2957; Grimreaper_loop
  killed); 6 credits by expansion flags (Makin' Magic first: 0x192bd);
  8 family; 10..16 kill 519 then SetMainAndHitListKillFirst (dt_nhood 0x17d4,
  Vacation 0x370d, UnlSpeak 0x51a6, Modes\Superstar 0x18706, Stations\Superstar
  0x18705, MakinMagic 0x192bc + mt_river_loop 0x1bec2, MM_Credits 0x192bd);
  17/18 MM_Build 0x192be / MM_Buy 0x192c0, skipped between each other.
- The mode event (`modeMusicEvent`, uisound.ts) follows CPState::UpdateWorldFromCPState:
  Live `bkground_live`; Buy on a visited lot (global 0x20): 40..49
  `station_vacation`, community `station_unleashed`, 81..89 `station_superstar`,
  93..98 `music_magictown`, else `station_dtbuy`; Buy at home: 90..92
  `music_magictown_buy`, else `bkground_buy1`; Build: nothing on a visited lot,
  90..92 `music_magictown_build`, else `bkground_build`; Camera
  `bkground_camera` (= build music); Options `bkground_option` (no change).
- Buy -> Build keeps the current song in the original too (see U8 in playtest.md).
- PauseSounds runs on every CPState switch to a mode other than Live. The Windows
  cBoxX::Pause (FUN_00574972) leaves MainMusicLoop (0x203) playing, with the UI
  tracks; the Mac one pauses it, and so did the port: Options (mode 7, no music
  change) left the song paused (U28).
- Back to Live (re-checked 2026-10-31 in Sims.exe, disassembly + vtables): the
  cut without fade is the **Windows** behaviour, and the Mac one too (same code).
  - `bkground_live` / `_buy1` / `_build` / `_camera` / `_option(s)` are plain
    `kSetMusicMode,N` events in SimsSound.hot (0 / 1 / 2 / 2 / 7): no HIT script
    runs on them. Camera is mode 2, like Build; community-lot Buy is 10..15
    (`station_*`, `music_magictown`), Magic Town Build / Buy 17 / 18.
  - Windows cGameModeManager::SetMode FUN_005752c4, jump table 0x575799, case
    0/4/9 at 0x575365: previous mode 1, 2, 0x11 or 0x12 → track 0x203
    (MainMusicLoop) `call [edx+0x38]`; any other previous mode (Options 7, hood
    3, community lots 10..16) → track 0x207 (519 FadeAndKillTrackSlow)
    `Play(0x203)` (+0x2c). Mac 0x102D916C (asm/code/Boxx.s): the same test
    (`r29-1 <= 1 || 0x11 || 0x12`), Kill at PPC vtable +0x40.
  - cTrackPlayer vtables 0x671a74 / 0x6719b4: +0x2c Play 0x57df06, +0x34 Stop
    0x57df9c (the only fading stop: fade_dest 0, fade_var 0x13, speed 100),
    +0x38 **Kill 0x57e037**. Kill clears the playing flag, calls the channel's
    NoteOff (cSampleChannel vtable 0x671c84 +0x98 = 0x5804ba), which calls the
    sound's Stop (cITSSnd +0x28: cTSSndDShow::Stop 0x5fc956 for the MP3s,
    cTSSnd::Stop 0x5f9798 for waves): both stop at once, no FadeVolume. Kill
    runs no track code, so no HIT fade either.
  - The only Mac / Windows difference in these transitions is cBoxX::Pause
    (Windows FUN_00574972 exempts 0x203; Mac 0x102dc0d0 does not).
  - Port (unchanged, already this): headless Chrome, track 515 channel gain
    after `bkground_live`: from Buy or Camera inactive at +1 ms (cut); from
    Buy → Options 0.56 → 0.47 (+0.3 s) → 0.26 (+1.3 s) → 0.08 (+3.3 s) →
    0.025 (+5.3 s), killed by 519.
- Object deletion and cXObject::Cleanup quiet the object's sounds
  (cSoundPlayer::QuietBySourceID from ~cXObject / Cleanup): `SimModule.killObject`
  and `XObject.cleanup` call `soundHooks.killSounds(id)` (U23: the mail carrier's
  looping mailbox_deliver_vox).
- cBoxX's timer catches up missed 20 ms ticks (at most 1 s per callback): the
  original cTSCallbackTimer runs on its own thread.
- Camera: `ui_camera_photo` on each snapshot (HouseViewer::TakeAsyncSnapshot, Windows).

## Gaps

- The view and the clock are polled every 50 ms (`lotaudio.ts`) instead of the
  original calls from HouseViewer::UpdateWorld / CPState::SetZoom / SetRotation and
  cSimsApp::DoCommand's clock.
- OutdoorTileRatio uses a flat PointToTile (level 1) estimate; room area
  (GetObjectData 13) = `room.tiles.length`.
- `?house=N` has no ambience: GameModeManager ignores modes until the hood was
  shown (faithful); use the full flow.
- SAnimator sound/footstep events: ported (`sim/animsound.ts`,
  HandleVitaBoyAnimEvent + GetFootSound → `soundPlayer.playBySource`).
  `footstep_terrain_noshoe` has no .hot mapping (silent, as in the original).
- Fresh cell state 1 loads samples asynchronously; FreshSnd.fadeVolume stops the
  sample at volume 0 (documented deviation). TurnOffTv is a no-op.
- A stopping (fading) track no longer executes commands; the original keeps
  stepping (it would run past `end`).
- MP3 songs stream through `<audio>` + MediaElementSource; Pause/Unpause of
  sample (non-MP3) channels mutes them instead of resuming at the same offset.
- CheckPriority (voice limits per SPL), cHitTimer drift, the debug events and
  kSndobUpdate / SetPosition are not implemented.
- Expansion flags (+0x66) are assumed all set; neighborhood music uses
  `Music\Modes\Nhood` (French build) unless `initialize(options, true)`.
