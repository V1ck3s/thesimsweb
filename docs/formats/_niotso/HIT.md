# Niotso wiki snapshot — HIT

> Source: <http://wiki.niotso.org/HIT>  
> Snapshot: 2026-05-01. Cleaned from HTML.

| Type of format | Sound logic |
|---|---|
| Filename extension | `.hit` |
| Magic number | `HIT!` |
| Byte order | Little endian |
| First appeared | The Sims 1 |
**HIT** is the object format that carries machine code sent to the sound coprocessor of the SimAntics environment. The functions defined in these files are dynamically linked into the game through EVT, HSM, and HOT files as well as the HIT export table introduced in TSO.
## Contents

- 1 Terminology
- 2 File structure

2.1 Header
- 2.2 Code section

2.2.1 Export table

- 3 Instructions
- 4 Variables

4.1 Track variables
- 4.2 Global variables
- 4.3 Object variables

- 5 Constants
- 6 MakeTrax

6.1 Directives

## Terminology
-  **event** - A signal passed to a track
-  **hitlist** - A list of sound IDs (in The Sims Online) or patch IDs (in The Sims 1), and/or other hitlists, from which one is randomly selected
-  **patch** - An object used in The Sims 1 describing the name and path of a sound
-  **sequence group**
-  **track** - An object describing a HIT subroutine and various metadata associated with the subroutine, such as argument type, control group, ducking priority, etc.
-  **ducking priority**
-  **sound pressure level**
-  **control group**
## File structure
### Header
-  **Magic number** - Four bytes equal to the ASCII characters "HIT!"
-  **Major version** - A 4-byte unsigned integer specifying the major version number of this HIT file; should be equal to 1
-  **Minor version** - A 4-byte unsigned integer specifying the minor version number of this HIT file; should be equal to 8
### Code section
-  **Header** - Four bytes equal to the ASCII characters "TRAX"
-  **HIT symbol data**
#### Export table

The export table was introduced into the HIT format in TSO. The HIT export table exports subroutines to handle the kSndobPlay events for tracks. The export table is itself a symbol in the code section, and oddly, its location is not specified anywhere in the HIT format; it must be found through a search of the 4-byte header "ENTP". TSOAudioViewD.dll does this search at TSOAudioViewD_base+0x19279 starting at the beginning of the file and assuming that the "ENTP" may be unaligned.

The format is as follows:

-  **Header** - 4 bytes equal to the ASCII characters "ENTP"
-  **Subroutines** - For each subroutine:

: -  **Track ID** - A 4-byte unsigned integer specifying the File ID of the track which invokes this subroutine
-  **Address** - A 4-byte unsigned integer specifying the offset from the beginning of the HIT file where this subroutine is located

-  **Footer** - 4 bytes equal to the ASCII characters "EENT"

If the 4 bytes "ENTP" occur elsewhere in the code section, the export table must be placed before all such occurrences. Ideally, to prevent this type of collision and to minimize the length of the search, the export table should appear immediately after the code section's 4-byte header "TRAX", but for some reason, in TSO's HIT files, the export table tends to be placed near the end of the file.

Because the value "EENT" is the sentinel for the end of the export table, the value 0x544e4545 ("EENT" as a 4-byte little-endian integer) is an illegal Track ID.

## Instructions
-  note 0x1 **(Unused in TS1 or TSO)**
-  note_on 0x2

: -  Description: Play a note, whose ID resides in the specified variable
-  Assembly: `note_on src`
-  Bytecode: `02 [src: 1 byte]`

-  note_off 0x3 **(Unused in TS1 or TSO)**

: -  Description: Stop playing a note, whose ID resides in the specified variable
-  Assembly: `note_off src`
-  Bytecode: `03 [src: 1 byte]`

-  loadb 0x4

: -  Description: Zero-extend a 1-byte constant to 4 bytes and write to a variable
-  Assembly: `loadb dest #src`
-  Bytecode: `04 [dest: 1 byte] [src: 1 byte]`

-  loadl 0x5

: -  Description: Write a 4-byte constant to a variable
-  Assembly: `loadl dest #src`
-  Bytecode: `05 [dest: 1 byte] [src: 4 bytes]`

-  set, settt 0x6

: -  Description: Copy the contents of one variable into another
-  Assembly: `set dest src`
-  Bytecode: `06 [dest: 1 byte] [src: 1 byte]`

