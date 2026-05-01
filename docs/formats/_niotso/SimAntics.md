# Niotso wiki snapshot — SimAntics

> Source: <http://wiki.niotso.org/SimAntics>  
> Snapshot: 2026-05-01. Cleaned from HTML.

**SimAntics** is a CISC bytecode language which powers the objects in The Sims and The Sims Online.

Development of SimAntics was coordinated by Jamie Doornbos with the help of Patrick J. Barrett III and Don Hopkins.

## Contents

- 1 Edith

1.1 Leak

- 2 Model

2.1 Terminology

2.1.1 Initialisms

- 3 Text language
- 4 Disassembly

4.1 Header
- 4.2 Instruction

- 5 Primitives

5.1 0 - Sleep
- 5.2 1 - Generic Sims Online Call
- 5.3 2 - Expression
- 5.4 3 - Report Metric
- 5.5 4 - grab
- 5.6 5 - drop
- 5.7 6 - Change Suit/Accessory
- 5.8 7 - Refresh
- 5.9 8 - Random Number
- 5.10 9 - burn
- 5.11 10 - Sims1.0 tutorial
- 5.12 11 - Get Distance To
- 5.13 12 - Get Direction To
- 5.14 13 - Push Interaction
- 5.15 14 - Find Best Object for Function
- 5.16 15 - Break Point
- 5.17 16 - Find Location For
- 5.18 17 - idle for input
- 5.19 18 - Remove Object Instance
- 5.20 19 - make new character
- 5.21 20 - Run Functional Tree
- 5.22 21 - show string
- 5.23 22 - look towards
- 5.24 23 - Play Sound Event
- 5.25 24 - old relationship
- 5.26 25 - Transfer Funds
- 5.27 26 - Relationship
- 5.28 27 - Go To Relative Position
- 5.29 28 - Run Tree by Name
- 5.30 29 - Set Motive Change
- 5.31 30 - Syslog
- 5.32 31 - Set to Next
- 5.33 32 - Test Object Type
- 5.34 33 - find 5 worst motives
- 5.35 34 - ui effect
- 5.36 35 - Special Effect
- 5.37 36 - Dialog - Private Strings
- 5.38 37 - Test Sim Interacting With
- 5.39 38 - Dialog - Global Strings
- 5.40 39 - Dialog - Semi-Global Strings
- 5.41 40 - OnlineJobsCall
- 5.42 41 - Set Balloon/Headline
- 5.43 42 - Create New Object Instance
- 5.44 43 - drop onto
- 5.45 44 - Animate Sim
- 5.46 45 - Go To Routing Slot
- 5.47 46 - Snap
- 5.48 47 - reach
- 5.49 48 - Stop ALL Sounds
- 5.50 49 - Notify the Stack Object out of Idle
- 5.51 50 - Add/Change the Action String
- 5.52 51 - prim 51 - (used in Sims 2.0)
- 5.53 52 - prim 52 - (used in Sims 2.0)
- 5.54 53 - prim 53 - (used in Sims 2.0)
- 5.55 54 - prim 54 - (used in Sims 2.0)
- 5.56 55 - Sync Field
- 5.57 56 - Ownership
- 5.58 57 - Start Persistant Dialog
- 5.59 58 - End Persistant Dialog
- 5.60 59 - Update Persistant Dialog
- 5.61 60 - Poll Persistant Dialog
- 5.62 61 - Send Maxis Letter
- 5.63 62 - Invoke Plugin
- 5.64 63 - Get Terrain Info
- 5.65 64 - Leave Lot and Goto
- 5.66 65 - Find Best Action
- 5.67 66 - Set Dynamic Object Name
- 5.68 67 - Inventory Operations

- 6 Scopes

