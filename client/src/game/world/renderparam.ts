/**
 * RenderParam (and its base RenderLoc): where the thing being drawn is, in
 * world fixed-point coordinates (1/16 tile, unrotated), its altitude, level,
 * the resulting screen position and the base depth its sprites are drawn at.
 *
 * Field map (RenderLoc floats): [0] x, [1] y, [2] z (altitude units),
 * [3] level, [4] screen x, [5] screen y; RenderParam +0x1c rotation * 2,
 * +0x20 scale, +0x24 depth row, +0x28 depth, +0x44 ZBufferLookup.
 */

import type { HouseViewer } from "./houseviewer.js";
import { RotatableWorld } from "./world.js";
import type { ZBufferLookup } from "./zbuffer.js";

export class RenderParam {
  x = 0;
  y = 0;
  z = 0;
  level = 1;
  sx = 0;
  sy = 0;
  /** +0x24: screen row the depth was taken at. */
  depthRow = 0;
  /** +0x28: base depth. */
  depth = 0;
  /** Ambient light level (1 = full; lighting is not ported yet). */
  ambient = 1;

  constructor(
    readonly viewer: HouseViewer,
    /** Compositor table index of ZSpriteLookup[0]. */
    readonly zLookupIndex: number,
  ) {}

  get scale(): number {
    return this.viewer.scale;
  }

  /** +0x1c: view rotation in 8-direction units. */
  get rotation2(): number {
    return this.viewer.world.rotation * 2;
  }

  get zbuf(): ZBufferLookup {
    return this.viewer.zbuf;
  }

  clone(): RenderParam {
    const r = new RenderParam(this.viewer, this.zLookupIndex);
    Object.assign(r, this);
    return r;
  }

  /**
   * RenderLoc::SetGridCoords(FTilePt, level, rp, alt = -1): altitude from
   * the terrain under the point when `alt` is -1.
   */
  setGridCoords(fx: number, fy: number, level: number, alt = -1): void {
    this.x = fx;
    this.y = fy;
    this.z = alt === -1 ? this.viewer.world.fixed.getFAlt(fx, fy) : alt;
    this.level = level;
    this.initializeScreenCoords();
  }

  /** RenderLoc::InitializeScreenCoords (full computation path). */
  initializeScreenCoords(): void {
    const v = this.viewer;
    const s = v.scale;
    const [rx, ry] = RotatableWorld.rotateCoords(Math.trunc(0.5 + this.x), Math.trunc(0.5 + this.y), v.world.rotation, 0x401);
    const altByte = Math.trunc(0.5 + this.z) & 0xff;
    const p = v.tileToPointF(rx, ry, this.level, s, altByte);
    this.sx = p.h;
    this.sy = p.v;
    this.finishTileZ();
  }

  /** RenderLoc::UpdateScreenCoords: after moving x/y/z (DGRP object offsets). */
  updateScreenCoords(): void {
    const v = this.viewer;
    const s = v.scale;
    const fx = Math.trunc(0.5 + this.x);
    const fy = Math.trunc(0.5 + this.y);
    const [rx, ry] = RotatableWorld.rotateCoords(fx, fy, v.world.rotation, 0x401);
    const p = v.tileToPointF(rx, ry, this.level, s, null);
    const ground = v.world.fixed.getFAlt(fx, fy);
    this.sx = p.h;
    this.sy = p.v - Math.trunc((this.z - ground) * (2 << s) + 0.5);
    this.finishTileZ();
  }

  private finishTileZ(): void {
    const s = this.viewer.scale;
    const lift = Math.trunc(this.z * (2 << s) + 0.5);
    // local_3c = lbl_105BBFD0[1] (3) * z * (1 / (2 sqrt 6)): the height in world units.
    const worldH = Math.fround(3 * this.z * Math.fround(1 / (2 * Math.sqrt(6))));
    this.computeTileZ(this.sy - (4 << s) + lift, worldH);
  }

  /** ZBufferLookup::ComputeTileZ. */
  computeTileZ(screenY: number, worldH: number): void {
    const v = this.viewer;
    const s = v.scale;
    const zb = v.zbuf;
    const lvl = (this.level - 1) * (LEVEL_PX_OF(s));
    const row = (4 << s) + lvl + screenY;
    this.depthRow = row - lvl;
    this.depth = zb.floorAt(s, row, v.originY) + (this.level - 1) * zb.levelZ.get(s)!;
    if (Math.abs(worldH) > 1e-6) {
      // dz = height in altitude units (lbl_105BC064[5] * h * 2 sqrt 6).
      const dz = Math.fround(Math.fround(1 / 3) * worldH * Math.fround(2 * Math.sqrt(6)));
      const fl = Math.floor(dz);
      const a0 = zb.altitude(s, fl);
      const a1 = zb.altitude(s, fl + 1);
      this.depth += a0 + Math.trunc((dz - fl) * (a1 - a0) + 0.5);
      this.depthRow -= Math.trunc(dz * (2 << s) + 0.5);
    }
  }
}

function LEVEL_PX_OF(s: number): number {
  return s === 3 ? 0xe8 : s === 2 ? 0x74 : 0x3a;
}