-  call 0x7

: -  Description: Call a function; push the instruction pointer and jump to the given address
-  Assembly: `call #src`
-  Bytecode: `07 [src: 4 bytes]`

-  return 0x8

: -  Description: Return from this function; pop the instruction pointer from the call stack (if non-empty) and jump. Alternatively, if the call stack is empty, kill this thread.
-  Assembly: `return`
-  Bytecode: `08`

-  wait 0x9

: -  Description: Wait for a length of time in milliseconds, specified by a variable.
-  Assembly: `wait src`
-  Bytecode: `09 [src: 1 byte]`

-  callentrypoint 0xa **(Unused in TS1 or TSO)**

: -  Description: Call the entry point using the given track ID
-  Assembly: `callentrypoint #src`
-  Bytecode: `0A [src: 4 bytes]`
-  Notes: Used in SoundData/HitLabTest/892358b2.str source code in TSOAudio.dat

-  wait_samp 0xb

: -  Description: Wait for the previously selected note to finish playing
-  Assembly: `wait_samp`
-  Bytecode: `0B`

-  end 0xc

: -  Description: Kill this thread
-  Assembly: `end`
-  Bytecode: `0C`

-  jump 0xd

: -  Description: Jump to a given address
-  Assembly: `jump #src / jump src`
-  Bytecode: `0D [src: 4 bytes]`, `0D [src: 1 byte]`, or `0D [src: 1 byte] 00 00 00`
-  Notes: Because arguments and registers are each identified by a value from 0 to 15 (inclusive) and the HIT header is 16 bytes large (thus making a logical address below 0x00000010 invalid), both an argument/register and a logical address could be used as the operand if both are specified with four bytes, as is the case with simssound.HIT in The Sims 1. However, some genius at Maxis decided to save 3 bytes for all other HIT files by trimming off the 3 padding bytes if an argument/register is specified. This means when you read the bytecode, you have to employ a funny heuristic: if you still have 4 more bytes in the stream, AND they represent a number >=16 and less than the size of the file, then the number is a 4-byte address; otherwise, if the first byte is 0x05 or 0x06 (v1 or v2), then the number is one byte for a variable; otherwise, the number is four bytes for a variable. Obviously, there are collisions, as is the case with this hypothetical bytecode: `0D 05 04 05 00`. Is that "Jump to 0x50405" (321kB into the file) or is that "Jump to the address held by v5" then just below it "Set the low byte of v5 to 0"? We haven't done testing for that, but regardless, the heuristic mentioned above should work for the HIT files in The Sims 1 and The Sims Online. You cannot call jump with a variable higher than h4 as the operand.

-  test 0xe

: -  Description: Examine a variable and set the flags
-  Assembly: `test arg1`
-  Bytecode: `0E [arg1: 1 byte]`

-  nop 0xf **(Unused in TS1 or TSO)**

: -  Description: No operation
-  Assembly: `nop`
-  Bytecode: `0F`

-  add 0x10

: -  Description: Increment a "dest" variable by a "src" variable
-  Assembly: `add dest src`
-  Bytecode: `10 [dest: 1 byte] [src: 1 byte]`

-  sub 0x11

: -  Description: Decrement a "dest" variable by a "src" variable
-  Assembly: `sub dest src`
-  Bytecode: `11 [dest: 1 byte] [src: 1 byte]`

-  div 0x12

: -  Description: Divide a "dest" variable by a "src" variable, and round the result towards zero (truncate)
-  Assembly: `div dest src`
-  Bytecode: `12 [dest: 1 byte] [src: 1 byte]`

-  mul 0x13

: -  Description: Multiply a "dest" variable by a "src" variable
-  Assembly: `div dest src`
-  Bytecode: `13 [dest: 1 byte] [src: 1 byte]`

-  cmp 0x14

: -  Description: Compare two variables and set the flags
-  Assembly: `cmp arg1 arg2`
-  Bytecode: `14 [arg1: 1 byte] [arg2: 1 byte]`

-  less 0x15 **(Unused in TS1 or TSO)**
-  greater 0x16 **(Unused in TS1 or TSO)**
-  not 0x17 **(Unused in TS1 or TSO)**
-  rand 0x18

: -  Description: Generate a random number between "low" and "high" variables, inclusive, and store the result in the "dest" variable
-  Assembly: `rand dest low high`
-  Bytecode: `18 [dest: 1 byte] [low: 1 byte] [high: 1 byte]`