6.1 0 - my objects attributes
- 6.2 1 - stack objects attributes
- 6.3 2 - targ obj attr (DO NOT USE)
- 6.4 3 - my object
- 6.5 4 - stack object
- 6.6 5 - targ obj's (DO NOT USE)
- 6.7 6 - Global ( from avatar )
- 6.8 7 - literal
- 6.9 8 - temps
- 6.10 9 - parameters
- 6.11 10 - stack object id
- 6.12 11 - Temp[temp]
- 6.13 12 - check tree ad range
- 6.14 13 - stack obj's temp
- 6.15 14 - my motives
- 6.16 15 - stack obj's motives
- 6.17 16 - stack object's slot
- 6.18 17 - stack obj's motive[temp]
- 6.19 18 - my person data
- 6.20 19 - stack obj's person data
- 6.21 20 - my slot
- 6.22 21 - stack objects definition
- 6.23 22 - stack object's attr[stack param]
- 6.24 23 - room[temp 0]
- 6.25 24 - neighbor in stack object
- 6.26 25 - local
- 6.27 26 - stack object tuning
- 6.28 27 - Dyn. Sprite Flag[temp] of Stack Object
- 6.29 28 - check tree ad personality var
- 6.30 29 - check tree ad min
- 6.31 30 - my person data [temp]
- 6.32 31 - stack obj's person data [temp]
- 6.33 32 - neighbor's person data
- 6.34 33 - job data [temp 0, 1]
- 6.35 34 - neighborhood data
- 6.36 35 - stack object's function
- 6.37 36 - my type attr
- 6.38 37 - stack obj's type attr

## Edith

Objects for the game were programmed in an assembly intermediary of SimAntics using a developer tool called **Edith**, which is named after the first character produced for the game, Edith Bunker, and also stands for **Edit Hierarchies** or **Edit House**. The tool employs a box-and-arrow tree layout, in which each box describes an instruction and then points to one or more other boxes to direct control flow. This layout was designed and executed by Jamie Doornbos. The workspace was saved as metadata with the objects and was normally stripped before release; the NPCs, however, did not have their workspaces stripped, and they can be read along with their comments by the 3rd-party clone of Edith called Codex.

Along with providing a tool editing interface, Edith allowed the programmer to load the Edith window alongside the game to immediately test newly created objects; thus, the E key was the "Edit House" command.

Edith was not officially released outside of Maxis but was demonstrated in short videos by Don Hopkins, which can be found on the Movies section of his website, specifically, in this order:

-  The Sims Pie Menus (Edith demonstration) (47.1MB / 49,471,706 bytes)
-  Free The Sims Demo (7.94MB / 8,329,392 bytes)
-  Transmogrifier Demo (5.23MB / 5,493,860 bytes)
-  Object Exporter Demo (0.97MB / 1,026,770 bytes)
-  Person Exporter Demo (1.50MB / 1,578,455 bytes)

:  These videos were batch-uploaded by Don Hopkins on Sun, 01 Feb 2004 09:04:21 GMT according to the Last-Modified header of the files, although it seems they were recorded in 2000.

EA also allowed a computer science class taught by Kenneth D. Forbus at Northwestern University in May 2001 and May 2002 to use Edith as part of their curriculum, but no students ever saved the software. Some documents were provided to the public describing the virtual machine:

-  Under the hood of The Sims
-  Programming Objects in The Sims (1.31MB / 1,383,488 bytes)

The text strings used in the GUI for Edith are shipped with the game in both The Sims 1 and The Sims Online in a file named `behavior.iff`. Numerical constants as well can be found in the OTF files in the globals folder as well as the C++ headers located in the UIGraphics folder of both games.

### Leak

Edith has been known since early 2012 to have been leaked in the final version of EA-Land. On December 22, 2012, a patch was released by Fatbag which launches Edith instead of the game. The patch can be downloaded here (please keep a copy of the entire original, unmodified game in a separate folder):

-  Edith.bps
-  Patch tool

Note that certain features, such as spawning new instances of objects on a lot and debugging them, are inactive without a working game lot.

In the Pre-Alpha version of The Sims Online (which was leaked on February 18, 2014), Edith can be launched through the use of the "edith" cheat. The cheat prompt can opened through Ctrl+Shift+C (like in The Sims 1) once you are logged in. Unlike The Sims 1, you must first authorize yourself to use cheats by entering the password "FullOpt" (case-insensitive) as a cheat into the cheat prompt. The protocol changes necessary to log in and enter Select-A-Sim in Pre-Alpha were determined on March 20th, 2014 and published in the Maxis Protocol article. The game can be forced into lot mode by starting with the command line option "-NoNetwork", however the simulation will be frozen. The complete list of arguments (as determined by the argument comparisons performed at TSOClient_base+0x9f6b in Pre-Alpha) is:

