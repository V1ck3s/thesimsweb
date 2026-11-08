/**
 * WinLotView: the lot view window (cDDDSimsView's HouseViewer area). Loads a
 * house file, owns the HouseViewer and its WebGL compositor, paints the
 * rendered view into the 2D game canvas under the control panel, and
 * implements the CPState viewer hooks (zoom, rotation, level, walls).
 *
 * Input follows EdgeDetectScroller: arrow keys scroll by one tile width
 * horizontally / half a tile width vertically (AsyncScroll), a right click
 * centers the view on the clicked tile (CenterView), a right drag scrolls
 * around an anchor (OnMouseDownR / OnMouseMove / OnMouseUpR).
 */

import { PauseText } from "../ui/pausetext.js";
import { computeCameraFrame, drawCameraFrame, takeAsyncSnapshot, takeCameraSnapshot } from "../cpanel/camsnapshot.js";
import { characterAfterTool, characterBeforeTool, modeKeyDown, viewKeyDown } from "../cpanel/modekeys.js";
import { WinCPanel } from "../cpanel/cpanel.js";
import type { GameContext } from "../context.js";
import { soundPlayer, UI_SOURCE } from "../audio/index.js";
import { getOptionsMgr, type OptionsMgr } from "../optionsmgr.js";
import { ArchTool, DIRTY_ARCH_SUBTOOL, DIRTY_ARCH_TOOL, DIRTY_ARCH_UNDO, DIRTY_LEVEL, DIRTY_SHOP_ITEM, Mode, WallState, type CPState, type HouseViewerHooks } from "../cpstate.js";
import { DefaultTTWindow } from "../ui/ttwindow.js";
import { Gfx, type Rect, TSWin, WF_GLOBAL_CURSOR } from "../ui/tswin.js";
import { Compositor } from "./compositor.js";
import { DynamicCutaway } from "./cutaway.js";
import { EdgeDetectScroller } from "./edgescroll.js";
import { FloorGraphicsMgr } from "./floors.js";
import { HouseViewer, type ObjectDrawer, type TerrainDrawer, type WallDrawer } from "./houseviewer.js";
import { ResFile } from "./iffres.js";
import { customWallStyleOf, loadLotObjectDrawer, type LotObjects } from "./lotobjects.js";
import type { DrawableObject } from "./objectdraw.js";
import { RenderParam as RenderParamImpl, type RenderParam } from "./renderparam.js";
import { LotPeople } from "./lotpeople.js";
import { loadRoomScoreConstants, RoomLighting, timeOfDay } from "./lighting.js";
import { loadRoofSettings, makeArchRoofHooks, roofLayersOf } from "./roofs.js";
import { computeRooms, RoomManager } from "./rooms.js";
import { houseNumberOfPath, Terrain } from "./terrain.js";
import { WallManager } from "./walls.js";
import { CursorDrawer, GUID_TILE_CURSOR } from "./tools/cursorobject.js";
import { BUILD_TOOLS } from "./tools/buildtools.js";
import { GameTools, MoveToolAdapter, ToolId } from "./tools/gametools.js";
import { MoveMode, MoveTool } from "./tools/movetool.js";
import { ToolSounds, type ToolHost } from "./tools/tool.js";
import { UndoManager } from "./tools/undo.js";
import { Placement, type ObjectBehaviorHooks } from "./tools/placement.js";
import { FixedWorld, RotatableWorld } from "./world.js";
import type { PlacedObject, XObject } from "./objects.js";
import { getTrackedObject, setTrackedObject, setTrackingDispatch, stopTracking, trackPerson } from "./tracking.js";
import type { ObjSelector } from "./objselector.js";
import { G, Simulator } from "../sim/simulator.js";
import { animSoundEnv } from "../sim/animsound.js";
import { tryUnloadSkills } from "../sim/personanim.js";
import type { WorldHooks } from "../sim/simmodule.js";
import { SimObject } from "../sim/xobject.js";
import { EP, ObjFnTable } from "../sim/objfntable.js";
import type { MenuItem, PersonSim } from "../sim/person.js";
import { PDX } from "../sim/person.js";
import { buildPersonBtn } from "../cpanel/live/peoplebuttons.js";
import { CMD_PIE_CANCEL, CMD_PIE_CHAR, CMD_PIE_HILITE, CMD_PIE_PICK, TSPieMenu } from "../ui/piemenu.js";
import {
  getPopupHeadLocation,
  nodPopupHead,
  renderPopupHead,
  renderRoundShadow,
  setPopupHeadAttitude,
  startPopupHead,
  startPopupHeadSubmenu,
  stopPopupHead,
  stopPopupHeadSubmenu,
} from "../sims/popuphead.js";
import { winMgr } from "../ui/winmgr.js";
import { getCursor } from "../ui/cursor.js";
import { objectScreenRect, pointToObjectId, PickMode } from "./tools/picking.js";
import { ActionIcons } from "./actionicons.js";
import { BalloonPainter, loadBalloonSprites } from "./balloons.js";
import { WinPictureInPicture } from "./winpictureinpicture.js";
import { killObject, makeNewOutOfWorldObject } from "./tools/objectfactory.js";
import { updateSimObjects } from "./simobjects.js";
import { PlumbBobs } from "./plumbbobs.js";
import { GiftsPanel } from "../cpanel/live/gifts.js";
import { WinBudgetDlg } from "../cpanel/budgetdlg.js";
import { WinViewControl } from "../cpanel/viewcontrol.js";
import { loadBuildCatalog } from "../data/buildcatalog.js";
import { shareSimulationNeighborhood } from "../data/family.js";
import { holdSimulator } from "../nbhd/transit.js";
import { hideTutorialHighlighter, tutCheckForEvents, tutFlashButtonByImageID, tutFlashWindow, type TutEventSource } from "../ui/tutorialhighlight.js";
import { setTutorialIcon, TutorialIcon } from "../ui/tutorialicon.js";
import { cancelTutorial, makeTutorialObject, tutorialCompleted } from "../nbhd/tutorial.js";
import { findPeoplePopup, findPersonPanelButton } from "../cpanel/people.js";
import { findRelButton } from "../cpanel/live/relationship.js";
import { moduleOrder } from "./housesave.js";
import { clearLayoutHistory, getHouseStats, piecewiseFromText, readLayoutHistory, STR_HOUSE_SCORE_CURVES, summarizeHouseStats, type ArchPrices, type HousePageStats, type PiecewiseFn } from "./housestats.js";
import { loadStringSet } from "../sim/behavior.js";

/** ObjectModule::ShowTutorialInfo's tree (lbl_105BBA30 + 0x72). */
const SHOW_SITUATION_INFO = "show situation info";
/** lbl_105BA7B0 (__sinit_CPState): the smallest camera photo, the auto snapshot's minimum size. */
const SNAPSHOT_MIN = { w: 200, h: 0x96 };
/** NeighborhoodConstants "new family start hour" (lbl_105BA1E0, default 7). */
const NEW_FAMILY_START_HOUR = 7;
/** NeighborhoodConstants "architecture value multiplier" (lbl_105BA1EC, default 0.7). */
const ARCHITECTURE_VALUE_MULTIPLIER = Math.fround(0.7);

/** HOUS chunk id 0: HouseViewer::DoStream (saved camera). */
interface SavedView {
  /** +0x48 (walls down) and +0x49 (dynamic cutaway; cleared when +0x48 is set). */
  cutaway: boolean;
  dynamicCutaway: boolean;
  scale: number;
  originX: number;
  originY: number;
  rotation: number;
  level: number;
  drawRoof: boolean;
}

function readSavedView(house: ResFile): SavedView | null {
  const b = house.get("HOUS", 0);
  if (!b || b.length < 28) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const version = v.getInt32(4, true);
  let p = 12;
  const cut = v.getUint32(p, true);
  const scale = v.getInt32(p + 4, true);
  const originX = v.getInt32(p + 8, true);
  const originY = v.getInt32(p + 12, true);
  p += 16;
  let rotation = 0;
  let level = 1;
  let drawRoof = false;
  if (version > 8) {
    rotation = v.getInt16(p, true);
    p += 2;
  }
  if (version >= 0x1d) {
    level = v.getInt16(p, true);
    p += 2;
  }
  if (version > 0x29) drawRoof = v.getInt16(p, true) !== 0;
  const cutaway = cut >> 8 !== 0;
  return { cutaway, dynamicCutaway: !cutaway && (cut & 0xff) !== 0, scale, originX, originY, rotation, level, drawRoof };
}

/**
 * Lot size: simulator global 23 (cSimulator+0x3e), saved in the SIMI chunk
 * as 16-bit globals from offset 12 (House::LoadFile; 0 means 64).
 */
export function readLotSize(house: ResFile): number {
  const b = house.get("SIMI", 1) ?? house.list("SIMI").map((c) => house.payload(c))[0];
  if (!b || b.length < 12 + 24 * 2) return 64;
  const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getInt16(12 + 23 * 2, true);
  return n > 3 && n <= 64 ? n : 64;
}

export interface LotViewParts {
  terrain?: TerrainDrawer;
  walls?: WallDrawer;
  objects?: ObjectDrawer;
}

export class WinLotView extends TSWin implements HouseViewerHooks {
  viewer: HouseViewer | null = null;
  house: ResFile | null = null;
  private frame: OffscreenCanvas | null = null;
  /** `frame` is older than the last render. */
  private frameStale = false;
  private edge: EdgeDetectScroller | null = null;
  /** cDDDSimsView+0x14c: kExploreAnchor; +0x150 / +0x160: where it shows while right-dragging (SetAnchorPoint). */
  private exploreAnchor: ImageBitmap | null = null;
  private anchor: { x: number; y: number } | null = null;
  /** The wall graph when this view created it (no `parts.walls`). */
  wallManager: WallManager | null = null;
  /** The lot objects when this view loaded them (no `parts.objects`). */
  lotObjects: LotObjects | null = null;
  people: LotPeople | null = null;
  /** The SimAntics simulator ticking the lot's objects (sim/simulator.ts); people are not ticked yet. */
  sim: Simulator | null = null;
  /** Rooms and the dynamic cutaway (only with the view's own wall graph). */
  rooms: RoomManager | null = null;
  cutaway: DynamicCutaway | null = null;
  lighting: RoomLighting | null = null;
  /** The terrain when this view created it (relit with the time of day; the thumbnails switch it to daytime). */
  terrain: Terrain | null = null;
  /** Last mouse position over the view (the dynamic cutaway reads the cursor). */
  private cursor: { x: number; y: number } | null = null;
  /** Buy mode: cGameTools' cMoveTool, its placement rules and the tip it shows (cDDDSimsView::SetTip). */
  buyTool: MoveTool | null = null;
  /** Buy / build commands submitted, undone or redone (the save's dirty test). */
  editCount = 0;
  placement: Placement | null = null;
  /** ObjectModule's plumb bobs (the selected person's diamond, the date and star bobs). */
  plumbBobs: PlumbBobs | null = null;
  private tip: { win: DefaultTTWindow; x: number; y: number; text: string } | null = null;
  private tipWin: DefaultTTWindow | null = null;
  private buttonDown = false;
  private shift = false;
  private ctrl = false;
  /** cGameTools (buy and build tools). */
  gameTools: GameTools | null = null;
  private readonly onModifiers = (e: KeyboardEvent | PointerEvent): void => {
    this.shift = e.shiftKey;
    this.ctrl = e.ctrlKey;
    if (e.type === "keyup" && e instanceof KeyboardEvent) this.activeTools()?.keyUp(e.key);
  };
  /** CPState listeners registered by init, removed by shutdown. */
  private readonly listeners: Array<(s: CPState) => void> = [];

  constructor(
    private readonly ctx: GameContext,
    /** House file relative to the game folder. */
    readonly housePath: string,
    private readonly parts: LotViewParts = {},
  ) {
    super();
    this.actionIcons = new ActionIcons(ctx, this);
    // cSimsApp::WindowSetup: SetFlag(0x20000), unforced global cursors (the scroller's) show over the view.
    this.setFlag(WF_GLOBAL_CURSOR, true);
  }

