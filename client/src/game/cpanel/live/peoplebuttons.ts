/**
 * BuildPersonBtn (PeopleButtons.cpp): the family portrait button image that
 * PersonFinder::GetPictureBuffer hands to cWinPeople.
 *
 * The result is 4 x 3 cells of 45 x 45 (columns = button frames, rows = mood:
 * normal, happy, sad), on a transparent (magenta) background:
 *  - kPeopleTemplate (180 x 45, the four frames) is copied into each row;
 *  - the character's face picture (BMP_ 2002 of its object file: three faces
 *    side by side, one per mood) is cut in thirds; third `row` is copied at
 *    (5, 2) of every cell of that row, clipped to 35 x 41 (sinit values).
 *
 * The face is the hook for the 3D head the game renders into the character
 * file; without one the button shows the empty template frame.
 */

/** lbl_105BC1C0: cell size. */
const CELL = { w: 45, h: 45 };
/** lbl_105BC1D0: face top-left in a cell. */
const FACE_ORIGIN = { x: 5, y: 2 };
/** lbl_105BC1D8: face size. */
const FACE_SIZE = { w: 0x23, h: 0x29 };

export function buildPersonBtn(face: ImageBitmap | null | undefined, template: ImageBitmap): ImageBitmap {
  const canvas = new OffscreenCanvas(CELL.w * 4, CELL.h * 3);
  const g = canvas.getContext("2d")!;
  for (let row = 0; row < 3; row++) g.drawImage(template, 0, row * CELL.h);
  if (face) {
    const third = Math.trunc(face.width / 3);
    const w = Math.min(third, FACE_SIZE.w);
    const h = Math.min(face.height, FACE_SIZE.h);
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 4; col++) {
        const x = FACE_ORIGIN.x + col * CELL.w;
        const y = FACE_ORIGIN.y + row * CELL.h;
        g.drawImage(face, row * third, 0, w, h, x, y, w, h);
      }
    }
  }
  return canvas.transferToImageBitmap();
}
