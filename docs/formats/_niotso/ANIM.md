# Niotso wiki snapshot — ANIM

> Source: <http://wiki.niotso.org/ANIM>  
> Snapshot: 2026-05-01. Cleaned from HTML.

| Type of format | Character rendering |
|---|---|
| Filename extension | `.anim` |
| Byte order | Big endian |
| Extended from | cmx.bcf |
| Type ID | 7 |
**Animations** (known as **skills** in The Sims 1) define the movement of the individual bones of a skeleton.

**
Animations follow the following format:

-  Version** - A 4-byte unsigned integer specifying the version number of this animation file; should be equal to 2
-  **Name** - A Pascal string with 2 string length bytes specifying the name of the animation contained in this file; should be the same as the filename but without the .anim extension
-  **Duration** - A 4-byte float in little-endian byte order specifying the duration of this animation in milliseconds
-  **Distance** - A 4-byte float in little-endian byte order specifying the distance to move the character while performing this animation
-  **Is moving** - One byte specifying whether or not this animation will move the character
-  **Translations count** - A 4-byte unsigned integer specifying the total number of translations described in this animation
-  **Translation data** - For each translation:

: -  **Translation** - X,Y,Z coordinates, each a 32-bit little-endian float, specifying new, *replacement* translation values for the bones of the skeleton. These values are stored absolute.

-  **Rotations count** - A 4-byte unsigned integer specifying the total number of rotations contained in this animation
-  **Rotation data** - For each rotation:

: -  **Rotation** - A normalized quaternion (called a "versor") consisting of X,Y,Z,W coordinates, each a 32-bit little-endian float, specifying new, *replacement* rotation values for the bones of the skeleton. These values are stored absolute. These values assume a left-handed coordinate system, meaning that for a right-handed coordinate system (like OpenGL and XNA), you have to mirror the quaternion by negating Y and Z.

-  **Motion count** - A 4-byte unsigned integer specifying the number of motions to follow

**
For each motion:

-  Unknown** - A 4-byte unsigned integer set to 1
-  **Bone name** - A Pascal string specifying the name of the bone to move; bones attached under this bone are *not* affected by the motion
-  **Frame count** - A 4-byte unsigned integer specifying the number of frames specified in this motion; should be the same for each motion
-  **Duration** - A 4-byte float in little-endian byte order specifying the duration of this motion in milliseconds; should be the same as the animation's overall duration and the same for each motion
-  **Has translation** - One byte specifying whether or not this motion has translation data
-  **Has rotation** - One byte specifying whether or not this motion has rotation data
-  **First translation index** - A 4-byte unsigned integer specifying the zero-based index of the first translation in *Translation data*; this is set to -1 if *Has translation* is 0
-  **First rotation index** - A 4-byte unsigned integer specifying the zero-based index of the first rotation in *Rotation data*; this is set to -1 if *Has rotation* is 0

:  Not all bones specify both rotation and translation data, so these two values can be different.

-  **Has props lists** - 1 byte. If set:

: -  **Props lists count** - A 4-byte unsigned integer specifying the number of props lists to follow
-  **Props lists** - For each props list:
-  **Props count** - A 4-byte unsigned integer specifying the number of props to follow
-  **Props** - For each prop:
-  **Pairs count** - A 4-byte unsigned integer specifying the number of Key/Value pairs to follow
-  **Key/Value pairs** - As many pairs as defined by the previous field. A pair is made up of a key Pascal string followed by a value Pascal string.

-  **Has time props lists** - 1 byte. If set:

: -  **Time props lists count** - A 4-byte unsigned integer specifying the number of time props lists to follow
-  **Time props lists** - For each time props list:
-  **Time props count** - A 4-byte unsigned integer specifying the number of time props in this time props list; should be 1
-  **Time props** - For each time prop:
-  **ID** - A 4-byte unsigned integer specifying the ID of this time prop; time props should be sorted by ID in ascending order
-  **Props list** - A props list (*not* time props list), as defined above

:  Note:
-  A TimePropsList can have any number of TimeProps
-  A TimeProp has an ID and exactly one PropsList
-  A PropsList can have any number of Props
-  A Prop can have any number of key/value pairs

 This totals to a 3-dimensional array.