  override async init(): Promise<boolean> {
    const house = await ResFile.open(this.housePath);
    this.house = house;
    const world = new RotatableWorld(FixedWorld.load(house, readLotSize(house)));
    const floors = new FloorGraphicsMgr();
    await floors.initialize();
    await floors.loadUsageMap(house, world.fixed);
    // cAnimDeviceSub::NewWorld sizes the 3D viewport to (width, height - 100)
    // (the whole height with the port's centred HUD: the view shows beside the panel).
    const viewW = this.ctx.width;
    this.pipRight = this.ctx.hud?.right ?? viewW;
    this.hudLeft = this.ctx.hud?.left ?? 0;
    const viewH = this.hudBeside() ? this.ctx.height : this.ctx.height - 100;
    const comp = new Compositor(viewW, viewH);
    const v = new HouseViewer(world, comp, floors, viewW, viewH);
    v.isBuildMode = () => this.ctx.state.getMode() === Mode.Build;
    if (this.parts.terrain) {
      v.terrain = this.parts.terrain;
    } else {
      const terrain = Terrain.create();
      // Terrain pixels carry GetTerrainZ(tile, clamped) + 0x50 (cColorSwatch blitters).
      terrain.terrainZ = (x, y) => Math.min(0xffff, Math.max(0, v.getTerrainZ(x, y)));
      // CPState hides the terrain grid overlay in live (2) and camera (4) modes.
      let shown: boolean | null = null;
      const syncOverlay = (): void => {
        const m = this.ctx.state.getMode();
        const on = m !== Mode.Live && m !== Mode.Camera;
        if (on === shown) return;
        shown = on;
        terrain.showOverlay(on);
        v.dirty = true;
      };
      syncOverlay();
      this.listen(syncOverlay);
      v.terrain = terrain;
      this.terrain = terrain;
    }
    if (this.parts.walls) {
      v.walls = this.parts.walls;
    } else {
      const walls = await WallManager.create(house, world);
      const st = this.ctx.state;
      walls.setWallState(st.getWallState());
      // CPState::ShouldAlwaysShowWallStuff: build mode with the door or window tool.
      const wallStuff = (): boolean => {
        const t = st.archGetCurrentTool();
        return t === ArchTool.Door || t === ArchTool.Window;
      };
      walls.mode = st.getMode();
      walls.wallToolActive = wallStuff();
      this.listen(() => {
        if (walls.mode === st.getMode() && walls.wallToolActive === wallStuff()) return;
        walls.mode = st.getMode();
        walls.wallToolActive = wallStuff();
        // Wall::Draw and RenderStaticRow's grid read the mode and the tool: a
        // switch with nothing else changing (Buy <-> Build) must still redraw.
        v.dirty = true;
      });
      this.wallManager = walls;
      v.walls = walls;
    }
    if (this.parts.objects) {
      v.objects = this.parts.objects;
    } else {
      this.lotObjects = await loadLotObjectDrawer(house, world.fixed);
      v.objects = this.lotObjects.drawer;
      this.people = await LotPeople.load(comp, this.housePath.split("/")[0] ?? "UserData", this.lotObjects.objects.values());
      v.people = this.people;
      // cXPerson::DrawIso's sprite slots (balloons, headlines), drawn into the world after the people.
      v.spriteSlots = {
        draw: (viewer, comp) => {
          if (!this.sim || !this.people) return;
          const sel = this.selectedPerson()?.obj ?? null;
          this.balloons ??= new BalloonPainter(this.ctx);
          this.balloons.draw(comp, { viewer, people: this.people, module: this.sim.module, isSelected: (o) => o === sel });
        },
      };
      this.lotObjects.drawer.placeHeld = (d, rp) => this.placeHeld(d, rp);
      await loadBalloonSprites();
      // `?nosim` keeps the lot static (debug comparison).
      if (!new URLSearchParams(location.search).has("nosim")) await this.initSimulator(house, this.lotObjects, world.fixed);
    }
    // HouseViewer::DoStream's roof settings; DiscoverTilesToRoof's stairs test reads the objects.
    loadRoofSettings(house);
    roofLayersOf(world.fixed).objects = () => this.lotObjects?.objects ?? null;
    const saved = readSavedView(house);
    if (saved) {
      world.setRotation(saved.rotation);
      v.buildMaxAltsTable();
      v.scale = saved.scale >= 1 && saved.scale <= 3 ? saved.scale : 3;
      v.level = saved.level || 1;
      v.cutaway = saved.cutaway;
      v.drawRoof = saved.drawRoof;
      v.setOffsets(saved.originX, saved.originY);
      // House::LoadFile: DoStream's flags are the view's wall state; GlobalDispatch(0xe8)
      // then makes CPState::UpdateCPStateFromWorld set the button from them
      // (cutaway 2, else dynamic cutaway 4, else roof 8, else 1), without pushing it back.
      const walls = this.wallManager;
      if (walls) {
        walls.cutaway = saved.cutaway;
        walls.dynamicCutaway = saved.dynamicCutaway;
        walls.drawRoof = saved.drawRoof;
        const state = saved.cutaway ? WallState.Down : saved.dynamicCutaway ? WallState.Cutaway : saved.drawRoof ? WallState.Roof : WallState.Up;
        this.ctx.state.setWallStateFromWorld(state);
      }
    } else {
      v.setOffsets(0, 0);
    }
    this.viewer = v;
    if (this.wallManager) this.initCutaway(v, this.wallManager);
    if (this.lotObjects) await this.initBuyTool(v, this.lotObjects);
    // Neighborhood::LoadHouse: ObjectModule::PostLoad (Load / Init trees) runs in the built
    // world, so objects made there (the vacation NPC controller's staff) are placed.
    try {
      this.sim?.postLoad();
    } catch (e) {
      console.error("[sim] post load failed", e);
    }
    // ObjectModule::Load -> UpdateSimObjects: the controllers / phone plugins every lot holds.
    if (this.lotObjects && this.sim && this.placement) await updateSimObjects(this.placement, this.lotObjects.folder, this.sim.module);
    // Neighborhood::LoadHouse: the Tutorial object on a tutorial lot (nbhd/tutorial.ts).
    if (this.lotObjects && this.sim && this.placement) await makeTutorialObject(this.placement, this.lotObjects.folder, this.sim.module, this.housePath.split("/")[0] ?? "UserData");
    if (this.moveIn && this.lotObjects && this.sim) await this.resetLotForMoveIn(this.lotObjects, this.moveIn);
    // Neighborhood::LoadHouse, after the person pass: BroadcastMessage("import lot", 0)
    // (lbl_105BB990 + 0x13e) when the house file holds EXPi resources (a lot that came with an imported family).
    if (this.sim && house.count("EXPi") > 0) this.sim.module.broadcastMessage("import lot", 0);
    if (this.lotObjects && this.sim) await this.bringInFamily(v, this.lotObjects);
    if (this.lotObjects && this.sim && this.placement) await this.initPlumbBobs(this.lotObjects, this.sim, this.placement);
    this.exploreAnchor = await this.ctx.res.image("kExploreAnchor");
    this.edge = new EdgeDetectScroller(v, this.ctx.width, this.ctx.height, {
      setAnchor: (p) => {
        this.anchor = p;
        v.dirty = true;
      },
      setCursor: (id) => winMgr.setGlobalCursor(id === null ? null : getCursor(id), false),
    });
    const st = this.ctx.state;
    st.viewer = this;
    st.setZoom(v.scale);
    st.setRotation(world.rotation);
    st.setLevel(v.level);
    // cDDDSimsView::Init's pause text (+0x178 / +0x17c).
    await PauseText.attach(this.ctx, this);
    return true;
  }

  /** House load: cFixedWorld::ComputeRooms(0), RoomManager::ComputeCutaway(0), then the dynamic cutaway. */
  private initCutaway(v: HouseViewer, walls: WallManager): void {
    const fixed = v.world.fixed;
    const rooms = new RoomManager(fixed);
    computeRooms(fixed, rooms);
    rooms.computeCutaway(v, 0);
    const st = this.ctx.state;
    this.syncSecondLevel(st);
    const cut = new DynamicCutaway(v, walls, rooms, {
      mode: () => st.getMode(),
      selectedPerson: () => {
        const guid = st.personGetSelected()?.guid;
        const objs = this.lotObjects?.objects;
        if (guid === undefined || !objs) return null;
        for (const o of objs.values()) if (o.isPerson && o.guid === guid && o.hidden === 0) return { x: o.tileX, y: o.tileY, level: o.level };
        return null;
      },
      trackedPerson: () => {
        const o = getTrackedObject();
        if (!o) return undefined;
        return o.isPerson ? { x: o.tileX, y: o.tileY, level: o.level } : null;
      },
      cursor: () => this.cursor,
      tool: () => {
        const t = this.gameTools;
        return t?.current === t?.moveTool ? this.buyTool : (t?.current ?? null);
      },
    });
    this.rooms = rooms;
    this.cutaway = cut;
    // Animator::SetTrackedObject's GlobalDispatch(0xf7).
    setTrackingDispatch(() => cut.onTrackedChanged());
    if (this.lotObjects) {
      this.lotObjects.drawer.cutawayView = walls;
      walls.customWallStyle = customWallStyleOf(this.lotObjects, fixed);
    }
    // Room lighting follows the time of day (cSimulator global 4).
    const lighting = new RoomLighting(rooms, v.world, () => this.lotObjects?.objects ?? null);
    // ComputeRooms' SetGlobal(0x1b, the inside rooms' area).
    lighting.onInsideArea = (area) => {
      if (this.sim) this.sim.globals[0x1b] = area;
    };
    const phase0 = timeOfDay(st.getTime().hour);
    lighting.compute(phase0);
    // Neighborhood::LoadHouse's cTerrain::SetColor (the lot's ground colors by house number);
    // cSimulator::SetCurrentHour -> GlobalDispatch(0xdd): the terrain is relit too.
    this.terrain?.setColor(houseNumberOfPath(this.housePath), phase0);
    this.terrain?.setLatitudeByTimeOfDay(phase0);
    this.lighting = lighting;
    v.lighting = lighting;

    v.cutawayCtl = cut;
    let mode = st.getMode();
    let sel = st.selectedIndex();
    this.listen(() => {
      if (st.getMode() === mode && st.selectedIndex() === sel) return;
      // CPState::UpdateWorldFromCPState: entering options (3) or camera (4) mode puts the arrow back.
      if (st.getMode() !== mode && (st.getMode() === Mode.Options || st.getMode() === Mode.Camera)) this.setToolCursor(0);
      mode = st.getMode();
      sel = st.selectedIndex();
      // Leaving live mode deselects its tool: cObjPickerTool::Deselect -> SetHiliteObject(0).
      if (mode !== Mode.Live) this.setHiliteObject(0, null);
      cut.onModeChange();
    });
    cut.doDynamicCutaway(false);
  }

  /**
   * Buy mode's tool (cGameTools tool 7, cMoveTool): the hand, or the catalog
   * product being placed (CPState's shop item -> SetParameter).
   */
  private async initBuyTool(v: HouseViewer, lot: LotObjects): Promise<void> {
    const cursorSel = await lot.folder.getSelectorByGUID(GUID_TILE_CURSOR);
    if (!cursorSel) return;
    this.tipWin = await DefaultTTWindow.create(this.ctx.fonts);
    const st = this.ctx.state;
    const p = new Placement(lot.module, v.world.fixed, this.simHooks(), () => v.level);
    const drawer = new CursorDrawer(p);
    const tool = new MoveTool({
      viewer: v,
      placement: p,
      folder: lot.folder,
      cursorSelector: cursorSel,
      renderer: (res) => lot.renderer(res),
      personRect: (o) => this.people?.screenRect(o, v) ?? null,
      modeFreeze: () => this.sim?.globals[G.modeFreeze] ?? 1,
      // cSimulator::GetFunds / Spend (expense type 6, "furnishings") when the simulator runs.
      tutorialLot: () => (this.sim?.globals[26] ?? 0) !== 0,
      getFunds: () => this.sim?.getFunds() ?? st.getFunds(),
      spend: (n, expense = 6) => {
        if (this.sim) this.sim.spend(expense, n);
        else st.setFunds(st.getFunds() - n);
      },
      shopSoldItem: () => st.shopSoldItem(),
      startDisposing: (item) => st.startDisposing(item),
      stopDisposing: () => st.stopDisposing(),
      setTip: (x, y, text) => {
        if (this.tipWin) this.tip = { win: this.tipWin, x, y, text };
      },
      resetTip: () => {
        this.tip = null;
      },
      // UIText STR# 137 "PlacementErrs".
      placementErrorText: (code) => this.ctx.strings.get("UIText", 137, code - 1),
      // cSoundPlayer::PlayBySource(event, -4): UI_object_place, UI_buy_moneyback, UI_error, ...
      playSound: (event) => {
        soundPlayer.playBySource(event);
      },
      shiftDown: () => this.shift,
      ctrlDown: () => this.ctrl,
      setToolCursor: (id) => this.setToolCursor(id),
      // FixFloorForStairs: CPState::ArchGetCurrentFloorStyle, then GlobalDispatch(0x91, 0) on Release.
      currentFloorStyle: () => st.archGetCurrentFloorStyle(),
      computeRooms: () => {
        this.wallsChanged(1);
        this.wallsChanged(2);
      },
      invalidate: () => {
        v.dirty = true;
        const c = tool.cursor;
        drawer.cursor = c;
      },
    });
    this.placement = p;
    this.buyTool = tool;
    // CPState::DoDispose: the dispose popup sells through the current tool when it is the buy tool.
    st.disposeTool = () => tool.doDispose();
    const tools = this.initGameTools(v, lot, p, tool);
    // CPState::UpdateWorldFromCPState: the build panel's sub-tool picked inside CPState::Update.
    st.worldUpdateHook = (bits) => {
      if (!st.cheatToolActive && st.getMode() === Mode.Build && bits & (DIRTY_ARCH_TOOL | DIRTY_ARCH_SUBTOOL)) {
        tools.archSetCurrentTool(st.archGetCurrentTool(), st.archGetCurrentSubtool());
      }
    };
    v.cursor = {
      draw: (viewer, comp, rp) => {
        drawer.draw(viewer, comp, rp);
        tools.drawOverlay(viewer, comp, rp);
      },
    };
    window.addEventListener("keydown", this.onModifiers);
    window.addEventListener("keyup", this.onModifiers);
    window.addEventListener("pointermove", this.onModifiers);
    let guid: number | null = null;
    let mode: Mode | null = null;
    let pending = 0;
    // CPState::SetMode -> SetCurrentToolByID: buy mode's hand, build mode's arch tool, no tool elsewhere
    // (leaving puts a held object back: the tool's Cancel).
    const selectModeTool = (): void => {
      if (mode === Mode.Buy) {
        tools.setCurrentToolByID(ToolId.Move, -1);
        tool.setParameter(null);
      } else if (mode === Mode.Build) {
        tools.archSetCurrentTool(st.archGetCurrentTool(), st.archGetCurrentSubtool());
      } else {
        tools.current?.cancel();
        tools.issueToolSelection(null);
      }
    };
    // CPState::SetCheatTool: the cheat tool replaces the current one; once it is
    // gone, UpdateWorldFromCPState gives the mode's tool back.
    st.setCheatToolHook = (id) => {
      if (id === null) selectModeTool();
      else tools.issueToolSelection(tools.getToolByID(id));
    };
    this.listen(() => {
      if (st.getMode() !== mode) {
        const prev = mode;
        mode = st.getMode();
        guid = null;
        // UpdateWorldFromCPState leaves a cheat tool in place.
        if (!st.cheatToolActive) selectModeTool();
        // CPState::SetMode: leaving any mode but live flushes the undo lists (UndoManager::FlushCommandQueues).
        if (prev !== null && prev !== Mode.Live) tools.undo.flushCommandQueues();
      } else if (!st.cheatToolActive && mode === Mode.Build && st.dirty & (DIRTY_ARCH_TOOL | DIRTY_ARCH_SUBTOOL)) {
        tools.archSetCurrentTool(st.archGetCurrentTool(), st.archGetCurrentSubtool());
      }
      if (mode !== Mode.Buy || st.cheatToolActive) return;
      const product = st.shopGetCatalogItem();
      const g = product?.guid ?? null;
      // A click on the catalog sets the shop item again (DIRTY_SHOP_ITEM), even the same product.
      if (g === guid && !(st.dirty & DIRTY_SHOP_ITEM && g !== null)) return;
      guid = g;
      const ticket = ++pending;
      if (g === null) {
        // UpdateWorldFromCPState hands the tool its parameter again: the
        // catalog item is gone. Also after a sale (ShopSoldItem, newPurchase
        // already cleared): the tool must leave Buy (mode 2), or the next
        // click with nothing in hand plays the purchase sound (Release's
        // UI_object_place). A lot object held by the hand is left alone.
        if (tool.newPurchase || tool.mode === MoveMode.Buy) tool.setParameter(null);
        return;
      }
      void this.selectorForPurchase(lot, g).then((sel) => {
        if (ticket !== pending) return;
        tool.setParameter(sel);
        // The mouse is already over the lot: OnEnterWorld right away.
        if (this.cursor) {
          tool.onEnterWorld();
          tool.float(this.cursor.x, this.cursor.y);
        }
      });
    });
  }

  /** ObjectFolder::GetSelectorByGUID, with the object's semi-global file opened before its init tree runs. */
  private async selectorForPurchase(lot: LotObjects, guid: number): Promise<ObjSelector | null> {
    const sel = await lot.folder.getSelectorByGUID(guid);
    if (sel) await this.sim?.module.res.prepare([sel]);
    return sel;
  }