-  abs 0x19 **(Unused in TS1 or TSO)**
-  limit 0x1a **(Unused in TS1 or TSO)**
-  error 0x1b **(Unused in TS1 or TSO)**
-  assert 0x1c **(Unused in TS1 or TSO)**
-  add_to_group 0x1d **(Unused in TS1 or TSO)**

: -  Description: Add to control group grpid (source: defaultsyms.txt)

-  remove_from_group 0x1e **(Unused in TS1 or TSO)**

: -  Description: Remove from a control group grpid (source: defaultsyms.txt)

-  get_var 0x1f **(Unused in TS1 or TSO)**

: -  Description: Get value of a numbered register address by contents of var (source: defaultsyms.txt)

-  loop 0x20

: -  Description: Jump back to the loop point (start of track subroutine by default)
-  Assembly: `loop`
-  Bytecode: `20`

-  set_loop 0x21

: -  Description: Set the loop point to the current position
-  Assembly: `set_loop`
-  Bytecode: `21`

-  callback 0x22 **(Unused in TS1 or TSO)**

: -  Description: Call a function with args (source: defaultsyms.txt)

-  smart_add 0x23 **(Unused in TS1 or TSO)**
-  smart_remove 0x24 **(Unused in TS1 or TSO)**
-  smart_removeall 0x25 **(Unused in TS1 or TSO)**
-  smart_setcrit 0x26 **(Unused in TS1 or TSO)**
-  smart_choose 0x27

: -  Description: Set the specified variable to a random entry from the selected hitlist
-  Assembly: `smart_choose dest`
-  Bytecode: `27 [dest: 1 byte]`

-  and 0x28 **(Unused in TS1 or TSO)**
-  nand 0x29 **(Unused in TS1 or TSO)**
-  or 0x2a **(Unused in TS1 or TSO)**
-  nor 0x2b **(Unused in TS1 or TSO)**
-  xor 0x2c **(Unused in TS1 or TSO)**
-  max 0x2d

: -  Description: Find the higher of a "dest" variable and a "src" constant and store the result in the variable
-  Assembly: `max dest #src`
-  Bytecode: `2D [dest: 1 byte] [src: 4 bytes]`

-  min 0x2e **(Unused in TS1 or TSO)**

: -  Description: Find the lower of a "dest" variable and a "src" constant and store the result in the variable
-  Assembly: `min dest #src`
-  Bytecode: `2E [dest: 1 byte] [src: 4 bytes]`

-  inc 0x2f **(Unused in TS1 or TSO)**
-  dec 0x30 **(Unused in TS1 or TSO)**
-  printreg 0x31 **(Unused in TS1 or TSO)**
-  play_trk 0x32

: -  Description: Play a track (by sending it the kSndobPlay event), whose ID resides in the specified variable
-  Assembly: `play_trk src`
-  Bytecode: `32 [src: 1 byte]`

-  kill_trk 0x33

: -  Description: Kill a track (by sending it the kSndobKill event), whose ID resides in the specified variable
-  Assembly: `kill_trk src`
-  Bytecode: `33 [src: 1 byte]`

-  push 0x34 **(Unused in TS1 or TSO)**
-  push_mask 0x35 **(Unused in TS1 or TSO)**
-  push_vars 0x36 **(Unused in TS1 or TSO)**
-  call_mask 0x37 **(Unused in TS1 or TSO)**
-  call_push 0x38 **(Unused in TS1 or TSO)**
-  pop 0x39 **(Unused in TS1 or TSO)**
-  test1 0x3a

: -  Description: Unknown
-  Assembly: `test1`
-  Bytecode: `3A`

-  test2 0x3b

: -  Description: Unknown
-  Assembly: `test2`
-  Bytecode: `3B`

-  test3 0x3c

: -  Description: Unknown
-  Assembly: `test3`
-  Bytecode: `3C`

-  test4 0x3d

: -  Description: Unknown
-  Assembly: `test4`
-  Bytecode: `3D`

-  ifeq 0x3e

: -  Description: If the zero flag is set, jump to the given address
-  Assembly: `ifeq #src`
-  Bytecode: `3E [src: 4 bytes]`

-  ifne 0x3f