nosound UseDBHostLayer lUKEnglish lFrench lGerman lItalian lSpanish lDutch lDanish lSwedish lNorwegian lFinnish lHebrew lRussian lPortuguese lJapanese lPolish lSimplifiedChinese lTraditionalChinese lThai lKorean lUSEnglish f r1024x768 3dhardware skip_memcheck skip_verify testmusic tuning_obj_depreciation skip_intro software_intro no_thread_init record replay nonetwork debug_objects rebuild_catalog non_us_locale show_init_progress soundguys no_autosave TestWindow factory

NoNetwork works in every version of the game in our possession until the New & Improved US boxed version.

## Model

SimAntics assembly is assembled into bytecode which is executed within a virtual thread granted to that object. Altogether, the virtual threads are executed synchronously (one after the other) in a nonpreemptive virtual machine, the SimAntics environment.

Each object eventually relinquishes its control to the next object by calling the idle primitive or returning error; a return value of error tells the machine to kill the object and remove it from the lot, and if the game process was launched with the -debug_objects argument, the game will prompt a message that the object has crashed and provide its stack dump.

### Terminology
-  action
-  advertisement
-  attenuation
-  autonomy
-  behavior
-  bitfield
-  check
-  entry point
-  function
-  global
-  local
-  menu
-  node
-  object definition
-  parameter
-  primitive
-  private
-  scenario
-  semiglobal
-  slot
-  stack object
-  tree
-  tuning constant
-  variable
#### Initialisms
-  SAS, CAS: Select-A-Sim, Create-A-Sim
-  GZ: Gonzo, a Maxis game development framework
-  RZ: Rizzo, built on top of Gonzo
-  EASTL: EA's Standard Template Library replacement, now released under the GPL: https://github.com/paulhodge/EASTL
-  LMS: Language Markup System
-  EOD: What it stands for is unknown, but it refers to custom menus that override the panel at the bottom of the screen when your Sim is dancing or playing black jack, for example.
-  AWC
## Text language

Edith provides a menu option (File -> Save all behaviors...) that disassembles all of the behaviors in the game into txt files, categorized by their containing IFF files. Before looking at the binary structure of behaviors, it helps to first look at this text representation.

The first line of the disassembly is the name of the IFF file, sans the file extension. For example, in behaviorscuckooclock.txt,

cuckooclock

Following this line is the disassembly for each behavior in the IFF file, sorted by ascending chunk ID. The first behavior in cuckooclock.iff is named "main":

(main).000 Stack Object ID 0 assign ( := ) My object id true:1
(main).001 Global: Idle (with ticks=10) true:2
(main).002 Private: process  true:1

As in C and C++, the main function is where execution for the object begins. When our particular object is added to the lot and run for the first time in Live mode, the object's ID will be written into the "Stack Object ID 0" variable. Upon true, it will branch to the instruction at index 1—in our case, simply the next one down. As the branch destination for false has not been specified, it is implicitly defined to error; that is, if the result of the instruction were false, the program would "branch" to error, deleting itself and informing the virtual machine that it has "crashed". Note that an object can delete itself off the lot at any time, without informing the virtual machine of a crash, by simply branching to true or false in the main function. The cuckooclock does not ever delete itself, however, so the only way to remove it is by selecting it with the hand tool and deleting it, which can be seen as "force closing" the process.

The second instruction performs the "idle for X ticks" global with X=10; this relinquishes the object's execution context and returns true after 10 ticks have passed; in response, the program will branch to the instruction at index 2.

The third instruction calls a private subroutine named "process" defined in the very same IFF file and then branches back to the previous instruction. In this short loop, we can see that this subroutine, "process", must return true to hand the context back to the virtual machine.

## Disassembly

SimAntics makes use of little-endian integers.

We will now analyze the executable format used for behaviors residing in BHAV chunks of the IFF files of the game.

### Header

| Offset: | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Meaning: |
| 0x8000 | Count | Zero |   |
| 0x8001 | Count | Unknown |   |
| 0x8002 | Count | Type | Args | Locals | Flags | Zero |   |
| 0x8003 | Type | Args | Locals | Unknown | Flags | Count |

