# Niotso wiki snapshot — HOT

> Source: <http://wiki.niotso.org/HOT>  
> Snapshot: 2026-05-01. Cleaned from HTML.

| Type of format | Sound logic |
|---|---|
| Filename extension | `.hot` |
| First appeared | The Sims 1 |
**HOT** (short for **HIT Options Table**) is an ini format that defines event constants, hitlists, patches, tracks, and track-event pairs. In The Sims Online, HOT was replaced by various smaller formats (HLS, DBPF, EVT, TRK, and the HIT export table), and as a result the HOT files are not used ingame in The Sims Online; however, they are still required in The Sims 1.

In The Sims Online, its sections are:

-  **EventMappingEquate** - This section defines constants using the following syntax:

:  `Constant=Value`

-  **Options** - This section defines a Version (always 1) and a LoadPriority (perhaps 1 for highest, >1 for lower?)
-  **TrackData** - This section assigns a sound ID (or a patch ID in The Sims 1) or hitlist ID to a number of subroutines (exported or not) in the corresponding HIT file using the following syntax:

:  `SoundID=SubroutineAddress`

:  Note that the TrackData field is not needed in TSO because the TRK format has a Sound ID field and tracks are assigned subroutines by the HIT export table. However, TrackData appears in TSO's HOT files regardless.

**
In The Sims 1, HOT additionally contains the following sections:

-  GlobalHitList** (replaced by HLS in TSO) - This section defines hitlists using the same string format as used in the TSO HLS string format
-  **Patch** (not needed in TSO as sounds are given File IDs; in a way, replaced by DBPF) - This section defines patches using the following syntax:

:  `PatchID=0,PatchName,SoundLocation,Looped,Piano,0,0,0`

-  **EventMapping** (replaced by EVT in TSO) - This section defines track/event pairs using the following syntax:

:  `TrackEventName=Event,TrackID,0,0,0,0`

-  **Track** (replaced by TRK in TSO) - This section defines tracks using the following syntax, where the *Subroutine* and *TrackData* fields are HSM constants:

:  `TrackID=0,Subroutine,Volume,Arguments,DuckingPriority,ControlGroup,SoundPressureLevel,@HitlistID,PatchID`