: -  Description: If the zero flag is not set, jump to the given address
-  Assembly: `ifne #src`
-  Bytecode: `3F [src: 4 bytes]`

-  ifgt 0x40

: -  Description: If the sign flag is not set and the zero flag is not set, jump to the given address
-  Assembly: `ifgt #src`
-  Bytecode: `40 [src: 4 bytes]`

-  iflt 0x41

: -  Description: If the sign flag is set, jump to the given address
-  Assembly: `iflt #src`
-  Bytecode: `41 [src: 4 bytes]`

-  ifge 0x42

: -  Description: If the sign flag is not set, jump to the given address
-  Assembly: `ifge #src`
-  Bytecode: `42 [src: 4 bytes]`

-  ifle 0x43

: -  Description: If the sign flag is set or the zero flag is set, jump to the given address
-  Assembly: `ifle #src`
-  Bytecode: `43 [src: 4 bytes]`

-  smart_setlist 0x44

: -  Description: Choose a global hitlist, or 0 for the one local to the track (source: defaultsyms.txt)
-  Assembly: `smart_setlist src`
-  Bytecode: `44 [src: 1 byte]`

-  seqgroup_kill 0x45

: -  Description: Kill all sounds belonging to the sequence group specified by the "group" variable.
-  Assembly: `seqgroup_kill group`
-  Bytecode: `45 [group: 1 byte]`

-  seqgroup_wait 0x46 **(Unused in TS1 or TSO)**
-  seqgroup_return 0x47

: -  Description: Unknown
-  Assembly: `seqgroup_return group`
-  Bytecode: `47 [group: 1 byte]`

-  getsrcdatafield 0x48

: -  Description: Read an object variable (whose ID is specified by the "field" variable) of a source object (whose object ID is specified by the "source" variable), store it in the "dest" variable, and update the flags (see Object variables)
-  Assembly: `getsrcdatafield dest source field`
-  Bytecode: `48 [dest: 1 byte] [source: 1 byte] [field: 1 byte]`

-  seqgroup_trkid 0x49

: -  Description: Unknown (2 constants)
-  Assembly: ` seqgroup_trkid #unknown #unknown`
-  Bytecode: `49 [unknown: 1 byte] [unknown: 1 byte]`

-  setll 0x4a

: -  Description: Copy the contents of one variable into another (equivalent to set and settt; defaultsyms.txt says "ISN'T THIS THE SAME AS SET TOO?")
-  Assembly: `setll dest src`
-  Bytecode: `4A [dest: 1 byte] [src: 1 byte]`

-  setlt 0x4b

: -  Description: Unknown (2 variables)
-  Assembly: `setlt dest src`
-  Bytecode: `4B [dest: 1 byte] [src: 1 byte]`

-  settl 0x4c **(Unused in TS1 or TSO)**

: -  Description: Unknown (2 variables)
-  Assembly: `settl dest src`
-  Bytecode: `4C [dest: 1 byte] [src: 1 byte]`

-  waiteq 0x4d

: -  Description: Wait until two variables are equal.
-  Assembly: `waiteq var1 var2`
-  Bytecode: `4D [var1: 1 byte] [var2: 1 byte]`

-  waitne 0x4e **(Unused in TS1 or TSO)**

: -  Description: Wait until variables are not equal.
-  Assembly: `waitne var1 var2`
-  Bytecode: `4E [var1: 1 byte] [var2: 1 byte]`

-  waitgt 0x4f **(Unused in TS1 or TSO)**

: -  Description: Wait until the first variable is greater than the second variable.
-  Assembly: `waitgt var1 var2`
-  Bytecode: `4F [var1: 1 byte] [var2: 1 byte]`

-  waitlt 0x50 **(Unused in TS1 or TSO)**

: -  Description: Wait until the first variable is less than the second variable.
-  Assembly: `waitlt var1 var2`
-  Bytecode: `50 [var1: 1 byte] [var2: 1 byte]`

-  waitge 0x51 **(Unused in TS1 or TSO)**

: -  Description: Wait until the first variable is greater than or equal to the second variable.
-  Assembly: `waitge var1 var2`
-  Bytecode: `51 [var1: 1 byte] [var2: 1 byte]`

-  waitle 0x52 **(Unused in TS1 or TSO)**

: -  Description: Wait until the first variable is less than or equal to the second variable.
-  Assembly: `waitle var1 var2`
-  Bytecode: `52 [var1: 1 byte] [var2: 1 byte]`

