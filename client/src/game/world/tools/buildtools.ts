/**
 * The build tools cGameTools creates (cGameTools::cGameTools), by tool id
 * (gametools.ts ToolId). Tool 7 (cMoveTool) is created by the lot view.
 */

import { ToolId, type ToolFactory } from "./gametools.js";
import { NewFloorTool } from "./floortool.js";
import { GrassTool } from "./grasstool.js";
import { LevelDirtTool } from "./leveldirttool.js";
import { SimpleAltTool } from "./simplealttool.js";
import { NewWallTool } from "./walltool.js";
import { NewWallpaperTool } from "./wallpapertool.js";

export const BUILD_TOOLS: Array<[number, ToolFactory]> = [
  [ToolId.DirtRaise, (h) => new SimpleAltTool(h, 1)],
  [ToolId.DirtLower, (h) => new SimpleAltTool(h, -1)],
  [ToolId.LevelDirt, (h) => new LevelDirtTool(h)],
  [ToolId.Grass, (h) => new GrassTool(h)],
  [ToolId.Wall, (h) => new NewWallTool(h)],
  [ToolId.Floor, (h) => new NewFloorTool(h)],
  [ToolId.Wallpaper, (h) => new NewWallpaperTool(h)],
];
