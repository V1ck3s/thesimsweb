/**
 * UI sound events: the event names the game's UI code passes to
 * cSoundPlayer::PlayBySource (source -4 = PlaySoundA, the UI), recovered
 * from the Mac build's string tables. They resolve through the .hot
 * [EventMapping] tables (SimsGeneratedHitSource.hot: ui_* -> track -> patch
 * "SoundData\UI\*.xa").
 */

/** Source id the UI plays with (PlaySoundA__FPCc). */
export const UI_SOURCE = -4;

export const UI = {
  /** cTSWinBtn default for a press (OverrideDefaultUISound). */
  click: "UI_click",
  /** cTSWinBtn default for a press on a disabled button; cTool::DoDeniedSound. */
  error: "UI_error",
  /** cWinLivePopup / cWinCatalogPopup sliding in. */
  whoosh: "UI_whoosh",
  /** cTSPieMenu: popup, item rollover, item chosen. */
  pieAppear: "UI_piemenu_appear",
  pieHighlight: "UI_piemenu_highlight",
  pieSelect: "UI_piemenu_select",
  /** cTool: DoSlideSound, DoExplodeSound, DoRefundSound, DoKachingSound. */
  objectRotate: "UI_object_rotate",
  archtoolDelete: "UI_archtool_delete",
  moneyback: "UI_moneyback",
  buyMoneyback: "UI_buy_moneyback",
  objectPlace: "UI_object_place",
  objectMovePlace: "UI_object_move_place",
  objectMove: "UI_object_move",
  buyPlace: "UI_buy_place",
  dragtoolDown: "UI_bld_dragtool_mousedown",
  dragtoolUp: "UI_bld_dragtool_mouseup",
  terrainLevel: "Ui_terrain_level",
  terrainRaise: "Ui_terrain_raise",
  terrainLower: "Ui_terrain_lower",
  cameraPhoto: "ui_camera_photo",
  queueDelete: "UI_queue_delete",
  queued: "UI_queued",
  /** Neighborhood screen (cWinNeighborhoodUL): default button press, house rollover, errors, bulldozer. */
  nhoodClick: "UI_Nhood_click",
  nhoodRollover: "UI_Nhood_rollover",
  nhoodError: "UI_NHood_error",
  nhoodBdoze: "UI_Nhood_bdoze",
  nhoodBdozeCancel: "UI_Nhood_bdoze_cancel",
  nessie: "nessie_sfx",
  /** Create-a-character (cWinDesignCharacter / cWinPersonalityWidget). */
  cacCycleParts: "UI_CAC_CycleParts",
  cacCycleHead: "UI_CAC_Cyclehead",
  cacPersonPts: "UI_CAC_personpts",
  help: "ui_help",
} as const;

/** Music mode events (SimsSound.hot, kSetMusicMode). */
export const MUSIC = {
  live: "bkground_live",
  buy: "bkground_buy1",
  build: "bkground_build",
  hood: "bkground_nhood1",
  load: "bkground_load",
  credits: "bkground_credits",
  camera: "bkground_camera",
  options: "bkground_options",
  family: "bkground_family",
  fade: "bkground_fade",
} as const;

/** The lot CPState::UpdateWorldFromCPState picks the mode music for. */
export interface ModeMusicLot {
  /** Simulator global 10. */
  house: number;
  /** Simulator global 0x20 (cSimulator +0x50): visited without the family (town and community lots). */
  visiting: boolean;
  /** Neighborhood::GetZoningType(house) === 2. */
  community: boolean;
}

/**
 * CPState::UpdateWorldFromCPState (dirty bit 2, after QuietBySourceID(-1)):
 * the music event of a control panel mode (CPState mode 0 Build, 1 Buy,
 * 2 Live, 3 Options, 4 Camera), from the lot. null: nothing plays (Build on
 * a visited lot).
 */
export function modeMusicEvent(mode: number, lot: ModeMusicLot): string | null {
  const h = lot.house;
  const magicTownHome = h > 0x59 && h < 0x5d;
  const magicTownShop = h > 0x5c && h < 99;
  switch (mode) {
    case 2:
      return MUSIC.live;
    case 1:
      if (!lot.visiting) return magicTownHome ? "music_magictown_buy" : MUSIC.buy;
      if (h > 0x27 && h < 0x32) return "station_vacation";
      if (lot.community && !magicTownShop) return "station_unleashed";
      if (h > 0x50 && h < 0x5a) return "station_superstar";
      if (magicTownShop) return "music_magictown";
      return "station_dtbuy";
    case 0:
      if (lot.visiting) return null;
      return magicTownHome ? "music_magictown_build" : MUSIC.build;
    case 4:
      return MUSIC.camera;
    case 3:
      return "bkground_option";
    default:
      return null;
  }
}

/**
 * cWinViewControl::DoSpeedTransitionSound: "UI_speed_<from>to<to>", where a
 * speed is 1..3 and 0 means paused ("P").
 */
export function speedTransitionSound(from: number, to: number): string {
  const s = (v: number): string => (v <= 0 ? "P" : String(Math.min(3, v)));
  return `UI_speed_${s(from)}to${s(to)}`;
}
