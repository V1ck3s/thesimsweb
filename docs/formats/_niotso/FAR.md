# Niotso wiki snapshot — FAR

> Source: <http://wiki.niotso.org/FAR>  
> Snapshot: 2026-05-01. Cleaned from HTML.

| Type of format | Archive |
|---|---|
| Filename extension | `.far, .dat` |
| Magic number | `FAR!byAZ` |
| Byte order | Little endian |
| First appeared | The Sims 1 |
**FAR** (**F**ile **Ar**chive) is an archive format made by Alex Zvenigorodsky of Maxis for The Sims. These files contain various asset data used by The Sims and The Sims Online, the only two games which have ever used this format. FAR has supported compression since its initial version in The Sims 1, but this feature was not used until The Sims Online.

Three versions of FAR have been used by these two games: version 1a, version 1b (it's assumed this was intended to be version 2), and version 3: The Sims 1 uses 1a, and The Sims Online uses 1b and 3.

## Contents

- 1 Header
- 2 File table
- 3 File table entry

3.1 FAR version 1a
- 3.2 FAR version 1b
- 3.3 FAR version 3

## Header

The FAR header follows this format:

-  **Magic number** - 8 bytes consisting of the ASCII characters "FAR!byAZ"
-  **Version** - A 4-byte unsigned integer specifying the version; 1a and 1b each specify 1
-  **File table offset** - A 4-byte unsigned integer specifying the offset to the file table from the beginning of the FAR file
## File table
-  **Number of files** - A 4-byte unsigned integer specifying the number of files in the archive
-  **File table entries** - As many file table entries as stated by the previous field
## File table entry
### FAR version 1a
-  **Decompressed data size** - A 4-byte unsigned integer specifying the uncompressed size of the file
-  **Compressed data size** - A 4-byte unsigned integer specifying the compressed size of the file; if this and the previous field are the same, the file is considered uncompressed. (It is the responsibility of the archiver to only store data compressed when its size is less than the size of the original data.) Note that The Sims 1 does not actually support any form of compression.
-  **Data offset** - A 4-byte unsigned integer specifying the offset of the file from the beginning of the archive
-  **Filename length** - A 4-byte unsigned integer specifying the length of the filename field that follows
-  **Filename** - The name of the archived file; size depends on the previous field
### FAR version 1b

Version 1b follows the same format as 1a, except *Filename length* is 2 bytes instead of 4 bytes.

### FAR version 3

For reference, the FARv3 reading function is located at TSOPersistD_base+0xdf15 in TSO New & Improved Trial.

-  **Decompressed data size** - A 4-byte unsigned integer specifying the uncompressed size of the file
-  **Compressed data size** - A 4-byte unsigned integer; if the most significant bit is set, then the file data is compressed in a little-endian Stream container, and the low 31 bits of this field specify the size of the Stream data; otherwise, the file data is uncompressed, and the low 31 bits should match those of the *Decompressed data size* field
-  **Data offset** - A 4-byte unsigned integer specifying the offset of the file from the beginning of the archive
-  **Flags** - A 2-byte unsigned integer; the meaning of this field is unknown. This field is always 0x0001 except in packingslips.dat, where this field is always 0x0000.
-  **Filename length** - A 2-byte unsigned integer specifying the length of the filename field
-  **Type ID** - A 4-byte ID identifying the type of the file (see List of Asset IDs)
-  **File ID** - A 4-byte ID assigned to the file which, together with the Type ID, should be unique all throughout the game
-  **File name** - The filename of the file; should be exactly *Filename length* bytes