-  **Magic number** - A 2-byte integer equal to 0x8000, 0x8001, 0x8002, or 0x8003
-  **Count** - The total number of instructions defined in this behavior
-  **Type** - Usually 0, but may be 1, 2, 3, or 22
-  **Args** - The number of arguments this subroutine expects to be passed. Up to four constant arguments can be passed in the call instruction; variable arguments or more than four arguments are passed through the use of temps.
-  **Locals** - The number of static variables allocated exclusively for this subroutine, which live for the life of the object
-  **Flags** - Attributes set for this subroutine

**

### Instruction

| Offset: | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Meaning: | Opcode | T-Dest | F-Dest | Operand data |

-  Opcode** - A numerical value which identifies the meaning of this instruction
-  **T-Dest** - Zero-based index of the instruction in this behavior to jump to if the result of this instruction is true
-  **F-Dest** - Zero-based index of the instruction in this behavior to jump to if the result of this instruction is false

:  A destination of 255 (true), 254 (false), or 253 (error) may be supplied to return from a subroutine; a return value of 253 will kill the object that called the subroutine.

-  **Operand data** - Data passed alongside the opcode; format is dependent on the opcode
## Primitives

In SimAntics, the opcode of an instruction can either refer to a built-in command, known as a **primitive**, or to a subroutine. The subroutines can be privates (belong to the object) semiglobals or globals. A private will have an opcode >= 4096 and a private will have an opcode >= 256.

Instructions are executed synchronously within the thread until something yields the thread, an error is fired or the stack becomes empty. An example of this is the Animate Sim primitive. In the behaviours found in the game, this primitive often has a loopback on the false branch which points back to itself. The primitive returns true if the animation is complete and false if it is not. The false then loops back to the Animate Sim primitive to run the next frame. If this code was executed synchronously no animations would ever be observed. Therefore some primitives yield the thread.

You can think of primitives as having the following return values. GOTO_TRUE, GOTO_FALSE, ERROR, GOTO_TRUE_YIELD, GOTO_FALSE_YIELD.

The documentation below for primitives and their operands is correct for The Sims Online. The Sims 1 operands may be slightly different.

### 0 - Sleep

Changes the current virtual thread's state to sleeping. Operand 4 and 5 (5 and 6 if counting from 1) contains the number of ticks to sleep for.

### 1 - Generic Sims Online Call
### 2 - Expression

Performs a logical or mathematical expression. The operator value describes what type of expression to perform and the other values determine the left and right hand side of the expression.

Operand:

| Offset: | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|---|
| Meaning: | LhsData | RhsData | IsSigned | Operator | LhsOwner | RhsOwner |

The lhsdata, lhsowner, rhsdata and rhsowner are scopes as described here. Possible values for operator:

| id | name | notes |
|---|---|---|
| 0 | > |  |
| 1 | < |  |
| 2 | == |  |
| 3 | += |  |
| 4 | -= |  |
| 5 | = |  |
| 6 | *= |  |
| 7 | /= |  |
| 8 | IsFlagSet |  |
| 9 | SetFlag |  |
| 10 | ClearFlag |  |
| 11 | ++ then < |  |
| 12 |  %= |  |
| 13 | &= |  |
| 14 | >= |  |
| 15 | <= |  |
| 16 |  != |  |
| 17 | -- then > |  |
| 18 | Push |  |
| 19 | Pop |  |

### 3 - Report Metric
### 4 - grab
### 5 - drop
### 6 - Change Suit/Accessory
### 7 - Refresh
### 8 - Random Number
### 9 - burn
### 10 - Sims1.0 tutorial

*This primitive isn't used in any of the behaviors found in The Sims Online.*

### 11 - Get Distance To
### 12 - Get Direction To
### 13 - Push Interaction
### 14 - Find Best Object for Function
### 15 - Break Point
### 16 - Find Location For
### 17 - idle for input

Changes the current virtual thread's state to idle. Operand 4 and 5 (5 and 6 if counting from 1) contains the number of ticks to idle for, and if operand 6 and 7 (7 and 8 if counting from 1) are non-zero, this state is interruptable (meaning that a new function can be invoked on the stack at any time).

