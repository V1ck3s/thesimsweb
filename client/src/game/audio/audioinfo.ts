/**
 * cAudioInfo: what the sound engine reads from the game (AudioInfo.cpp).
 * The original reaches into the app (cSimsApp +0x1c simulator, the object
 * module, GViewer, cRotatableWorld); here the lot side installs a source
 * with `setAudioInfo` (world/lotaudio... see main.ts) and clears it when the
 * lot unloads. Without a source every query answers like the original does
 * with no lot: no objects, lot 0, hour 0.
 */

/** cAudioWorldCoord: fixed-point world position (1/16 tile, unrotated) and level. */
export interface AudioWorldCoord {
  x: number;
  y: number;
  level: number;
}

/** cAudioScreenCoord: view pixels. */
export interface AudioScreenCoord {
  h: number;
  v: number;
}

export interface AudioInfoSource {
  /** cAudioInfo::GetLotNumber: simulator global 10 (house number). */
  lotNumber(): number;
  /** cAudioInfo::CurrentSimSpeed: cSimulator::GetSpeed (global 16). */
  simSpeed(): number;
  /** cAudioInfo::GetObjectPosition: object +0xf8 / +0xf4 / +0x110, or null when there is no such object. */
  objectPosition(id: number): AudioWorldCoord | null;
  /**
   * cAudioInfo::GetObjectData(id, index) (jump table lbl_10617180; the HIT
   * `getsrcdatafield` reads it through BoxxGlobalGetSourceParamValue):
   *  0 voice: person data 0x4a & 0xc -> 1000, age < 12 -> 2 (kid), else gender (0 m, 1 f);
   *  1 age (person data 0x3a); 4 the hour (simulator global 0, any id);
   *  2, 3, 5, 6, 7, 11, 12 person data 0xa, 9, 0xf, 0xb, 0xc, 0x11, 0x12 / 10;
   *  13 the area of the object's room (100 without one); 14 motive 3 / 10;
   *  15..20 person data 2..7 / 10; 8..10 and above 20: 0. No object: 0.
   */
  objectData(id: number, index: number): number;
  /** cAudioInfo::ConvertWorldToScreenCoords: cRotatableWorld::RotateCoords (0x400) then GViewer::TileToPoint. */
  worldToScreen(c: AudioWorldCoord): AudioScreenCoord;
  /** cAudioInfo::GetScreenBottomRight: GViewer::GetBuffDims (width, height). */
  screenBottomRight(): AudioScreenCoord;
  /** cAudioInfo::ViewerLevel: GViewer::GetLevel. */
  viewerLevel(): number;
  /** cAudioInfo::CurrentZoomLevel: GViewer::GetScale (1 far .. 3 near). */
  zoomLevel(): number;
  /** cAudioInfo::OutdoorTileRatio: percentage of outside tiles in view (0..100). */
  outdoorTileRatio(): number;
}

let source: AudioInfoSource | null = null;

export function setAudioInfo(s: AudioInfoSource | null): void {
  source = s;
}

/** GetAudioInfo */
export function getAudioInfo(): AudioInfoSource | null {
  return source;
}