  /**
   * cGameTools: the build tools around the buy tool, their host (funds,
   * sounds, tips, world refreshes) and the undo manager behind CPState's
   * ArchUndo / ArchRedo.
   */
  private initGameTools(v: HouseViewer, lot: LotObjects, p: Placement, move: MoveTool): GameTools {
    const st = this.ctx.state;
    const undo = new UndoManager();
    const host: ToolHost = {
      ctx: this.ctx,
      state: st,
      viewer: v,
      world: v.world,
      fixed: v.world.fixed,
      walls: this.wallManager,
      rooms: this.rooms,
      lot,
      placement: p,
      undo,
      dirty: {
        walls: (level) => this.wallsChanged(level),
        wallsPreview: (level) => {
          this.wallManager?.rebuildFromMap(level);
          v.dirty = true;
        },
        floors: () => {
          v.dirty = true;
        },
        terrain: () => {
          this.terrain?.markDirty();
          v.buildMaxAltsTable();
          v.dirty = true;
        },
      },
      getFunds: () => this.sim?.getFunds() ?? st.getFunds(),
      spend: (expense, n) => {
        if (this.sim) this.sim.spend(expense, n);
        else st.setFunds(st.getFunds() - n);
      },
      playSound: (event) => {
        soundPlayer.playBySource(event);
      },
      setTip: (x, y, text) => {
        if (this.tipWin) this.tip = { win: this.tipWin, x, y, text };
      },
      resetTip: () => {
        this.tip = null;
      },
      getString: (file, id, index) => this.ctx.strings.get(file, id, index),
      keys: () => ({ shift: this.shift, ctrl: this.ctrl }),
      mouse: () => this.cursor ?? { x: 0, y: 0 },
      setToolCursor: (id) => this.setToolCursor(id),
      invalidate: () => {
        v.dirty = true;
      },
    };
    const tools = new GameTools(host, new MoveToolAdapter(host, move), (g) => this.selectorForPurchase(lot, g));
    move.undoManager = undo;
    for (const [id, make] of BUILD_TOOLS) tools.tools[id] = make(host);
    undo.onChange = () => {
      this.editCount++;
      st.setDirty(DIRTY_ARCH_UNDO);
    };
    // cWinRoofPanel's cRoofLayer::SetPitch / SetRoofPattern, each a cRoofUndoable.
    st.archRoofHooks = makeArchRoofHooks(undo, () => {
      v.dirty = true;
    });
    // cWinCatalog::SetProduct on a product the family cannot afford.
    st.placementToolDeniedSound = () => tools.getToolByID(ToolId.Move)?.doDeniedSound();
    st.archUndoHooks = {
      undo: () => undo.undoLastCommand(),
      redo: () => undo.redoLastCommand(),
      canUndo: () => undo.canUndo(),
      canRedo: () => undo.canRedo(),
    };
    // cXPortal::ApplyWallStyle / Pickup: a door or window changed its wall.
    p.onWallsChanged = (level) => this.wallsChanged(level);
    this.gameTools = tools;
    return tools;
  }

  /**
   * CPState::HasBeenTo2ndLevel / Is2ndLevelFloorable read cFixedWorld+0x80 /
   * +0x81 (set by ComputeRooms); cWinViewControl enables the level 2 button from them.
   */
  private syncSecondLevel(st: CPState): void {
    const fixed = this.viewer?.world.fixed;
    if (!fixed) return;
    if (st.beenTo2ndLevel === fixed.beenTo2ndLevel && st.secondLevelFloorable === fixed.secondLevelFloorable) return;
    st.beenTo2ndLevel = fixed.beenTo2ndLevel;
    st.secondLevelFloorable = fixed.secondLevelFloorable;
    st.setDirty(DIRTY_LEVEL);
  }

  /**
   * Walls changed on a level (WallManager::AsynchronousRebuild, then the
   * rooms (cFixedWorld::ComputeRooms), their cutaway and lighting).
   */
  wallsChanged(level: number): void {
    const v = this.viewer;
    if (!v) return;
    this.wallManager?.rebuildFromMap(level);
    if (this.rooms) {
      computeRooms(v.world.fixed, this.rooms, level);
      this.rooms.computeCutaway(v, level);
      this.cutaway?.onRoomsChanged();
      this.syncSecondLevel(this.ctx.state);
    }
    if (this.lighting) this.lighting.compute(this.lighting.phase);
    v.dirty = true;
  }

  /**
   * What placement asks of the simulation: the init tree of a new object
   * (cXObject::Reset; the object joins the simulator's module), the
   * allow-intersection / place / pickup check trees, and KillObject.
   */
  private simHooks(): ObjectBehaviorHooks {
    // An object of the world module the simulator does not hold (e.g. back
    // from an undone deletion) joins it with its data kept, Main restarted.
    const simObject = (obj: XObject): SimObject | null => {
      const m = this.sim?.module;
      if (!m || this.killing.has(obj)) return null;
      const o = m.getObject(obj.objectId);
      if (o && o.obj === obj && !o.killed) return o;
      if (this.lotObjects?.module.objects.get(obj.objectId) !== obj) return null;
      try {
        return m.addObject(obj, false);
      } catch (e) {
        console.warn("[sim] could not take object back", obj.selector.guid.toString(16), e);
        return null;
      }
    };
    return {
      runInitTree: (obj) => {
        const m = this.sim?.module;
        if (!m) return false;
        try {
          m.addObject(obj, true);
        } catch (e) {
          console.warn("[buy] init tree failed", obj.selector.guid.toString(16), e);
          return false;
        }
        // Every part ran its Init (cXMTObject::Reset runs each part's).
        return true;
      },
      runCheckTree: (obj, entry, stackObj) => {
        const o = simObject(obj);
        if (!o) return false;
        const tree = o.fnTable.getTreeID(entry);
        if (tree === 0) return false;
        try {
          return o.runCheckTree(o.behavior, stackObj, tree, null);
        } catch {
          return false;
        }
      },
      onEnterWorld: (obj) => {
        simObject(obj);
        if (obj.isPerson) void this.drawPerson(obj);
        this.plumbBobs?.onEnterWorld(obj);
      },
      onExitWorld: (obj) => {
        this.plumbBobs?.onExitWorld(obj);
      },
      onKill: (obj) => {
        this.plumbBobs?.onKill(obj);
        this.people?.onKill(obj);
        this.sim?.module.removeObject(obj);
      },
      personData: (obj) => this.sim?.module.persons.find((p) => p.obj === obj)?.pd ?? null,
      modeFreeze: () => this.sim?.globals[G.modeFreeze] ?? 0,
      // House::DoCommand(0xf3): RoomManager::RoomScoreChanged unless 0xfffb.
      roomChanged: (room) => {
        if (room !== 0xfffb) this.lighting?.roomChanged(room);
      },
    };
  }

  /**
   * The world side of the sim's placement primitives (SimModule.worldHooks):
   * ObjectFolder::GetSelectorByGUID (an object file not opened yet opens in
   * the background: the primitive waits), ObjectModule::
   * MakeNewOutOfWorldObject, cXObject::CanPlace / Place through Placement,
   * a walking person's moves (its tile link follows: out of the old tile,
   * into the new one; its contents follow, SetLocation) and KillObject.
   */
  private createObjectHooks(): WorldHooks {
    const loading = new Map<number, boolean>();
    return {
      // GenericSimCall 24 (set suit): the edited body strings dress the person again.
      bodyStringsChanged: (obj, strings) => {
        void this.people?.redress(obj, strings).then(() => {
          if (this.viewer) this.viewer.dirty = true;
        });
      },
      keyGUID: () => this.lotObjects?.folder.keyGUID() ?? 0,
      selector: (guid) => {
        const lot = this.lotObjects;
        if (!lot) return null;
        const sel = lot.folder.selectorByGUID(guid);
        if (sel) return sel;
        const g = guid >>> 0;
        if (loading.get(g) === false) return null;
        if (!loading.has(g)) {
          loading.set(g, true);
          void lot.folder
            .getSelectorByGUID(g)
            .then((s) => loading.set(g, s !== null))
            .catch(() => loading.set(g, false));
        }
        return undefined;
      },
      make: (sel) => {
        const p = this.placement;
        const lot = this.lotObjects;
        if (!p || !lot) return null;
        const obj = makeNewOutOfWorldObject(p, lot.folder, sel);
        if (obj && this.viewer) this.viewer.dirty = true;
        return obj;
      },
      canPlace: (obj, pos, level, container, slot) => {
        const p = this.placement;
        if (!p) return false;
        p.error = 0;
        p.obstacle = null;
        return p.canPlace(obj, pos, level, container, slot);
      },
      place: (obj, pos, level, container, slot) => {
        const p = this.placement;
        if (!p) return;
        p.place(obj, pos, level, container, slot, true);
        this.sim?.module.placed(obj);
        if (this.viewer) this.viewer.dirty = true;
      },
      moveTo: (obj, pos, level) => {
        const p = this.placement;
        if (!p) {
          obj.fx = pos.fx;
          obj.fy = pos.fy;
          return;
        }
        const tile = (f: number): number => f >> 4;
        const sameTile = tile(obj.fx) === tile(pos.fx) && tile(obj.fy) === tile(pos.fy) && obj.level === level;
        // SAnimator's walk step and FollowOneStep: CanPlace then cXPerson::Place
        // (cXObject::Place: TestAndPlace out of the old site, then into the new
        // tile). A person chained under another object of its tile (two people
        // on a tile: slot 0 of the newcomer) leaves that chain too; skipping it
        // left the person linked at the old tile, and its later removal took
        // the wrong tile's head with it (objects lost from their tile chain:
        // not drawn, not pickable). Not for a person in a container's slot.
        const spec = p.getPlacementSpec(obj);
        const onTile = !sameTile && spec.placing && spec.container === null;
        if (onTile) p.testAndPlace(obj, { placing: false, fy: 0, fx: 0, container: null, slot: -1, level: 0 }, true);
        p.setLocation(obj, pos, level);
        if (onTile && !p.outOfBounds(tile(pos.fx), tile(pos.fy))) {
          p.testAndPlace(obj, { placing: true, fy: pos.fy, fx: pos.fx, container: null, slot: -1, level }, true);
        }
      },
      pickup: (obj) => {
        this.placement?.pickup(obj, true);
        if (this.viewer) this.viewer.dirty = true;
      },
      turn: (obj, n) => {
        this.placement?.turnObject(obj, n);
        if (this.viewer) this.viewer.dirty = true;
      },
      findGoodLocation: (obj, start, level, opts) => this.placement?.findGoodLocation(obj, start, level, opts) ?? null,
      kill: (obj) => {
        const p = this.placement;
        const lot = this.lotObjects;
        if (!p || !lot || lot.module.objects.get(obj.objectId) !== obj) return;
        this.killing.add(obj);
        try {
          killObject(p, obj);
        } finally {
          this.killing.delete(obj);
        }
        if (this.viewer) this.viewer.dirty = true;
      },
      lastError: () => ({ code: this.placement?.error ?? 0, obstacle: this.placement?.obstacle?.objectId ?? 0 }),
    };
  }

  /**
   * cXPerson::DrawIso: the object in a person's slot 0 is drawn at the
   * person's hand registration (SAnimator::PrepReg, then
   * RenderLoc::SetWorldCoord: world (x, y, z) -> fixed (z, x) / 0.1875 and
   * altitude y * 2 sqrt 6 / 3).
   */
  private placeHeld(d: DrawableObject, rp: RenderParam): boolean {
    const obj = (d as { obj?: XObject }).obj;
    const v = this.viewer;
    const lot = this.lotObjects;
    if (!obj || !v || !lot || !this.people) return false;
    const parent = lot.objects.get(obj.parentId);
    if (!parent?.isPerson || obj.slotHierNumber !== 1) return false;
    const p = this.people.registrationPoint(parent, 0, v.world.rotation, v.world.fixed.getFAlt(parent.fx, parent.fy));
    if (!p) return false;
    rp.x = p[2] / 0.1875;
    rp.y = p[0] / 0.1875;
    rp.z = Math.fround((p[1] * 2 * Math.sqrt(6)) / 3);
    rp.level = parent.level;
    rp.updateScreenCoords();
    return true;
  }

  /** Objects being killed by the simulation (their pickup check trees must not bring them back). */
  private readonly killing = new Set<XObject>();

  /**
   * Family members without a person object on the lot (a new move-in, or
   * members away) get one: PersonFinder::CreateInstance (CPState::
   * SetSelectedPerson creates the missing instance) makes the character's
   * object out of the world (cXPerson::Reset: persistent data, Init) and
   * cXObject::FindGoodLocation places it from the view's centermost tile
   * outwards (level 1). The lot view then dresses and draws it. A family
   * moving in was already made at the mailbox by "reset lot"
   * (resetLotForMoveIn).
   */
  private async bringInFamily(v: HouseViewer, lot: LotObjects): Promise<void> {
    const sim = this.sim;
    const p = this.placement;
    if (!sim || !p) return;
    const nbhdDir = this.housePath.split("/")[0] ?? "UserData";
    const present = new Set([...lot.module.objects.values()].filter((o) => o.isPerson).map((o) => o.guid | 0));
    for (const info of this.ctx.state.family) {
      if (info.guid === undefined || present.has(info.guid | 0)) continue;
      const sel = await lot.folder.getSelectorByGUID(info.guid).catch(() => null);
      if (!sel) continue;
      const obj = makeNewOutOfWorldObject(p, lot.folder, sel);
      if (!obj) continue;
      // cSimsApp::LoadGame's arrivals: PersonFinder::CreateDowntownSim leaves them out of
      // the world; the lot's own behaviors (ped markers, phone plugins) bring them in.
      if (this.arrivalOutOfWorld) {
        present.add(info.guid | 0);
        continue;
      }
      if (!this.placeNewInstance(v, p, obj)) continue;
      present.add(info.guid | 0);
      const ps = sim.module.persons.find((x) => x.obj === obj);
      if (ps && this.people && (await this.people.addPerson(nbhdDir, obj))) {
        this.people.bindSim(obj, (sk) => ps.animator.attach(sk), () => ps.renderDir ?? ps.obj.dir, () => ps.animator.followPos);
      }
    }
    v.dirty = true;
  }

  /**
   * PersonFinder::CreateInstance's placement of the person just made out of
   * the world: cXObject::FindGoodLocation from the view's centermost tile
   * (GViewer::GetCentermostTile; the lot's center when it is off the lot's
   * interior), level 1, the start tile's room, an empty tile, direction -1;
   * then cXPerson::Place there on level 1. With no place the object is
   * killed (ObjectModule::KillObject).
   */
  private placeNewInstance(v: HouseViewer, p: Placement, obj: XObject): boolean {
    const w = v.world;
    const c = v.pointToWholeTile(v.viewW >> 1, v.viewH >> 1, 1);
    let start = { fx: (c.x << 4) | 8, fy: (c.y << 4) | 8 };
    if (!w.inInterior(c.x, c.y)) {
      const half = w.size >> 1;
      start = { fx: ((half + w.minX) << 4) | 8, fy: ((half + w.minY) << 4) | 8 };
    }
    const [fx, fy] = RotatableWorld.rotateCoords(start.fx, start.fy, (4 - w.rotation) & 3, 0x400);
    const pos = p.findGoodLocation(obj, { fx, fy }, 1, { emptyTile: true, buildable: false, random: null, sameRoom: true });
    if (!pos) {
      killObject(p, obj);
      return false;
    }
    p.place(obj, pos, 1, null, 0, true);
    return true;
  }