### 18 - Remove Object Instance
### 19 - make new character
### 20 - Run Functional Tree
### 21 - show string
### 22 - look towards
### 23 - Play Sound Event
### 24 - old relationship
### 25 - Transfer Funds
### 26 - Relationship
### 27 - Go To Relative Position
### 28 - Run Tree by Name
### 29 - Set Motive Change
### 30 - Syslog
### 31 - Set to Next
### 32 - Test Object Type
### 33 - find 5 worst motives
### 34 - ui effect
### 35 - Special Effect
### 36 - Dialog - Private Strings
### 37 - Test Sim Interacting With
### 38 - Dialog - Global Strings
### 39 - Dialog - Semi-Global Strings
### 40 - OnlineJobsCall
### 41 - Set Balloon/Headline
### 42 - Create New Object Instance
### 43 - drop onto
### 44 - Animate Sim
### 45 - Go To Routing Slot
### 46 - Snap
### 47 - reach
### 48 - Stop ALL Sounds
### 49 - Notify the Stack Object out of Idle
### 50 - Add/Change the Action String
### 51 - prim 51 - (used in Sims 2.0)

*This primitive isn't used in any of the behaviors found in The Sims Online.*

### 52 - prim 52 - (used in Sims 2.0)

*This primitive isn't used in any of the behaviors found in The Sims Online.*

### 53 - prim 53 - (used in Sims 2.0)

*This primitive isn't used in any of the behaviors found in The Sims Online.*

### 54 - prim 54 - (used in Sims 2.0)

*This primitive isn't used in any of the behaviors found in The Sims Online.*

### 55 - Sync Field
### 56 - Ownership
### 57 - Start Persistant Dialog
### 58 - End Persistant Dialog
### 59 - Update Persistant Dialog
### 60 - Poll Persistant Dialog
### 61 - Send Maxis Letter
### 62 - Invoke Plugin
### 63 - Get Terrain Info
### 64 - Leave Lot and Goto
### 65 - Find Best Action
### 66 - Set Dynamic Object Name
### 67 - Inventory Operations
## Scopes

Several primitives make reference to variables stored in the VM to perform their actions. For example, the random number primitive provides the location of a variable for the random range. Usually (but not always) these take the form of two fields, a variable owner and variable data. The owner can be thought of like a scope and the possible values for this are described below.

### 0 - my objects attributes

Objects use attributes to store persistent information, e.g. whether the fish in the fish tank are dead or alive. This scope gets/sets an attribute for the object occupying the "My" pointer in the stack frame. The data value is the attribute index.

It seems (based on a handful of files) like a string table with ID = 256 in the objiff file contains labels for the attributes.

### 1 - stack objects attributes

Same as "my objects attributes" except against the object occupying the stack object pointer in the stack frame.

### 2 - targ obj attr (DO NOT USE)

Judging from the capital letters, this probably isn't used anywhere ingame.

### 3 - my object

This refers to an objects built in fields such as which graphic is displaying or how dirty the object is. Below are the possible values for the data field.

| id | name | notes |
|---|---|---|
| 0 | Graphic | This number should be added to OBJD.BaseGraphicID to calculate the DGRP ID. |
| 1 | Direction |  |
| 2 | ContainerId |  |
| 3 | SlotNumber |  |
| 4 | AllowedHeightFlags |  |
| 5 | WallAdjacencyFlags |  |
| 6 | RouteId |  |
| 7 | RoomImpact |  |
| 8 | Flags |  |
| 9 | RoutePrefference |  |
| 10 | RoutePenalty |  |
| 11 | ObjectId |  |
| 12 | TargetId |  |
| 13 | WallPlacementFlags |  |
| 14 | SlotHierNumber |  |
| 15 | RepairState |  |
| 16 | LightSource |  |
| 17 | WalkStyle |  |
| 18 | SimAge |  |
| 19 | UnusedGender |  |
| 20 | TreeTableEntry |  |
| 21 | BirthMinutes |  |
| 22 | Speed |  |
| 23 | RotationNotches |  |
| 24 | BirthHour |  |
| 25 | LockoutCount |  |
| 26 | ParentId |  |
| 27 | Weight |  |
| 28 | SupportStrength |  |
| 29 | Room |  |
| 30 | RoomPlacement |  |
| 31 | PrepValue |  |
| 32 | CookValue |  |
| 33 | SurfaceValue |  |
| 34 | Hidden |  |
| 35 | Temperature |  |
| 36 | DisposeValue |  |
| 37 | WashDishValue |  |
| 38 | EatingSurfaceValue |  |
| 39 | DirtyLevel |  |