-  duck 0x53

: -  Description: Unknown
-  Assembly: `duck`
-  Bytecode: `53`

-  unduck 0x54

: -  Description: Unknown
-  Assembly: `unduck`
-  Bytecode: `54`

-  testx 0x55 **(Unused in TS1 or TSO)**

: -  Description: Unknown
-  Assembly: `testx var1 var2 var3`
-  Bytecode: `55 [var1: 1 byte] [var2: 1 byte] [var3: 1 byte]`
-  Notes: Used in SoundData/HitLabTest/292333c5.str source code in TSOAudio.dat

-  setlg 0x56

: -  Description: Set global = local (source: defaultsyms.txt) (see Global variables)
-  Assembly: `setlg local #global`
-  Bytecode: `56 [local: 1 byte] [global: 4 bytes]`

-  setgl 0x57

: -  Description: Read globally, set locally (source: defaultsyms.txt) (see Global variables)
-  Assembly: `setgl local #global`
-  Bytecode: `57 [local: 1 byte] [global: 4 bytes]`

-  throw 0x58 **(Unused in TS1 or TSO)**
-  setsrcdatafield 0x59

: -  Description: Set an object variable (whose ID is specified by the "field" variable) of a source object (whose object ID is specified by the "source" variable) to the value specified by the "value" variable (see object variables)
-  Assembly: `setsrcdatafield value source field`
-  Bytecode: `59 [value: 1 byte] [source: 1 byte] [field: 1 byte]`

-  stop_trk 0x5a

: -  Description: Stop a track (by sending it the kSndobStop event), whose ID resides in the specified variable
-  Assembly: `stop_trk src`
-  Bytecode: `5A [src: 1 byte]`

-  setchanreg 0x5b **(Unused in TS1 or TSO)**
-  play_note 0x5c **(Unused in TS1 or TSO)**
-  stop_note 0x5d **(Unused in TS1 or TSO)**
-  kill_note 0x5e **(Unused in TS1 or TSO)**
-  smart_index 0x5f

: -  Description: Find the entry at the index specified by the "index" variable in the hitlist specified by the "dest" variable and store that entry in the "dest" variable
-  Assembly: `smart_index dest index`
-  Bytecode: `5F [dest: 1 byte] [index: 1 byte]`

-  note_on_loop 0x60

: -  Description: Play a note, whose ID resides in the specified variable, and immediately loop it indefinitely
-  Assembly `note_on_loop src`
-  Bytecode: `60 [src: 1 byte]`

## Variables

According to Hitlab.ini, arguments and registers are categorized under track variables.

### Track variables

**Arguments:**

-  arg0 0x0
-  arg1 0x1
-  arg2 0x2
-  arg3 0x3
-  arg4 0x4

Note: In The Sims Online, "Instance" is an alias for arg0, and "Gender" is an alias for arg1. In The Sims 1, "Instance" is an alias for arg1, and "Gender" is an alias for arg2.

**Registers:**

-  v1 0x5
-  v2 0x6
-  v3 0x7
-  v4 0x8
-  v5 0x9
-  v6 0xa
-  v7 0xb
-  v8 0xc
-  h1 0xd
-  h2 0xe
-  h3 0xf
-  h4 0x10

**
The Sims Online:**