  /**
   * HouseViewerHooks: CPState::SetSelectedPerson's PersonFinder::GetInstance
   * (the family member's character among the lot's objects); without one,
   * PersonFinder::CreateInstance makes it (MakeNewOutOfWorldObject of the
   * character's selector) and places it (placeNewInstance). This is how a
   * member deleted with the move_objects cheat comes back on the lot.
   * Returns true when the member had no instance.
   */
  createPersonInstance(guid: number): boolean {
    const sim = this.sim;
    const lot = this.lotObjects;
    const v = this.viewer;
    const p = this.placement;
    if (!sim || !lot || !v || !p) return false;
    if (sim.module.persons.some((q) => (q.obj.selector.guid | 0) === (guid | 0))) return false;
    const sel = lot.folder.selectorByGUID(guid);
    const obj = sel ? makeNewOutOfWorldObject(p, lot.folder, sel) : null;
    if (obj) this.placeNewInstance(v, p, obj);
    v.dirty = true;
    return true;
  }

  /**
   * A person who entered the world after the lot loaded (an NPC or a visitor
   * made by Create Object Instance, a sim brought in by its car) gets its
   * animator, bound to the simulation, once.
   */
  private async drawPerson(obj: XObject): Promise<void> {
    const people = this.people;
    const ps = this.sim?.module.persons.find((x) => x.obj === obj);
    if (!people || !ps || this.dressing.has(obj) || people.people.some((x) => x.obj === obj)) return;
    this.dressing.add(obj);
    try {
      if (await people.addPerson(this.housePath.split("/")[0] ?? "UserData", obj)) {
        people.bindSim(obj, (sk) => ps.animator.attach(sk), () => ps.renderDir ?? ps.obj.dir, () => ps.animator.followPos);
        if (this.viewer) this.viewer.dirty = true;
      }
    } finally {
      this.dressing.delete(obj);
    }
  }

  /** People whose animator drawPerson is loading. */
  private readonly dressing = new Set<XObject>();

  /**
   * Set before init for a lot change's arrival (downtown, Studio Town, a
   * trip): the arriving sims are made out of the world (bringInFamily).
   */
  arrivalOutOfWorld = false;

  /**
   * Set before init when a family just moved in (Neighborhood::LoadHouse
   * finds Family +0x138 bit 2, set by the move in, and clears it): its
   * family number (Family +0x10c) and the house.
   */
  moveIn: { family: number; house: number } | null = null;

  /**
   * Neighborhood::LoadHouse's move-in step (Mac 100a7010, Windows 004282ec
   * on): cSimulator::SetCurrentHour(NeighborhoodConstants "new family start
   * hour", lbl_105BA1E0, default 7, 0), ClearHistory, Resume,
   * House::ClearRouteHistory, then ObjectModule::BroadcastMessage("reset
   * lot", 0). The game's own trees do the rest: VisitGenerator's "reset
   * lot" makes every member of the family in global 9 without an instance
   * (Create New Object Instance of the neighbor, out of the world) and puts
   * them by the mailbox (Find Location For mode 4 from MailBox - Part A),
   * removing those that do not fit; the mailbox, newspaper controller,
   * bills, fires and help system reset themselves. The members' character
   * files are opened first (the original reads them synchronously).
   */
  private async resetLotForMoveIn(lot: LotObjects, moveIn: { family: number; house: number }): Promise<void> {
    const sim = this.sim;
    if (!sim) return;
    // LoadHouse's SetGlobal(9, family) / SetGlobal(10, house) come before PostLoad in the
    // original; the port's LoadGame step (applyLoadGameLocation) runs after the view's init.
    sim.globals[9] = moveIn.family;
    sim.globals[G.houseNumber] = moveIn.house;
    for (const info of this.ctx.state.family) {
      if (info.guid !== undefined) await lot.folder.getSelectorByGUID(info.guid).catch(() => null);
    }
    sim.setCurrentHour(NEW_FAMILY_START_HOUR, 0);
    sim.clearHistory();
    sim.resume();
    sim.layoutHistory = clearLayoutHistory();
    sim.module.broadcastMessage("reset lot", 0);
  }

  /** The selected sim's action icons (Live mode). */
  private readonly actionIcons: ActionIcons;

  /** The sprite slots' balloons and headlines (cXObject::DrawSpriteSlot). */
  private balloons: BalloonPainter | null = null;
  /** cDDDSimsView +0x11ac: the user event window (prim 35), made on first use. */
  private pip: (WinPictureInPicture & { ready: Promise<boolean> }) | null = null;

  private pictureInPicture(): WinPictureInPicture & { ready: Promise<boolean> } {
    if (this.pip) return this.pip;
    const pip = new WinPictureInPicture(this.ctx, {
      viewer: () => this.viewer,
      // The lead (its own +0x190 is null: lead id 0) and the parts naming it.
      groupOf: (o) => {
        const lead = o.mtLeadId !== 0 ? o.mtLeadId : o.objectId;
        return (this.sim?.module.objects ?? []).flatMap((s) => (s && (s.id === lead || s.obj.mtLeadId === lead) ? [s.obj] : []));
      },
      damageRect: (o) => {
        const v = this.viewer;
        const lot = this.lotObjects;
        if (!v || !lot) return null;
        return o.isPerson ? (this.people?.screenRect(o, v) ?? null) : objectScreenRect(o, v, lot.renderer(o.selector.res), new RenderParamImpl(v, 0));
      },
      cpMode: () => this.ctx.state.getCPMode(),
      livePIP: () => getOptionsMgr().getLivePIP(),
    });
    this.childAdd(pip);
    this.pip = Object.assign(pip, { ready: pip.init() });
    return this.pip;
  }

  /** HouseViewer +0x4d8..+0x4f0: the snapshot TakeAsyncSnapshot asked for, taken by the next UpdateWorld (tsPaint). */
  private pendingSnapshot: { rect: Rect; description: string } | null = null;

  /**
   * cDDDSimsView::DoPictureInPicture's auto snapshot (no window): none for
   * an object on the lot's border tiles; else the rectangle of the object's
   * tile tops (HouseViewer::ComputePixelTopOfTile with the tile's altitude,
   * (16 << scale) x (8 << scale) around each; the union over a multi-tile
   * group), and a photo of 200 x 300 >> (3 - scale) (at least CPState's
   * smallest camera size, lbl_105BA7B0 = 200 x 150) centered on it
   * horizontally, its bottom half the rectangle's height under the
   * rectangle's center; HouseViewer::TakeAsyncSnapshot(rect, no album, the
   * caption).
   */
  private autoSnapshot(o: PlacedObject, caption: string): void {
    const v = this.viewer;
    if (!v) return;
    const n = v.world.fixed.size - 1;
    if (o.tileX < 1 || o.tileX >= n || o.tileY < 1 || o.tileY >= n) return;
    const s = v.scale;
    const hw = (0x10 << s) / 2;
    const hh = (8 << s) / 2;
    const around = (x: PlacedObject): Rect => {
      const [tx, ty] = v.world.toView(x.tileX, x.tileY);
      const p = v.tileToPoint(tx, ty, x.level);
      return { left: p.h - hw, top: p.v - hh, right: p.h + hw, bottom: p.v + hh };
    };
    let r = around(o);
    if (o.kind === "multiTile" || o.kind === "portal") {
      const lead = o.mtLeadId !== 0 ? o.mtLeadId : o.objectId;
      for (const q of this.sim?.module.objects ?? []) {
        if (!q || (q.id !== lead && q.obj.mtLeadId !== lead)) continue;
        const b = around(q.obj);
        r = { left: Math.min(r.left, b.left), top: Math.min(r.top, b.top), right: Math.max(r.right, b.right), bottom: Math.max(r.bottom, b.bottom) };
      }
    }
    const k = 1 << (3 - s);
    const w = Math.max(Math.trunc(200 / k), SNAPSHOT_MIN.w);
    const h = Math.max(Math.trunc(300 / k), SNAPSHOT_MIN.h);
    const cx = Math.trunc((r.left + r.right) / 2);
    const cy = Math.trunc((r.top + r.bottom) / 2);
    const left = cx - Math.trunc(w / 2);
    const top = cy + (r.bottom - r.top - h);
    this.pendingSnapshot = { rect: { left, top, right: left + w, bottom: top + h }, description: caption };
    v.dirty = true;
  }

  /** cDDDSimsView +0x119c */
  private tutorialIcon: TutorialIcon | null = null;
  private tutEvents: TutEventSource | null = null;

  /**
   * cDDDSimsView's init makes the tutorial icon (a child that overlaps the
   * scroll area), cSimsApp puts its top right at (right - 1, top + 1), and
   * GlobalDispatch(0x107) (ObjectModule::SetTutorialObject) calls
   * cTutorialIcon::ObjectChanged; its click is ObjectModule::
   * ShowTutorialInfo: the tutorial object's "show situation info" tree.
   */
  private async initTutorialIcon(sim: Simulator): Promise<void> {
    const m = sim.module;
    const icon = new TutorialIcon(() => {
      const o = m.tutorialObject;
      const tree = o?.behavior.getTreeID(SHOW_SITUATION_INFO) ?? 0;
      if (!o || tree === 0) return;
      try {
        o.runOneTickTree(o.behavior, 0, tree, null);
      } catch (e) {
        console.warn("[tutorial] show situation info failed", e);
      }
    });
    await icon.init();
    if (this.sim !== sim) return;
    this.childAdd(icon);
    icon.setIconTopRight(this.getW() - 1, 1);
    this.tutorialIcon = icon;
    setTutorialIcon(icon);
    m.onTutorialObjectChanged = (o) => icon.objectChanged(o ? o.obj.selector.res : null);
    icon.objectChanged(m.tutorialObject ? m.tutorialObject.obj.selector.res : null);
    this.tutEvents = {
      ctx: this.ctx,
      module: m,
      rotation: () => this.viewer?.world.rotation ?? 0,
      personPicture: (guid) => findPersonPanelButton(winMgr.main, guid)?.image ?? null,
    };
  }

  /** The object and the person (whose head is shown) of the pie menu that is up. */
  private pieTarget: { objectId: number; personId: number } | null = null;

  /** The Live mode pie menu (cWinPeople's cTSPieMenu), made on first use. */
  private pie: TSPieMenu | null = null;

  /** The selected family member's cXPerson. */
  selectedPerson(): PersonSim | null {
    const info = this.ctx.state.personGetSelected();
    if (!info || info.guid === undefined || !this.sim) return null;
    return this.sim.module.persons.find((p) => (p.obj.selector.guid | 0) === (info.guid! | 0)) ?? null;
  }

  /**
   * cObjPickerTool::TryClick in Live mode: the object or person under the
   * cursor (HouseViewer::PointToObjectID) offers the
   * interactions the selected sim passes (ObjTestSim's menu), shown by
   * DoMenu; the one picked goes to the sim with priority 50
   * (MenuItemSelected -> cXPerson::AddAction).
   */
  private async liveClick(x: number, y: number): Promise<void> {
    const sim = this.sim;
    const v = this.viewer;
    const p = this.placement;
    const lot = this.lotObjects;
    const person = this.selectedPerson();
    if (!sim || !v || !p || !lot || !person) return;
    // cObjPickerTool::Click (Mac 0x1017cd70): unless the last Float left a person
    // (0x1d / 0x2a) or object (0x1e) cursor, a click whose view tile is on the
    // lot's border row or beyond (outside RotatableWorld +0x70..+0x7c, shrunk by
    // one) is dropped before TryClick: no Go Here off the lot.
    const pc = this.pickerCursor;
    if (pc !== 0x1d && pc !== 0x2a && pc !== 0x1e) {
      const t = v.pointToWholeTile(x, y, v.level || 1);
      if (!v.world.inInterior(t.x, t.y)) return;
    }
    const people = this.people;
    // TryClick runs Float first: the picked person replaces PointToObjectID's object.
    const id = this.pickedPersonId(pointToObjectId(v, p, (r) => lot.renderer(r), x, y, v.level || 1, PickMode.Any, people ? (o) => people.screenRect(o, v) : null, sim.globals[G.modeFreeze]));
    let target = id ? sim.module.getObject(id) : null;
    /** +0xb4: the Go Here helper was made and placed for this click (killed unless used). */
    let helper: SimObject | null = null;
    if (!target) {
      helper = this.makeGoHereHelper(x, y);
      if (!helper) return;
      target = helper;
    }
    // ObjTestSim(person, object) tests cXObject::GetInteractionLeader(object);
    // SetHiliteObject then moves the hilite onto the first entry's object.
    const t = target.getInteractionLeader();
    let picked = false;
    try {
      // DoMenu ends with -2 when Space advanced the selection: the menu is
    // made again for the newly selected person on the same object.
      for (let who: PersonSim | null = person; who; who = this.selectedPerson()) {
        const p = who;
        const entries = p.menuItemsFor(t);
        if (!entries.length) {
          this.doDeniedSound();
          return;
        }
        this.pieTarget = { objectId: t.id, personId: p.id };
        const ok = await this.doMenu(p, entries, this.area.left + x, this.area.top + y, (e) => {
          const action = p.makeInteraction(t, e.entry, 50, e);
          const done = p.addAction(action);
          // cObjPickerTool::MenuItemSelected -> cDDDSimsView::StartUserAction at the cursor.
          if (done) {
            const c = winMgr.cursorPosition();
            this.actionIcons.startUserAction(action, c.x - this.area.left, c.y - this.area.top);
          }
          picked ||= done;
          return done;
        });
        if (!ok) return;
      }
    } finally {
      this.pieTarget = null;
      if (helper && !picked && sim.module.getObject(helper.id) === helper) sim.module.killObject(helper);
    }
  }

  /** cObjPickerTool's cTool +0: when its last limited sound played. */
  private pickerSoundAt = -Infinity;

  /**
   * cTool::DoDeniedSound of the Live mode picker tool (cObjPickerTool::
   * TryClick with an empty menu, MenuItemSelected refused): "UI_error"
   * (lbl_105BBE58 + 0x5a), at most once per 400 ms.
   */
  private doDeniedSound(): void {
    const now = performance.now();
    if (now <= this.pickerSoundAt + 400) return;
    this.pickerSoundAt = now;
    soundPlayer.playBySource(ToolSounds.denied, UI_SOURCE);
  }