### 4 - stack object

Same as my object but against the object occupying the stack object in the stack frame.

### 5 - targ obj's (DO NOT USE)

Same as 2. Probably a leftover of an older more limited "stack object" system SimAntics used to use.

### 6 - Global ( from avatar )

Most likely accesses the global with the index specified. (from avatar) probably serves as a reminder that values can be different per player.

### 7 - literal

Numeric literal. Use the value in the data field.

### 8 - temps

Temporary registers. The data field is used as the index. The current assumption is that these are contextual to the thread but may be VM wide or related to stack objects.

### 9 - parameters

This refers to the arguments passed into a sub-routine call when the stack was pushed. The data field represents the parameter index.

### 10 - stack object id

This scope behaves more like a global. It allows you to reference or change the object occupying the stack object in the stack frame. For example, objects quite often in their init routine assign this to the My.objectId property.

### 11 - Temp[temp]

Accessing a temporary register with another temp as a pointer...? I've yet to see this used.

### 12 - check tree ad range

I wish I knew what this meant. Probably to do with the object's motive advertisements (might drive free will?).

### 13 - stack obj's temp

Accesses temp register of stack obj. See 8.

### 14 - my motives

Accesses motives. Still need to look into the number --> name relation.

### 15 - stack obj's motives

Same as above but for the stack object.

### 16 - stack object's slot

See 20.

### 17 - stack obj's motive[temp]

Accesses motives in a different way from 14, presumably using a temp variable (id as data passed) to select the motive.

### 18 - my person data

A similar idea to the built in fields, but there are 100 fields and they don't seem to be available on objects that are not people. Table of names coming shortly... (really we need a whole wiki for all of this)

### 19 - stack obj's person data

Same as above, but accesses the person data of the stack object instead.

### 20 - my slot

Slots are most likely positions that objects can be placed on top of, eg. a plate is placed in a slot owned by a counter, a sitting sim is placed in a slot owned by the chair, a stacked plate is placed in a slot owned by the plate below it... Used in chairs' "sit function" methods to presumably determine if the sim is already sitting in the seat (if they are then do nothing).

### 21 - stack objects definition

Refers to OBJD attributes for the stack object. The data value refers to the field ID. It is not yet clear if these indexes change depending on the OBJD version. If so index information will need to be persisted.

### 22 - stack object's attr[stack param]

Info pending

### 23 - room[temp 0]

Info pending

### 24 - neighbor in stack object

Info pending

### 25 - local

Local variables for the BHAV. When the stack is pushed the BHAV may alloc space for locals. The data field is the local index.

### 26 - stack object tuning

Tuning constants for the stack object. The most significant 9 bits of the data field are used to calculate the table ID as such: 4096 + (data >> 7). The first 7 bits of the data field are the tuning variable index. The values can be stored in either BCON or OTF tables.

### 27 - Dyn. Sprite Flag[temp] of Stack Object

Checks if one of the stack object's Dynamic Sprite Flags are set. Returns 1 for true and 0 for false.

### 28 - check tree ad personality var

Similar to 12, but with the personality advertisements instead (eg. used in behavior where neat sims are more likely to use the sink). Unsure of format, function or returned value for now.

### 29 - check tree ad min

Info pending

### 30 - my person data [temp]

Accesses the person data referenced by a temp register.

### 31 - stack obj's person data [temp]

Same as above but with the stack object.

### 32 - neighbor's person data

Accesses the person data of "neighbor". Not sure what this means at the moment.

### 33 - job data [temp 0, 1]

Info pending, probably not used in TSO in favor of OnlineJobs system

### 34 - neighborhood data

Codex doesn't even have control over this scope implemented, so definitely not sure.

### 35 - stack object's function

Probably returns the BHAV id of the function currently running in the stack object.

### 36 - my type attr

Info pending

### 37 - stack obj's type attr

Info pending