-  argstype 0x10
-  trackdatasource 0x11
-  patch 0x12
-  priority 0x13
-  vol 0x14
-  extvol 0x15
-  pan 0x16
-  pitch 0x17
-  paused 0x18
-  fxtype 0x19
-  fxlevel 0x1a
-  duckpri 0x1b
-  Is3d 0x1c
-  IsHeadRelative 0x1d
-  HeadRelative 0x1d
-  MinDistance 0x1e
-  MaxDistance 0x1f
-  X 0x20
-  Y 0x21
-  Z 0x22
-  attack 0x23
-  decay 0x24
-  IsStreamed 0x25
-  stream 0x25
-  bufsizemult 0x26
-  fade_dest 0x27
-  fade_var 0x28
-  fade_speed 0x29
-  fade_on 0x2a
-  Preload 0x2b
-  isplaying 0x2c
-  whattodowithupdate 0x2d
-  tempo 0x2e
-  target 0x2f
-  ctrlgroup 0x30
-  interrupt 0x31
-  ispositioned 0x32
-  loop 0x33 (this is only found commented out in Hitlab.ini; it's unused probably because it conflicts with the loop instruction)
-  source 0x34
-  AppObjectId 0x34
-  callbackarg 0x35
-  pitchrandmin 0x36
-  pitchrandmax 0x37
-  spl 0x38
-  sem 0x39
-  starttrackid 0x3a
-  endtrackid 0x3b
-  startdelay 0x3c
-  fadeinspeed 0x3d
-  fadeoutspeed 0x3e
-  hitlist 0x3f
-  velocx 0x40
-  velocy 0x41
-  velocz 0x42
-  orientx 0x43
-  orienty 0x44
-  orientz 0x45

**
The Sims 1:**

-  priority 0x11
-  vol 0x12
-  extvol 0x13
-  pan 0x14
-  pitch 0x15
-  paused 0x16
-  fxtype 0x17
-  fxlevel 0x18
-  duckpri 0x19
-  Is3d 0x1a
-  IsHeadRelative 0x1b
-  MinDistance 0x1c
-  MaxDistance 0x1d
-  X 0x1e
-  Y 0x1f
-  Z 0x20
-  filter_type 0x21
-  filter_cutoff 0x22
-  filter_level 0x23
-  attack 0x24
-  decay 0x25
-  IsStreamed 0x26
-  BufSizeMult 0x27
-  fade_dest 0x28
-  fade_var 0x29
-  fade_speed 0x2a
-  Preload 0x2b
-  IsLooped 0x2c
-  fade_on 0x2d
-  isplaying 0x2e
-  source 0x2f
-  patch 0x32
-  WhatToDoWithUpdate 0x33
-  tempo 0x34
-  target 0x35
-  mutegroup 0x36
-  interrupt 0x37
-  IsPositioned 0x38
-  Spl 0x39
-  MultipleInstances 0x3a
-  AssociatedTrack1 0x3b
-  AssociatedTrack2 0x3c
-  AssociatedTrack3 0x3d
-  AssociatedTrack4 0x3e
-  AssociatedTrack5 0x3f
-  AssociatedTrack6 0x40
-  AssociatedTrack7 0x41
-  AssociatedTrack8 0x42
### Global variables
-  SimSpeed 0x64
-  test_g1 0x65
-  test_g2 0x66
-  test_g3 0x67
-  test_g4 0x68
-  test_g5 0x69
-  test_g6 0x6a
-  test_g7 0x6b
-  test_g8 0x6c
-  test_g9 0x6d
-  main_songnum 0x6e
-  main_musichitlistid 0x6f
-  campfire_nexttrack 0x70
-  campfire_busy 0x71
-  main_duckpri 0x7b
-  main_vol 0x7c
-  main_fxtype 0x7d
-  main_fxlevel 0x7e
-  main_pause 0x7f
-  CurrentFloor 0x80
-  Hour 0x81
-  RoomSize 0x82
-  OutdoorRatio 0x83
-  OptionSfxVol 0x84
-  OptionVoxVol 0x85
-  OptionMusicVol 0x86
-  CampfireSize 0x87
### Object variables
-  IsInsideViewFrustrum 0x271a
-  PositionX 0x271b
-  PositionY 0x271c
-  PositionZ 0x271d
-  OrientationX 0x271e
-  OrientationY 0x271f
-  OrientationZ 0x2720
-  ViewUpX 0x2721
-  ViewUpY 0x2722
-  ViewUpZ 0x2723
-  IsObscured 0x2725
-  Gender 0x2726
-  Age 0x2727
-  CookingSkill 0x2728
-  CleaningSkill 0x2729
-  CreativitySkill 0x272a
-  RepairSkill 0x272b
-  GardeningSkill 0x272c
-  MusicSkill 0x272d
-  LiteracySkill 0x272e
-  LogicSkill 0x272f
-  Mood 0x2730
-  Niceness 0x2731
-  Activeness 0x2732
-  Generousness 0x2733
-  Playfulness 0x2734
-  Outgoingness 0x2735
-  Neatness 0x2736
## Constants

**Ducking priorities:**

-  duckpri_always 0x0
-  duckpri_low 0xa
-  duckpri_normal 0x14
-  duckpri_high 0x1e
-  duckpri_higher 0x28
-  duckpri_evenhigher 0x32
-  duckpri_never 0x64

**
Sound pressure levels:**

-  spl_infinite 0x0 — infinite spl (no attenuation with distance)
-  spl_loud 0xa
-  spl_normal 0x14
-  spl_quiet 0x64
-  kSplStereo 0x2711

**
Sequence groups:**

-  GroupMusic 0x1
-  GroupDialogMain 0x2
-  GroupDialogOverlay 0x3

**
PchDishwasher:**

-  PchDishwasherClose 0x32
-  PchDishwasherLoad 0x33
-  PchDishwasherLoad2 0x34
-  PchDishwasherOpen 0x35
-  PchDishwasherTurnDial 0x39
-  PchDishwasherTurnDial2 0x3a

**
TrkRadioStation:**

-  TrkRadioStationCountry 0x104
-  TrkRadioStationBossaNova 0x10e
-  TrkRadioStationClassical 0x10d
-  TrkRadioStationRock 0x118

**
Events:**

-  kSndobPlay=1
-  kSndobStop=2
-  kSndobKill=3
-  kSndobUpdate=4
-  kSndobSetVolume=5
-  kSndobSetPitch=6
-  kSndobSetPan=7
-  kSndobSetPosition=8
-  kSndobSetFxType=9
-  kSndobSetFxLevel=10
-  kSndobPause=11
-  kSndobUnpause=12
-  kSndobLoad=13
-  kSndobUnload=14
-  kSndobCache=15
-  kSndobUncache=16
-  kSndobCancelNote=19
-  kKillAll=20
-  kPause=21
-  kUnpause=22
-  kKillInstance=23
-  kTurnOnTv=30
-  kTurnOffTv=31
-  kUpdateSourceVolPan=32
-  kSetMusicMode=36
-  kPlayPiano=43
-  debugeventson=44
-  debugeventsoff=45
-  debugsampleson=46
-  debugsamplesoff=47
-  debugtrackson=48
-  debugtracksoff=49

**
Music modes:**

-  kLive=0
-  kBuy=1
-  kBuild=2
-  kHood=3
-  kFrontEnd=4

**
Control groups:**

-  kGroupSfx=1
-  kGroupMusic=2
-  kGroupVox=3

**
Radio stations:**

-  kAction=1000
-  kComedy=1001
-  kRomance=1002
-  kNews=1003
-  kCountry=1004
-  kRock=1005
-  kJazz=1006
-  kClassical=1007

**
Arguments:**

-  kArgsNormal=0
-  kArgsVolPan=1
-  kArgsIdVolPan=2
-  kArgsXYZ=3
## MakeTrax

MakeTrax is the source code generator for HIT's txt files, as apparent by the "generated by MakeTrax" comment at the top of each source file. As suggested by packingslips.dat and the copy of HitLabServiceD.dll distributed in the Play Test version of the game, Maxis did not interface with MakeTrax directly but instead used a GUI tool called Hitlab to write all their HIT code.

A ";", as well as a "# " (the latter of which occurs exactly once, at the top of tsov3.txt), denote an end-of-line comment.

All numbers are treated as decimal. Any # directly preceding a number or constant, without a space in between, indicates by unenforced convention that the number does not refer to a variable. This convention is not followed in the generic_fm_smartlists subroutine.

### Directives
-  BASEID_TRACKDATA

: -  Description: Unknown
-  Syntax: `BASEID_TRACKDATA some number`

-  BINARY

: -  Description: Write information to the HIT file.
-  Syntax: `BINARY [ ... ]`

-  EQU

: -  Description: Define a new token.
-  Syntax: `EQU token value`

-  INCLUDE, include

: -  Description: Include the contents of a file residing in the same directory.
-  Syntax: `INCLUDE some file`
 In all caps, this directive is always specified with either defaultsyms.txt or SimsGlobals.txt, both of which are only found in The Sims Online Play Test, and without caps this directive specifies a number of files for tracksmain.txt, which we do not have access to. None of these files are necessary.

-  INIFILE

: -  Description: Specify the ini file for this source file.
-  Syntax: `INIFILE some file`
 Somehow or another, INIFILE is always specified with an ini extension, when these files only exist with the HOT extension.

-  LIST

: -  Description: Append inline ini information.
-  Syntax: `LIST [section] key=value`

-  SYMBOLFILE

: -  Description: Specify the HSM file for this source file.
-  Syntax: `SYMBOLFILE some file`