  /**
   * cObjPickerTool::TryClick on no object: the "Destination - For Go Here &
   * Shoo" object (GUID 0x7c4) is made out of the world
   * (MakeNewOutOfWorldObject) and placed at the clicked point (rotated to
   * world coordinates) or the closest good location (FindGoodLocation; the
   * tile's center when there is none), so that its menu offers Go Here.
   * Killed when it cannot be placed, and on house 99 when the grass of its
   * tile is below 10.
   */
  private makeGoHereHelper(x: number, y: number): SimObject | null {
    const sim = this.sim;
    const v = this.viewer;
    const h = sim?.module.worldHooks;
    const sel = h?.selector(0x7c4);
    if (!sim || !v || !h || !sel) return null;
    const level = v.level || 1;
    const t = v.pointToWholeTile(x, y, level);
    // GViewer::PointToTile(pt, true): the fraction inside the tile.
    const o = v.tileToPoint(t.x, t.y, level);
    const ax = v.tileToPoint(t.x + 1, t.y, level);
    const ay = v.tileToPoint(t.x, t.y + 1, level);
    const a = ax.h - o.h;
    const b = ay.h - o.h;
    const c = ax.v - o.v;
    const d = ay.v - o.v;
    const det = a * d - b * c;
    let u = 0.5;
    let w = 0.5;
    if (det !== 0) {
      u = ((x - o.h) * d - b * (y - o.v)) / det;
      w = (a * (y - o.v) - c * (x - o.h)) / det;
    }
    const clamp = (f: number): number => Math.min(15, Math.max(0, Math.trunc(f * 16)));
    const [fx, fy] = RotatableWorld.rotateCoords((t.x << 4) + clamp(u), (t.y << 4) + clamp(w), (4 - v.world.rotation) & 3, 0x400);
    const xo = h.make(sel);
    if (!xo) return null;
    const obj = sim.module.getObject(xo.objectId);
    if (!obj) return null;
    const pos = h.findGoodLocation(xo, { fx, fy }, level, { emptyTile: true, buildable: false, random: null }) ?? { fx: (fx & ~0xf) | 8, fy: (fy & ~0xf) | 8 };
    // House 99 (global 10): no Go Here where the grass (signed) is below 10. The
    // world tile is handed to cRotatableWorld::GetGrass, which rotates it once more
    // as if it were a view tile (the same as the original under a view rotation).
    if (sim.globals[10] === 99 && v.world.getGrass((pos.fx >> 4) << 24 >> 24, (pos.fy >> 4) << 24 >> 24) < 10) {
      sim.module.killObject(obj);
      return null;
    }
    if (!h.canPlace(xo, pos, level, null, -1)) {
      sim.module.killObject(obj);
      return null;
    }
    h.place(xo, pos, level, null, -1);
    return obj;
  }

  /**
   * ObjectModule::AdvanceSelectedPerson: select the family member after the
   * selected one (wrapping) who is on the lot (CPState::SetSelectedPerson
   * stands for the hilite bit, OnSelectionChange and GlobalDispatch 0xe4).
   */
  advanceSelectedPerson(): boolean {
    const st = this.ctx.state;
    const sim = this.sim;
    if (!sim) return false;
    const n = st.family.length;
    const cur = st.selectedIndex();
    for (let i = 1; i <= n; i++) {
      const k = (cur + i) % n;
      const g = st.family[k]?.guid;
      if (g === undefined) continue;
      if (!sim.module.persons.some((q) => (q.obj.selector.guid | 0) === (g | 0))) continue;
      if (k === cur) return false;
      st.setSelectedPerson(k);
      return true;
    }
    return false;
  }

  /** The Live mode sub pie (cWinPeople::GetPeopleSubPie), made on first use. */
  private subPie: TSPieMenu | null = null;
  /** The sub pie's own backdrop (cWinPeople::GetPieBackBuffer). */
  private subPieBkg: ImageBitmap | null = null;
  /** cObjPickerTool +0xa0: the last neighbor picture made for the sub pie. */
  private neighborPic: ImageBitmap | null = null;
  /** kPeopleTemplate and kIconFrame, for the neighbor pictures. */
  private picParts: { template: ImageBitmap; frame: ImageBitmap } | null = null;

  /**
   * kPeopleTemplate and kIconFrame. The frame (two 45 x 45 halves: plain,
   * and the yellow selected ring) is blitted over the picture with its pure
   * blue as the transparent color (cActionIcon::MakeActionBitmap), so that
   * color is keyed out here.
   */
  private async loadPicParts(): Promise<void> {
    if (this.picParts) return;
    const [template, raw] = await Promise.all([this.ctx.res.image("kPeopleTemplate"), this.ctx.res.image("kIconFrame")]);
    const c = new OffscreenCanvas(raw.width, raw.height);
    const g = c.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(raw, 0, 0);
    const img = g.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 255) d[i + 3] = 0;
    g.putImageData(img, 0, 0);
    this.picParts ??= { template, frame: c.transferToImageBitmap() };
  }

  /**
   * PersonFinder::GetPictureBuffer of the neighbor `neighborId` (its
   * BuildPersonBtn image) through cActionIcon::MakeActionBitmap(buf, true):
   * a 45 x 45 picture, cell (0, 1) of the 4 x 3 button image (the happy
   * face) under the first half of kIconFrame. Null when the neighbor's face
   * is not known (only the family and the people it knows are loaded).
   */
  private neighborPicture(neighborId: number): ImageBitmap | null {
    const st = this.ctx.state;
    const info = [...st.family, ...st.neighbors].find((q) => q.neighborId === neighborId);
    const parts = this.picParts;
    if (!info || !parts) return null;
    const btn = buildPersonBtn(info.face, parts.template);
    const c = new OffscreenCanvas(45, 45);
    const g = c.getContext("2d")!;
    g.drawImage(btn, 0, 45, 45, 45, 0, 0, 45, 45);
    g.drawImage(parts.frame, 0, 0, 45, 45, 0, 0, 45, 45);
    return c.transferToImageBitmap();
  }

  /**
   * cObjPickerTool::DoMenu. Names "a/b" go in a sub menu "a" (made at the
   * place of its first entry), others straight in the people pie. A pie
   * shows 12 entries from the current page; Tab (cWinPeople::TSOnCommand
   * ends the popped pie with -3) moves to the next 12, back to the first
   * past the end. The people pie pops at the click with end mode -1 and,
   * once its loop is over, stays up in the main window; the selected sim's
   * head (SAnimator::StartPopupHead) starts after its first popup. Picking
   * a sub menu disables (hides) the people pie's items, titles the sub pie
   * with the sub menu's name and pops it (end mode 0) centered on the
   * picked label (GetPopupX + GetCurItemCenterX; the original also warps
   * the cursor there), the head's shadow following
   * (StartPopupHeadSubmenu). Letting go of the sub pie within its inactive
   * radius comes back to the people pie at the click, elsewhere cancels.
   * Interactions are queued as they are picked (MenuItemSelected through
   * `onSelected`), so Shift keeps the sub pie up for more. Space
   * (cWinPeople::TSOnCommand 0x20) advances the selected person and ends
   * the popped pie with -2: DoMenu then returns true so that the caller
   * makes the menu again for the new person.
   */
  private async doMenu(person: PersonSim, entries: MenuItem[], x: number, y: number, onSelected: (e: MenuItem) => boolean): Promise<boolean> {
    type MenuEntry = { text: string; entry: MenuItem | null; sub: MenuEntry[] };
    const top: MenuEntry[] = [];
    for (const e of entries) {
      const slash = e.name.indexOf("/");
      if (slash < 0) {
        top.push({ text: e.name, entry: e, sub: [] });
        continue;
      }
      const head = e.name.slice(0, slash);
      let m = top.find((t) => t.entry === null && t.text === head);
      if (!m) {
        m = { text: head, entry: null, sub: [] };
        top.push(m);
      }
      m.sub.push({ text: e.name.slice(slash + 1), entry: e, sub: [] });
    }
    const pie = (this.pie ??= await TSPieMenu.forLiveMode(this.ctx));
    const sub = (this.subPie ??= await TSPieMenu.forLiveMode(this.ctx));
    this.subPieBkg ??= sub.background;
    await this.loadPicParts();
    const downX = x;
    const downY = y;
    /** +0x5c / +0x60: in the sub menu `subIndex` of `top`; +0x64: first entry shown. */
    let inSub = false;
    let subIndex = -1;
    let page = 0;
    let list = top;
    /** +0x90: the people pie went up (it stays in the main window). */
    let keepPie = false;
    /** Space advanced the selected person (the -2 end). */
    let advanced = false;
    const shown = (): MenuEntry[] => (inSub ? top[subIndex]!.sub : top);
    // cWinPeople::TSOnCommand for both pies: picks (MenuItemSelected),
    // highlights (MenuItemChanged) and the Tab / Escape characters.
    const onCommand = (cmd: number, m: TSPieMenu, arg: number): boolean => {
      if (cmd === CMD_PIE_PICK) {
        // cObjPickerTool::MenuItemSelected
        const shift = winMgr.isKeyDown("Shift");
        const it = list[m.getSelection() + page];
        if (it && m.getSelection() >= 0) {
          if (!it.entry) {
            m.endPopup();
            return true;
          }
          if (onSelected(it.entry)) {
            if (shift) nodPopupHead();
            else m.endPopup();
            return true;
          }
        }
        if (!shift) m.endPopup();
        this.doDeniedSound();
        return false;
      }
      if (cmd === CMD_PIE_HILITE) {
        // cObjPickerTool::MenuItemChanged: in a sub menu, an item made for
        // a neighbor (stack var 1 set, stack var 0 its id) shows the
        // neighbor's picture untitled (the last one made stays when this
        // neighbor has none); no item brings back the backdrop and the
        // sub menu's title. Then the attitude (score unused by SetAttitude).
        const it = m.getSelection() >= 0 ? list[m.getSelection() + page] : undefined;
        if (it?.entry) {
          const a = it.entry.args;
          if (inSub && a && a[1] !== 0) {
            const pic = this.sim?.module.findNeighborByID(a[0]!) ? this.neighborPicture(a[0]!) : null;
            if (pic) this.neighborPic = pic;
            if (this.neighborPic) m.setBackgroundAndTitle(this.neighborPic, "");
          }
        } else if (inSub) {
          m.setBackgroundAndTitle(this.subPieBkg, top[subIndex]?.text ?? "");
        }
        setPopupHeadAttitude(0, winMgr.isKeyDown("Shift"), winMgr.isKeyDown("Control"));
        return true;
      }
      if (cmd === CMD_PIE_CANCEL) {
        if (m.getPoppedUp()) m.endPopup(-1);
        return true;
      }
      if (cmd === CMD_PIE_CHAR) {
        if (arg === 9) m.endPopup(-3);
        else if (arg === 0x1b) m.endPopup(-1);
        else if (arg === 0x20) {
          advanced = this.advanceSelectedPerson();
          (sub.getPoppedUp() ? sub : pie).endPopup(-2);
        } else return false;
        return true;
      }
      return false;
    };
    pie.onCommand = onCommand;
    sub.onCommand = onCommand;
    const cleanup = (): void => {
      inSub = false;
      subIndex = -1;
      stopPopupHead();
      if (keepPie) {
        winMgr.main.childRemove(pie);
        pie.endPopupWindow();
      }
    };
    let first = true;
    for (;;) {
      const m = inSub ? sub : pie;
      const l = shown();
      if (l !== list) page = 0;
      list = l;
      m.clear();
      for (let i = 0; i < 12 && page + i < list.length; i++) m.insertString(list[page + i]!.text);
      if (!inSub) {
        keepPie = true;
      } else {
        x = pie.getPopupX() + pie.getCurItemCenterX();
        y = pie.getPopupY() + pie.getCurItemCenterY();
      }
      m.popupBegin(x, y, !winMgr.isMouseButtonDown(), inSub ? 0 : -1);
      if (first) {
        first = false;
        const lp = this.people?.people.find((q) => q.obj === person.obj);
        if (lp) startPopupHead(pie, lp.anim.bodyStrings.strings);
      }
      const sel = await m.popupEventLoop();
      m.popupEnd();
      if (keepPie) winMgr.main.childAdd(pie);
      if (sel === -3) {
        page = page + 12 > list.length ? 0 : page + 12;
        continue;
      }
      if (sel === -2) {
        if (inSub) stopPopupHeadSubmenu();
        cleanup();
        return advanced;
      }
      if (sel === -1) {
        // the sub pie let go near its center: back to the people pie
        if (inSub && sub.getDistance() <= sub.getInactiveRadius()) {
          inSub = false;
          x = downX;
          y = downY;
          stopPopupHeadSubmenu();
          continue;
        }
        cleanup();
        return false;
      }
      const it = list[sel + page];
      if (!it || it.entry) {
        if (it && inSub) stopPopupHeadSubmenu();
        cleanup();
        return false;
      }
      subIndex = sel + page;
      inSub = true;
      sub.background = this.subPieBkg;
      if (m.getSelection() >= 0) sub.title = m.getItemText(m.getSelection());
      startPopupHeadSubmenu(sub);
      for (let i = 0; i < pie.getItemCount(); i++) pie.enableItem(i, false);
    }
  }

  /** cDDDSimsView+0x164: the tool cursor id. */
  private toolCursor = -1;

  /**
   * cDDDSimsView::SetToolCursor: the view's mouse cursor (cTSCursorManager::
   * GetCursor(id)); 5 keeps the current one.
   */
  setToolCursor(id: number): void {
    if (id === 5 || id === this.toolCursor) return;
    this.toolCursor = id;
    this.winCursor = getCursor(id);
    winMgr.applyCursor();
  }

  /** XViewer routes the mouse to cGameTools' current tool in buy and build modes. */
  private activeTools(): GameTools | null {
    const m = this.ctx.state.getMode();
    // (a cheat tool, CPState::SetCheatTool, takes the mouse in every mode)
    return m === Mode.Buy || m === Mode.Build || this.ctx.state.cheatToolActive ? this.gameTools : null;
  }

  override postChildDraw(g: Gfx): void {
    const t = this.tip;
    if (!t) return;
    t.win.setToolTip(t.text);
    t.win.moveTo(t.x, t.y);
    t.win.plot(g.ctx, g.ox, g.oy);
  }

  /**
   * Is (x, y) over one of this window's children (the control panel, the
   * PIP window...)? Their unhandled mouse events bubble up to this window
   * (TSWin dispatch); the original's 3D view only gets the clicks that land
   * on the world, so those are swallowed here.
   */
  private overChild(x: number, y: number): boolean {
    return this.children.some((c) => c.windowFromPoint(x - c.area.left, y - c.area.top) !== null);
  }

  override tsOnMouseDownL(x: number, y: number): boolean {
    if (this.overChild(x, y)) return true;
    if (this.viewer && this.ctx.state.getMode() === Mode.Camera) {
      // cDDDSimsView::TSOnMouseDownL (camera mode): HouseViewer::TakeAsyncSnapshot of the camera frame.
      const v = this.viewer;
      void takeCameraSnapshot(this.ctx, v.comp.canvas, computeCameraFrame(this.ctx, x, y, v.viewW, v.viewH));
      return true;
    }
    // EdgeDetectScroller::OnMouseDownL: XViewer::MouseDown only in state 0 (not while the Alt pan scrolls).
    if (this.edge?.panning) return true;
    const tools = this.activeTools();
    if (!tools && this.viewer && this.ctx.state.getMode() === Mode.Live && this.sim) {
      void this.liveClick(x, y);
      return true;
    }
    if (!tools || !this.viewer) return false;
    this.buttonDown = true;
    tools.mouseDown(x, y);
    return true;
  }

  override tsOnMouseUpL(x: number, y: number): boolean {
    const tools = this.activeTools();
    if (!tools || !this.viewer) return false;
    this.buttonDown = false;
    tools.mouseUp(x, y);
    return true;
  }

  override tsOnMouseEnter(): void {
    this.activeTools()?.enterWorld();
  }

  /**
   * cSimulator over the loaded objects: their saved tree stacks resume (or
   * their Init trees run); the view redraws when an object's look changes
   * and hides killed objects (the object module and tile arrays are not
   * updated yet). A load failure leaves the lot static.
   */
  private async initSimulator(house: ResFile, lot: LotObjects, fixed?: FixedWorld): Promise<void> {
    try {
      // PostLoad waits for the world hooks (the placement): see init.
      // cOptionsMgr::Load -> cXObject::SetFreeWill: DoStream copies the flag into global 30.
      Simulator.freeWill = getOptionsMgr().getFreeWill();
      const sim = await Simulator.create(house, lot.objects.values() as Iterable<XObject>, lot.folder.packs, true);
      // The simulation works on the viewer's fixed world (the router reads its rooms, walls and tile objects).
      if (fixed) sim.world = fixed;
      sim.state = this.ctx.state;
      // The panels read the relationships the simulation writes (and the people met during play).
      if (sim.module.nbhd) shareSimulationNeighborhood(this.ctx.state, sim.module.nbhd);
      // LoadGame dirties the whole CPState: the clock comes from the loaded globals.
      sim.pushClock();
      // ... and the family's motives and person data (the Live panel samples them before the first tick).
      sim.pushPeople();
      sim.module.onDirty = (): void => {
        if (this.viewer) this.viewer.dirty = true;
      };
      sim.module.onKill = (o): void => {
        // cObjPickerTool::DeletingObject: the hilite goes with its object (SetHiliteObject(0)).
        if (o.id === this.liveHilite) this.setHiliteObject(0, null);
        // The pie menus close when their object or the person whose head they show goes.
        const pt = this.pieTarget;
        if (pt && (o.id === pt.objectId || o.id === pt.personId)) {
          if (this.subPie?.getPoppedUp()) this.subPie.endPopup(-1);
          if (this.pie?.getPoppedUp()) this.pie.endPopup(-1);
        }
        o.obj.objectData[34] = 1;
        if (this.viewer) this.viewer.dirty = true;
      };
      sim.module.onDeselect = (): void => {
        this.plumbBobs?.setSelectedPerson(null);
      };
      // Prim 34 (UI Effect): Tut_FlashButtonByImageID, Tut_FlashPersonPanelButton, Tut_FlashRelButton.
      sim.module.tutorialHooks = {
        flashButtonByImageID: (id, on) => void tutFlashButtonByImageID(this.ctx, id, on),
        flashPersonPanelButton: (guid, on) => void tutFlashWindow(this.ctx, findPersonPanelButton(winMgr.main, guid), on),
        flashRelButton: (guid, on) => void tutFlashWindow(this.ctx, findRelButton(winMgr.main, guid), on),
        tutorialCompleted: () => {
          const dir = this.ctx.hooks?.neighborhoodDir?.();
          if (dir) void tutorialCompleted(dir, 0);
        },
      };
      this.sim = sim;
      void this.initTutorialIcon(sim);
      getOptionsMgr().onChange(this.onOptions);
      this.initBudgetSource(sim, lot);
      // cWinPeople::BuildGifts reads the selected sim's SimInventory and the gifts' selectors.
      GiftsPanel.source = {
        inventory: (guid) => {
          const nb = sim.module.findNeighborByGUID(guid);
          return nb ? sim.module.getInventoryByNeighbourID(nb.id) : null;
        },
        selector: (guid) => lot.folder.getSelectorByGUID(guid),
      };
      sim.module.worldHooks = this.createObjectHooks();
      // Neighborhood::GetNumCharacters for ObjectModule::AddObject's primitive limit.
      sim.module.numCharacters = (sim.module.nbhd?.neighbors ?? []).filter((n) => lot.folder.sourceOfGUID(n.guid) === 1).length;
      sim.module.updatePrimitiveLimit();
      sim.module.roomHooks = {
        room: (id) => this.lighting?.roomInfo(id) ?? null,
        roomLightingChanged: (id) => this.lighting?.roomChanged(id),
        roomScoreChanged: (id) => this.lighting?.roomChanged(id),
        roomScore: (id) => this.lighting?.roomScore(id) ?? null,
        setOverheadLights: (id, on) => this.lighting?.setOverheadLights(id, on),
        currentRoomChanged: () => this.cutaway?.onTrackedChanged(),
      };
      // The first RoomManager::ComputeRooms (initCutaway) reads the RoomScoreConstants (FCNS 3 of Global.iff).
      loadRoomScoreConstants(sim.module.res.glob);
      // House::DoStream's layout history (HOUS 1).
      sim.layoutHistory = readLayoutHistory(house.get("HOUS", 1));
      sim.module.userEventHooks = {
        livePIP: () => getOptionsMgr().getLivePIP(),
        pictureInPicture: (o, a) => {
          if (a.window) {
            // cDDDSimsView::DoPictureInPicture: cWinPictureInPicture::Open / Close (+0x11ac).
            const pip = this.pictureInPicture();
            if (!a.open) pip.close(o.obj);
            else void pip.ready.then(() => pip.open(o.obj, true, a.ms, a.arg3, a.arg2, a.flag4, a.snapshot && getOptionsMgr().getAutoSnapshots(), a.caption));
            return;
          }
          // cDDDSimsView::DoPictureInPicture without a window: CenterHouseViewOnMe with the
          // auto-centering option, else the "UI_error" sound and no snapshot.
          let snapshot = a.snapshot && getOptionsMgr().getAutoSnapshots();
          if (getOptionsMgr().getAutoCentering()) this.centerOnObject(o.obj);
          else {
            snapshot = false;
            soundPlayer.playBySource("UI_error", UI_SOURCE);
          }
          if (snapshot) this.autoSnapshot(o.obj, a.caption);
        },
      };
      animSoundEnv.floorSound = (pattern) => this.viewer?.floors.getFloorSound(pattern) ?? 2;
      // objects the behaviors create (the original folder has them all)
      // and the inventory tokens ParseUIString names ($TokenNameLocal)
      const guids = new Set([...sim.module.createdObjectGUIDs(), ...sim.module.tokenGUIDs()]);
      await Promise.all([...guids].map((g) => lot.folder.getSelectorByGUID(g >>> 0).catch(() => null)));
      // The people's VitaBoys follow the simulation's animators.
      for (const ps of sim.module.persons) {
        this.people?.bindSim(
          ps.obj,
          (sk) => ps.animator.attach(sk),
          () => ps.renderDir ?? ps.obj.dir,
          () => ps.animator.followPos,
        );
      }
    } catch (e) {
      console.error("[sim] simulator not started", e);
    }
  }

  /**
   * What the view control's dialogs read from this lot: cDDDSimsView::SetBlockSimulator,
   * global 0x20 and cWinBudgetDlg's data. House::PrepareForBudgetWindow recomputes
   * the object / architecture values only outside Live mode (global 19 set); in Live
   * mode they are House::EnterLiveMode's, whose stats part is not ported: the port
   * computes them when the window opens, so values changed since entering Live mode show.
   * The family flags (+0x138) and global 0x17 of those functions are not applied here.
   */
  private initBudgetSource(sim: Simulator, lot: LotObjects): void {
    // The midnight House::GetHouseStats (family history) and House::DoCommand(0xdc) stats;
    // the build prices ComputeArchValue reads come from the catalog, loaded once.
    let prices: ArchPrices | null = null;
    void loadBuildCatalog(this.ctx).then((c) => (prices = c.prices));
    sim.houseHooks = {
      houseStats: () => this.computeHouseStats(),
      computeStats: () => {
        const viewer = this.viewer;
        const walls = this.wallManager;
        if (!viewer || !walls || !prices) return null;
        const objects = new Map(moduleOrder(lot.module).map((o) => [o.objectId, o]));
        return { summary: summarizeHouseStats(objects, viewer.world.fixed, walls.gfx, viewer.floors, prices), lotSize: viewer.world.fixed.size };
      },
    };
    WinViewControl.holdSimulator = () => holdSimulator(sim);
    // GlobalDispatch(0x109): cSimsApp::DoCommand -> the view control (cWinCPanel::PostInit put it here).
    sim.onSuspendChange = (on) => {
      for (const c of this.children) if (c instanceof WinViewControl) c.simulatorSuspended(on);
    };
    WinViewControl.simulatorGlobal32 = () => sim.globals[32]!;
    WinBudgetDlg.source = {
      prepareForBudgetWindow: async () => {
        const viewer = this.viewer;
        const walls = this.wallManager;
        if (!viewer || !walls) return;
        const prices = (await loadBuildCatalog(this.ctx)).prices;
        const objects = new Map(moduleOrder(lot.module).map((o) => [o.objectId, o]));
        const st = summarizeHouseStats(objects, viewer.world.fixed, walls.gfx, viewer.floors, prices);
        sim.objectValue = st.simA0;
        sim.archValue = st.simA4;
        sim.globals[0x16] = st.lotHasHouse;
        sim.globals[0x25] = st.transitFilterFlags;
      },
      getTodaysExpenses: () => sim.getTodaysExpenses(),
      getExpensesHistory: () => sim.getExpensesHistory(),
      getFunds: () => sim.getFunds(),
      getDaysRunning: () => sim.globals[G.daysRunning]!,
      // Neighborhood::GetFamilyNetWorth of the family living here: funds + lot value + objects
      // + architecture x NeighborhoodConstants "architecture value multiplier" (0.7, a float).
      getNetWorth: () =>
        (sim.getFunds() + sim.lotValue + sim.objectValue + Math.trunc(Math.fround(Math.fround(sim.archValue) * ARCHITECTURE_VALUE_MULTIPLIER))) | 0,
    };
  }

  /**
   * ObjectModule::PostLoad's plumb bobs (InitPlumbBobs, OnSelectionChange of
   * the selected person, OnStarPowerChange of everyone), once the bobs'
   * object files are open. LotPeople draws them on their carriers.
   */
  private async initPlumbBobs(lot: LotObjects, sim: Simulator, p: Placement): Promise<void> {
    const bobs = new PlumbBobs({
      placement: p,
      folder: lot.folder,
      sim: sim.module,
      kill: (obj) => {
        this.killing.add(obj);
        try {
          killObject(p, obj);
        } finally {
          this.killing.delete(obj);
        }
      },
    });
    await bobs.load();
    this.plumbBobs = bobs;
    bobs.postLoad(this.selectedPerson()?.obj ?? null);
    if (this.people) {
      this.people.objectById = (id) => lot.objects.get(id) ?? null;
      this.people.motive = (o, i) => sim.module.getObject(o.objectId)?.person?.motives[i] ?? 0;
    }
  }

  /** cSimulator::SetCurrentHour's time-of-day change (global 4): relight the rooms and the terrain. */
  private updateTimeOfDay(): void {
    const l = this.lighting;
    if (!l || !this.viewer) return;
    const phase = timeOfDay(this.ctx.state.getTime().hour);
    if (phase === l.phase) return;
    l.compute(phase);
    // SetCurrentHour: cTerrain::SetColor, then GlobalDispatch(0xdd).
    this.terrain?.setColor(houseNumberOfPath(this.housePath), phase);
    this.terrain?.setLatitudeByTimeOfDay(phase);
    this.viewer.dirty = true;
  }

  private listen(fn: (s: CPState) => void): void {
    this.listeners.push(fn);
    this.ctx.state.onChange(fn);
  }

  /** cOptionsMgr::SetFreeWill -> cXObject::SetFreeWill. */
  private readonly onOptions = (o: OptionsMgr): void => {
    this.sim?.setFreeWill(o.getFreeWill());
    // cOptionsMgr::SetAA / SetShadows: InitSpr2Decoder and a redraw of the view (vtable +0x50).
    if (this.viewer) this.viewer.dirty = true;
  };

  override shutdown(): void {
    for (const fn of this.listeners) this.ctx.state.offChange(fn);
    getOptionsMgr().offChange(this.onOptions);
    window.removeEventListener("keydown", this.onModifiers);
    window.removeEventListener("keyup", this.onModifiers);
    window.removeEventListener("pointermove", this.onModifiers);
    this.buyTool?.cancel();
    this.actionIcons.clear();
    if (this.ctx.state.viewer === this) this.ctx.state.viewer = null;
    if (this.tutorialIcon) setTutorialIcon(null);
    setTrackingDispatch(null);
    setTrackedObject(null);
    super.shutdown();
  }

  /**
   * cXObject::CenterHouseViewOnMe (not smooth): CPState::SetSelectedPerson
   * centers the view on the selected sim when the lot opens. The head-height
   * adjustment of the person branch (ScrollToCenter) is not ported.
   */
  /** cXObject::CenterHouseViewOnMe for any object in the world. */
  centerOnObject(o: PlacedObject, smooth = false): void {
    const v = this.viewer;
    if (!v || o.tileX < 0) return;
    const [fx, fy] = RotatableWorld.rotateCoords(o.fx, o.fy, v.world.rotation, 0x400);
    v.scrollToTile(fx, fy, o.level, smooth);
  }

  /**
   * HouseViewerHooks: CPState::SetSelectedPerson re-selecting the selected
   * person: cWinPeople::StopTracking unless that person is the tracked
   * object, then CenterHouseViewOnMe(person, true).
   */
  centerOnSelected(): void {
    const guid = this.ctx.state.personGetSelected()?.guid;
    const o = guid === undefined ? null : this.getPersonInstance(guid);
    if (!o || o !== getTrackedObject()) stopTracking();
    if (guid !== undefined) this.centerOnPerson(guid, true);
  }

  /** HouseViewerHooks: PersonFinder::GetInstance. */
  getPersonInstance(guid: number): PlacedObject | null {
    for (const o of this.lotObjects?.objects.values() ?? []) if (o.isPerson && (o.guid | 0) === (guid | 0)) return o;
    return null;
  }

  /** HouseViewerHooks: CenterHouseViewOnMe of an object of the module's list (cWinPeople::TrackPerson's toad). */
  centerOnObjectId(id: number, smooth: boolean): void {
    const o = this.lotObjects?.objects.get(id);
    if (o) this.centerOnObject(o, smooth);
  }

  // --- camera tracking (world/tracking.ts) -------------------------------------------

  /**
   * HouseViewer::UpdateWorld: the tracked object's Track (cXPerson::Track ->
   * SAnimator::Track(true), cXObject::Track -> Animator::Track(true)) while
   * no smooth scroll runs (+0x1a4). SAnimator::~SAnimator: a tracked object
   * gone from the lot is forgotten.
   */
  private updateTracking(nowMs: number): void {
    const o = getTrackedObject();
    const v = this.viewer;
    if (!o || !v) return;
    if (this.lotObjects?.objects.get(o.objectId) !== o) {
      setTrackedObject(null);
      return;
    }
    if (!v.isScrolling()) this.track(o, true, nowMs);
  }

  /**
   * Animator::Track(smooth) (Mac 0x10473800) and, for a person,
   * SAnimator::Track(smooth) (Mac 0x1034a310): an object that is shown
   * (+0x8e, object data 34) and in a room (+0x84, object data 29) on
   * another level switches the view to its level (HouseViewer::SetLevel,
   * SetDrawRoof(false), CPState::SetLevel) and centers it; on the view's
   * level it is centered (ScrollToCenter then SetDrawRoof(false)) once it
   * leaves the middle of the viewport. The point centered is `head / 2`
   * above its feet, head = (1 << (scale + 1)) * (lbl_105BCE4C 1/3 *
   * lbl_105C34D4 6) * (lbl_105BCE48: 2 * sqrt 6) pixels. The middle is
   * [w/4, 3w/4) x [h/4 + head, 3h/4); for a person on a route
   * (cXPerson::GetCurrentRoute) it is [16 << scale, w - (16 << scale)) x
   * [head * 9/8, h - head/8), and when the person follows a path (+0x180)
   * the center takes in the path points still ahead (+0x178 on), within
   * the middle's size less 32 pixels on each axis.
   */
  private track(o: PlacedObject, smooth: boolean, nowMs: number): void {
    const v = this.viewer;
    if (!v || o.hidden !== 0 || o.objectData[29]! < 0) return;
    const s = v.scale;
    const head = Math.trunc((1 << (s + 1)) * Math.fround(Math.fround(1 / 3) * 6) * Math.fround(2 * Math.sqrt(6)));
    const rot = v.world.rotation;
    const project = (fx: number, fy: number): { h: number; v: number } => {
      const [rx, ry] = RotatableWorld.rotateCoords(fx, fy, rot, 0x400);
      return v.tileToPointF(rx, ry, o.level, s);
    };
    const p = project(o.fx, o.fy);
    if (o.level !== v.level) {
      this.ctx.state.setLevel(o.level);
      this.setDrawRoofOff();
      v.scrollToCenter(p.h, p.v - Math.trunc(head / 2), smooth, nowMs);
      return;
    }
    const w = v.viewW;
    const h = v.viewH;
    const person = o.isPerson ? (this.sim?.module.persons.find((x) => x.obj === o) ?? null) : null;
    let left = Math.trunc(w / 4);
    let right = Math.trunc((3 * w) / 4);
    let top = Math.trunc(h / 4) + head;
    let bottom = Math.trunc((3 * h) / 4);
    if (person?.route) {
      left = 16 << s;
      right = w - left;
      top = Math.trunc((head * 9) / 8);
      bottom = h - Math.trunc(head / 8);
    }
    let cx = p.h;
    let cy = p.v;
    if (left <= cx && top <= cy && cx < right && cy < bottom) return;
    const anim = person?.animator;
    if (anim && anim.followState !== 0) {
      const maxW = right - left - 0x20;
      const maxH = bottom - top - 0x20;
      let x0 = cx;
      let x1 = cx + 1;
      let y0 = cy;
      let y1 = cy + 1;
      let doneX = false;
      let doneY = false;
      for (let i = anim.pathIndex; i < anim.path.length - 1 && (!doneX || !doneY); i++) {
        const pt = anim.path[i];
        if (!pt) continue;
        const q = project(pt.fx, pt.fy);
        if (!doneX) {
          if (q.h < x0) {
            x0 = q.h;
            if (maxW < x1 - q.h) {
              x0 = x1 - maxW;
              doneX = true;
            }
          } else if (x1 <= q.h) {
            x1 = q.h + 1;
            if (maxW < x1 - x0) {
              x1 = x0 + maxW;
              doneX = true;
            }
          }
        }
        if (!doneY) {
          if (q.v < y0) {
            y0 = q.v;
            if (maxH < y1 - q.v) {
              y0 = y1 - maxH;
              doneY = true;
            }
          } else if (y1 <= q.v) {
            y1 = q.v + 1;
            if (maxH < y1 - y0) {
              y1 = y0 + maxH;
              doneY = true;
            }
          }
        }
      }
      cx = Math.trunc((x0 + x1) / 2);
      cy = Math.trunc((y0 + y1) / 2);
    }
    v.scrollToCenter(cx, cy - Math.trunc(head / 2), smooth, nowMs);
    this.setDrawRoofOff();
  }

  /** HouseViewer::SetDrawRoof(false, false): +0x51 off (DirtyAll, CPState dirty 0x80) when it was on. */
  private setDrawRoofOff(): void {
    const v = this.viewer;
    if (!v?.drawRoof) return;
    v.drawRoof = false;
    if (v.walls instanceof WallManager) v.walls.drawRoof = false;
    v.dirty = true;
    this.ctx.state.setDirty(0x80);
  }

  centerOnPerson(guid: number | undefined, smooth = false): void {
    const v = this.viewer;
    const objs = this.lotObjects?.objects;
    if (!v || !objs) return;
    const people = [...objs.values()].filter((o) => o.isPerson && o.hidden === 0);
    const o = people.find((p) => p.guid === guid) ?? people[0];
    if (!o) return;
    const [fx, fy] = RotatableWorld.rotateCoords(o.fx, o.fy, v.world.rotation, 0x400);
    v.scrollToTile(fx, fy, o.level, smooth);
  }

  // --- HouseViewerHooks ---------------------------------------------------------

  setScale(zoom: number): void {
    this.viewer?.setScale(zoom);
    // HouseViewer::SetScale -> GlobalDispatch(0xf9, scale) -> cSimulator::DoCommand: global 2
    // (the tutorial's "detect zoom" reads it).
    if (this.sim) this.sim.globals[2] = zoom;
  }

  setRotation(rotation: number): void {
    this.viewer?.setRotation(rotation);
  }

  setLevel(level: number): void {
    this.viewer?.setLevel(level);
  }

  /** The right edge the picture-in-picture is placed against (ctx.hud), as of the last layout. */
  private pipRight = 0;
  /** The HUD's left edge (ctx.hud), as of the last layout. */
  private hudLeft = 0;

  /**
   * The port's live screen resize (ui/screenresize.ts): the 3D viewport takes
   * the new size (keeping what the control panel takes off its height), the
   * tutorial icon stays top-right and the picture-in-picture against the
   * HUD's right edge. The control panel is made again by the game
   * (game/main.ts Game.resizeScreen).
   */
  screenResized(oldW: number, oldH: number): void {
    const w = this.getW();
    const h = this.getH();
    const v = this.viewer;
    if (v) v.setViewportSize(w, this.hudBeside() ? h : v.viewH + h - oldH);
    if (this.edge) {
      // The scroll zones along the screen's right and bottom edges.
      this.edge.width = w;
      this.edge.height = h;
    }
    const left = this.ctx.hud?.left ?? 0;
    const right = this.ctx.hud?.right ?? w;
    const oldLeft = this.hudLeft;
    const oldRight = this.pipRight;
    this.hudLeft = left;
    this.pipRight = right;
    for (const c of this.children) {
      if (c === this.tutorialIcon) c.moveTo(c.area.left + w - oldW, c.area.top);
      else if (c instanceof WinPictureInPicture) c.moveTo(c.area.left + right - oldRight, c.area.top + h - oldH);
      // The control panel and the view control (until the panel is made again): with the HUD's left edge and the bottom.
      else if (c.area.bottom === oldH) c.moveTo(c.area.left + left - oldLeft, c.area.top + h - oldH);
    }
  }

  /**
   * The port's centred HUD (engine/display.ts hudBand) leaves the lot view
   * visible left and right of the control panel: the viewport then always
   * takes the view's whole height instead of stopping above the panel.
   */
  private hudBeside(): boolean {
    const hud = this.ctx.hud;
    return !!hud && (hud.left > 0 || hud.right < this.ctx.width);
  }

  setViewportHeight(height: number): void {
    if (this.hudBeside()) height = this.getH();
    const v = this.viewer;
    if (!v || v.viewH === height) return;
    v.setViewportHeight(height);
    this.frame = null;
  }

  /**
   * cDDDSimsView::DoMessage(0x1b): when the control panel (cSimsApp+0x84)
   * has faded in (BoboVision, cWinViewControl::SetMode), the viewport takes
   * the view's height less the panel's opaque part (its height - 0x32).
   */
  override doAsyncShowHideMessage(src: TSWin, dir: number): boolean {
    if ("viewControl" in src && dir > 0) this.setViewportHeight(this.getH() - (src.getH() - 0x32));
    return true;
  }

  setWallState(state: WallState): void {
    if (this.cutaway) this.cutaway.setWallState(state);
    else this.wallManager?.setWallState(state);
    if (this.viewer) this.viewer.dirty = true;
  }

  // --- painting / input -----------------------------------------------------------

  /** House +0x60 / +0x64: the size and furnishings score curves (Global.iff STR# 505). */
  private scoreFns: { size: PiecewiseFn; furnishings: PiecewiseFn } | null = null;
  private houseStatsAt = -Infinity;

  /**
   * cWinSubpanelHouse::TSPaint's House::GetHouseStats, into CPState for the
   * house page. Not part of the original (perf): computed twice a second in
   * Live mode rather than on every paint.
   */
  private updateHouseStats(nowMs: number): void {
    const sim = this.sim;
    const v = this.viewer;
    const lot = this.lotObjects;
    const rooms = this.rooms;
    if (!sim || !v || !lot || !rooms || this.ctx.state.getMode() !== Mode.Live || nowMs - this.houseStatsAt < 500) return;
    this.houseStatsAt = nowMs;
    const stats = this.computeHouseStats();
    if (stats) this.ctx.state.houseStats = stats;
  }

  /** House::GetHouseStats of this lot (null before the simulator, the view and the rooms exist). */
  private computeHouseStats(): HousePageStats | null {
    const sim = this.sim;
    const v = this.viewer;
    const lot = this.lotObjects;
    const rooms = this.rooms;
    if (!sim || !v || !lot || !rooms) return null;
    if (!this.scoreFns) {
      const curves = sim.module.res.glob ? loadStringSet(sim.module.res.glob, STR_HOUSE_SCORE_CURVES) : null;
      this.scoreFns = { size: piecewiseFromText(curves?.[0]), furnishings: piecewiseFromText(curves?.[1]) };
    }
    return getHouseStats({
      fixed: v.world.fixed,
      rooms: rooms.inUseRooms(),
      objects: new Map(moduleOrder(lot.module).map((o) => [o.objectId, o])),
      members: this.ctx.state.family.length,
      objectValue: sim.objectValue,
      archValue: sim.archValue,
      layout: sim.layoutHistory ?? clearLayoutHistory(),
      sizeFn: this.scoreFns.size,
      furnishingsFn: this.scoreFns.furnishings,
    });
  }

  override pump(nowMs: number): void {
    this.updateHouseStats(nowMs);
    // cDDDSimsView::Draw -> UpdateActionIcons.
    this.actionIcons.update(this.sim ? this.selectedPerson() : null, !!this.sim && this.ctx.state.getMode() === Mode.Live, nowMs);
    this.edge?.pump(nowMs, winMgr.cursorInside);
    this.viewer?.pump(nowMs);
    this.cutaway?.updateWorld();
    this.updateTracking(nowMs);
    this.updateTimeOfDay();
    // HouseViewer::PrepareWorldForUpdate: RoomManager::UpdateRooms (a changed room light dispatches 0xf1: redraw).
    if (this.lighting?.updateRooms() && this.viewer) this.viewer.dirty = true;
    // cDDDSimsView::Draw: cTutorialIcon::Animate.
    this.tutorialIcon?.animate();
    if (this.sim && this.viewer) {
      this.sim.syncFromState();
      // Tut_CheckForEvents, right before cSimulator::Simulate.
      if (this.tutEvents) tutCheckForEvents(this.tutEvents, findPeoplePopup(winMgr.main));
      this.sim.simulate(nowMs);
      // ObjectModule::SetSelectedPerson (CPState's selection), then HouseViewer's ObjectModule::UpdatePlumbBobs.
      if (this.plumbBobs) {
        this.plumbBobs.setSelectedPerson(this.selectedPerson()?.obj ?? null);
        this.plumbBobs.updatePlumbBobs();
      }
    }
    if (this.viewer && this.people?.people.length) {
      this.people.update(nowMs);
      this.viewer.dirty = true;
    }
    // HouseViewer::UpdateWorld: VBAnimMgr::TryUnloadSkills.
    if (this.viewer) tryUnloadSkills(nowMs);
    super.pump(nowMs);
  }

  /** cDDDSimsView+0x11b4: the global cursor StartWatchCursor replaced; +0x11b8: the watch is on. */
  private watchSaved: string | null = null;
  private watchOn = false;
  /** The work under the watch is over: the next paint ends it (the original paints only once it returns). */
  private watchDone = false;

  /** cDDDSimsView::StartWatchCursor: the hourglass everywhere until the view paints again. */
  startWatchCursor(): void {
    if (!this.watchOn) this.watchSaved = winMgr.getGlobalCursor();
    winMgr.setGlobalCursor(getCursor(3), true);
    this.watchOn = true;
    this.watchDone = false;
  }

  /** The synchronous work of the original is done: let TSPaint end the watch cursor. */
  endWatchCursor(): void {
    this.watchDone = true;
  }

  override tsPaint(g: Gfx): void {
    // cDDDSimsView::TSPaint: the watch cursor ends (SetGlobalCursor(0, true), then the saved one unforced).
    if (this.watchOn && this.watchDone) {
      winMgr.setGlobalCursor(null, true);
      winMgr.setGlobalCursor(this.watchSaved, false);
      this.watchOn = false;
    }
    const v = this.viewer;
    if (!v) {
      g.fill(0, 0, this.getW(), this.getH(), "#000");
      return;
    }
    if (v.dirty) {
      v.render();
      // HouseViewer::UpdateWorld: the snapshot TakeAsyncSnapshot asked for, out of this frame.
      const snap = this.pendingSnapshot;
      this.pendingSnapshot = null;
      if (snap) void takeAsyncSnapshot(this.ctx, v.comp.canvas, snap.rect, false, snap.description);
      // A frame rendered for this paint is read back once, straight to the screen.
      g.ctx.drawImage(v.comp.canvas, g.ox, g.oy);
      this.frameStale = true;
    } else {
      // Frames repainted without a render reuse one copy (one readback per rendered frame).
      if (this.frameStale || !this.frame || this.frame.width !== v.comp.width || this.frame.height !== v.comp.height) {
        if (this.frame?.width !== v.comp.width || this.frame.height !== v.comp.height) this.frame = new OffscreenCanvas(v.comp.width, v.comp.height);
        this.frame.getContext("2d")!.drawImage(v.comp.canvas, 0, 0);
        this.frameStale = false;
      }
      g.ctx.drawImage(this.frame, g.ox, g.oy);
    }
    // HouseViewer::UpdateStaticDynamic: the pie's round shadow, then the
    // popup head over the 3D pass (SAnimator::GetPopupHeadLocation / RenderPopupHead).
    const clip = { left: g.ox, top: g.oy, right: g.ox + this.getW(), bottom: g.oy + this.getH() };
    const loc = getPopupHeadLocation();
    if (loc) renderRoundShadow(g.ctx, clip, loc.x, loc.y, loc.z);
    renderPopupHead(g.ctx, clip);
    // cDDDSimsView::TSPaint: the anchor buffer, centered on the anchor point (SetAnchorPoint).
    const a = this.anchor;
    const img = this.exploreAnchor;
    if (a && img) g.blit(img, a.x - Math.trunc(img.width / 2), a.y - Math.trunc(img.height / 2));
    // HouseViewer::UpdateWorld: the camera frame on the cursor in camera mode.
    if (this.cursor && this.ctx.state.getMode() === Mode.Camera) drawCameraFrame(g, computeCameraFrame(this.ctx, this.cursor.x, this.cursor.y, v.viewW, v.viewH));
  }

  /** EdgeDetectScroller::OnKeyDown: arrows scroll (VK_LEFT 0x25 .. VK_DOWN 0x28). */
  override tsOnKeyDown(key: string): boolean {
    const v = this.viewer;
    if (!v) return false;
    // cDDDSimsView::TSOnKeyDown: the scrolling strategy (+0x16c) takes the key first (Alt: the pan).
    if (key === "Alt" && this.edge?.onAltDown()) return true;
    // cDDDSimsView::TSOnKeyDown: F1..F5 switch the control panel mode.
    if (modeKeyDown(this.ctx.state, key)) return true;
    // cDDDSimsView::TSOnKeyDown: Tab / Page Up / Page Down (level), Home / End (walls), Shift / Ctrl arrows, F10.
    const keyHooks = {
      cursorOverView: (): boolean => {
        const p = winMgr.cursorPosition();
        return winMgr.main.windowFromPoint(p.x, p.y) === this;
      },
      screenBuffer: () => v.comp.canvas,
    };
    if (viewKeyDown(this.ctx.state, key, keyHooks)) return true;
    // cDDDSimsView::TSOnKeyDown: Escape is Neighborhood::CancelTutorial, then the tutorial arrow hides.
    if (key === "Escape" && this.sim) {
      cancelTutorial(this.sim.module);
      hideTutorialHighlighter();
    }
    // cDDDSimsView::TSOnKeyDown: Enter in Live mode is cWinPeople::TrackPerson(the selected person).
    if (key === "Enter" && this.ctx.state.getMode() === Mode.Live) {
      const guid = this.ctx.state.personGetSelected()?.guid;
      if (guid !== undefined) trackPerson(this.getPersonInstance(guid));
    }
    // cDDDSimsView::TSOnCharacter (WM_CHAR: none while Ctrl or Alt is down):
    // speed, pause, zoom and catalog page keys, then the tool, then rotation.
    const typed = !winMgr.isKeyDown("Control") && !winMgr.isKeyDown("Alt");
    const cpanel = this.children.find((c): c is WinCPanel => c instanceof WinCPanel) ?? null;
    const chr = typed ? characterBeforeTool(this.ctx.state, this.ctx.strings, cpanel, key) : { done: false, ch: key };
    if (chr.done) return true;
    if (this.activeTools()?.keyDown(key)) return true;
    if (typed && characterAfterTool(this.ctx, chr.ch)) return true;
    // cObjPickerTool::OnChar (Live mode): Space advances the selected person
    // and centers the view on them (CenterHouseViewOnMe), N only advances.
    if (this.sim && this.ctx.state.getMode() === Mode.Live && (key === " " || key === "n" || key === "N")) {
      this.advanceSelectedPerson();
      // (CenterHouseViewOnMe(person, 1) scrolls smoothly; this one jumps)
      const next = key === " " ? this.selectedPerson() : null;
      if (next) {
        // cWinPeople::StopTracking unless the new selected person is the tracked object.
        if (next.obj !== getTrackedObject()) stopTracking();
        this.centerOnPerson(this.ctx.state.personGetSelected()?.guid);
      }
      return true;
    }
    const tw = 16 << v.scale;
    // EdgeDetectScroller::OnKeyDown: an arrow (no Shift / Ctrl, not scrolling) first stops the tracking.
    if (key.startsWith("Arrow")) stopTracking();
    switch (key) {
      case "ArrowLeft":
        v.asyncScroll(tw, 0);
        return true;
      case "ArrowRight":
        v.asyncScroll(-tw, 0);
        return true;
      case "ArrowUp":
        v.asyncScroll(0, tw >> 1);
        return true;
      case "ArrowDown":
        v.asyncScroll(0, -(tw >> 1));
        return true;
      default:
        return false;
    }
  }

  /** cDDDSimsView::TSOnKeyUp: the scrolling strategy first (EdgeDetectScroller::OnKeyUp: Alt ends the pan). */
  override tsOnKeyUp(key: string): boolean {
    return key === "Alt" && !!this.edge?.onAltUp();
  }

  /**
   * cDDDSimsView::TSOnMouseUpR -> EdgeDetectScroller::OnMouseUpR: ends a
   * right drag, or (a click, the left button up) CenterView: scroll the
   * clicked tile to the center. Releases the capture.
   */
  override tsOnMouseUpR(x: number, y: number): boolean {
    const v = this.viewer;
    if (!v) return false;
    const edge = this.edge;
    if (!edge) return true;
    winMgr.releaseCapture(this);
    if (!edge.onMouseUpR(winMgr.isLeftButtonDown())) return true;
    // EdgeDetectScroller::OnMouseUpR: cWinPeople::StopTracking, SetTrackedObject(0), CenterView.
    stopTracking();
    setTrackedObject(null);
    const w = v.world;
    const t = v.pointToWholeTile(x, y, v.level);
    const n = w.size - 2;
    const cx = Math.min(Math.max(t.x - w.minX, 1), n) + w.minX;
    const cy = Math.min(Math.max(t.y - w.minY, 1), n) + w.minY;
    v.scrollToTile((cx << 4) | 8, (cy << 4) | 8, v.level, true);
    return true;
  }

  override tsOnMouseMove(x: number, y: number): boolean {
    this.edge?.onMouseMove(x, y);
    this.cursor = { x, y };
    // EdgeDetectScroller::OnMouseMove: no HouseViewer::MouseTrack while the Alt pan is on.
    if (this.edge?.panning) return this.viewer !== null;
    this.cutaway?.mouseTrack(x, y);
    this.activeTools()?.mouseTrack(x, y);
    if (this.ctx.state.getMode() === Mode.Live) {
      if (this.overChild(x, y)) this.tip = null;
      else this.liveFloat(x, y);
    }
    return this.viewer !== null;
  }

  /** cObjPickerTool +0x2e: the hilited object, and whether the selected person has interactions on it (hilite 1 / 8). */
  private liveHilite = 0;
  private liveHiliteAvail = false;

  /**
   * cObjPickerTool::SetHiliteObject(id): when `id` is not the hilite
   * (+0x2e), the old hilite object loses +0x114 bits 1 and 8; BuildTreeList
   * makes the selected person's interactions on the new object (on its
   * interaction leader here, as TryClick's ObjTestSim); with entries, the
   * first entry's object gets bit 1 (drawn brightened by DrawIso) and
   * becomes the hilite, otherwise the object itself gets bit 8 (no look).
   */
  private setHiliteObject(id: number, person: PersonSim | null): void {
    const sim = this.sim;
    if (!sim || id === this.liveHilite) return;
    const old = this.liveHilite ? sim.module.getObject(this.liveHilite) : null;
    if (old) {
      this.setHilite(old.obj, old.obj.objFlags & 0x1e);
      this.setHilite(old.obj, old.obj.objFlags & 0x17);
    }
    let target = id ? sim.module.getObject(id) : null;
    let entries = 0;
    if (target) {
      const leader = target.getInteractionLeader();
      entries = person ? person.menuItemsFor(leader).length : 0;
      let bit = 8;
      if (entries > 0) {
        bit = 1;
        target = leader;
      }
      id = target.id;
      this.setHilite(target.obj, bit | (target.obj.objFlags & 0x1f));
    }
    this.liveHilite = id;
    this.liveHiliteAvail = entries > 0;
  }

  /**
   * cXObject::SetHilite: +0x114 bits 0..4 become `flags`. A multi-tile
   * object (OBJD master id) that is not dynamic (cXMTObject::IsDynamic: no
   * entry point 8) sets every part of its chain from the lead. A changed
   * object goes to the dynamic layer (SetRenderLayer(1) on the top of its
   * placement hierarchy) so that it is drawn again: this port re-renders the
   * whole view, the layer move stands as a redraw.
   */
  private setHilite(obj: XObject, flags: number): void {
    const p = this.placement;
    const parts = p && obj.selector.objd.masterId !== 0 && ObjFnTable.forSelector(obj.selector).getTreeID(EP.dynamicMultiTileUpdate) === 0 ? p.chain(obj) : [obj];
    for (const o of parts) {
      if ((o.objFlags & 0x1f) === (flags & 0x1f)) continue;
      o.objFlags = (o.objFlags & ~0x1f) | (flags & 0x1f);
      if (this.viewer) this.viewer.dirty = true;
    }
  }

  /** Float: cObjPickerTool +0x68 = id, then cDDDSimsView::SetToolCursor(id). */
  private setPickerCursor(id: number): void {
    this.pickerCursor = id;
    this.setToolCursor(id);
  }

  /** cObjPickerTool +0x68: the cursor id the last Float chose (read by Click). */
  private pickerCursor = 0;

  /**
   * cObjPickerTool::Float (Live mode): the object under the mouse
   * (HouseViewer::PointToObjectID, on the current level) becomes the hilite
   * (SetHiliteObject builds its interaction list for the selected person);
   * the cursor and tip follow it: a person shows its first name
   * (cTool::SetToolTip) with LivePerson (LivePet for pets but the GUID
   * 0xFC697613), an object LiveObjectAvail when the selected person has
   * interactions on it, else LiveObjectUnavail; nothing is LiveNothing
   * (LiveNothingPet with a pet selected), or LiveObjectUnavail off the lot's
   * edge.
   */
  private liveFloat(x: number, y: number): void {
    const sim = this.sim;
    const v = this.viewer;
    const p = this.placement;
    const lot = this.lotObjects;
    if (!sim || !v || !p || !lot) return;
    const person = this.selectedPerson();
    const people = this.people;
    // Float: Animator::SetPickingObject(1), or 0 without a selected person (the cursor point
    // stands for Animator::Render's GetCursorPos).
    if (people) people.pickPoint = person ? { x, y } : null;
    const id = person ? this.pickedPersonId(pointToObjectId(v, p, (r) => lot.renderer(r), x, y, v.level || 1, PickMode.Any, people ? (o) => people.screenRect(o, v) : null, sim.globals[G.modeFreeze])) : 0;
    const target = id ? sim.module.getObject(id) : null;
    // Float: an object hidden by +0x8e is no hilite.
    this.setHiliteObject(target && target.obj.hidden === 0 ? target.id : 0, person);
    if (!target) {
      this.tip = null;
      const t = v.pointToWholeTile(x, y, v.level || 1);
      const w = v.world;
      const outside = t.x < w.minX + 1 || t.x > w.maxX - 1 || t.y < w.minY + 1 || t.y > w.maxY - 1;
      const pet = !!person && ((person.pd[PDX.gender] ?? 0) & 6) !== 0;
      this.setPickerCursor(outside ? 0x1f : pet ? 0x2b : 0x1c);
      return;
    }
    const sel = target.obj.selector;
    if (target.person) {
      if (sel.objd.i16(0xb6) & 4) {
        this.tip = null;
        this.setPickerCursor(0x1f);
        return;
      }
      const guid = sel.guid | 0;
      const st = this.ctx.state;
      const info = [...st.family, ...st.neighbors].find((q) => q.guid !== undefined && (q.guid | 0) === guid);
      const pet = ((target as PersonSim).pd[PDX.gender] ?? 0) & 6;
      if (info?.firstName && this.tipWin) this.tip = { win: this.tipWin, x: x + 0x11, y: y - 5, text: info.firstName };
      else this.tip = null;
      this.setPickerCursor(pet && (guid >>> 0) !== 0xfc697613 ? 0x2a : 0x1d);
      return;
    }
    this.tip = null;
    this.setPickerCursor(this.liveHiliteAvail ? 0x1e : 0x1f);
  }

  override tsOnMouseExit(): void {
    this.edge?.stop();
    if (this.ctx.state.getMode() === Mode.Live) this.tip = null;
    this.cursor = null;
    this.buttonDown = false;
    this.activeTools()?.exitWorld();
  }

  /**
   * cDDDSimsView::TSOnMouseDownR -> EdgeDetectScroller::OnMouseDownR: the
   * view takes the capture; in Live mode a press on a member of the selected
   * person's family (person data 0x3d) who is not a guest (person data 77 <
   * 1) selects them (CPState::SetSelectedPerson), except on houses 21..30;
   * otherwise the press may become a drag (see EdgeDetectScroller).
   */
  override tsOnMouseDownR(x: number, y: number): boolean {
    const v = this.viewer;
    if (!v) return false;
    if (this.overChild(x, y)) return true;
    winMgr.setCapture(this);
    this.edge?.onMouseDownR(x, y, winMgr.isKeyDown("Shift"), () => this.rightClickSelect());
    return true;
  }

  /**
   * cObjPickerTool::Float (Mac 0x1017ce90): Animator::PickedObject, when it
   * is a person (dynamic_cast cXPerson) on the current level
   * (cTool::GetCurrentLevel), replaces the object MouseTrack found under the
   * cursor (HouseViewer::PointToObjectID). People are picked by the pixels
   * their meshes drew (Animator::Render), not by their tile.
   */
  private pickedPersonId(id: number): number {
    const picked = this.people?.pickedObject ?? null;
    const v = this.viewer;
    if (!picked || !v || !this.sim?.module.getObject(picked.objectId)?.person || picked.level !== (v.level || 1)) return id;
    return picked.objectId;
  }

  /** EdgeDetectScroller::OnMouseDownR's Live-mode part: Animator::PickedObject as a cXPerson (not PointToObjectID). */
  private rightClickSelect(): boolean {
    const sim = this.sim;
    const st = this.ctx.state;
    if (!sim || !this.viewer || st.getMode() !== Mode.Live) return false;
    const pickedObj = this.people?.pickedObject ?? null;
    const picked = pickedObj ? sim.module.getObject(pickedObj.objectId) : null;
    const selected = this.selectedPerson();
    if (!picked?.person || !selected) return false;
    const house = sim.globals[G.houseNumber]!;
    const pd = picked.person.personData;
    if (pd[PDX.familyNumber] !== selected.pd[PDX.familyNumber] || pd[77]! >= 1 || (house > 0x14 && house < 0x1f)) return false;
    const guid = picked.obj.selector.guid | 0;
    const i = st.family.findIndex((f) => ((f.guid ?? 0) | 0) === guid);
    if (i < 0) return false;
    st.setSelectedPerson(i);
    return true;
  }
}
