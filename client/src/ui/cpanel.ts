// Authentic TS1 Control Panel — bottom-of-screen 100px strip composed of real
// Maxis bitmaps from UIGraphics.far. Replaces the previous fabricated panel.
//
// Layout (left → right):
//   • LiveGadget  108×100   — arched left widget that hosts the Sim portrait.
//   • Motives strip — the 8 motive bars (host: data-slot-body="motives").
//   • Mode content slot — Live tabs / Buy catalog / Build tools (host:
//     data-slot-body="center"). The mode patch BMP (LivePatch / BuyPatch /
//     BuildPatch) sits underneath it as the rounded chrome.
//   • Time + funds + speed widget (host: data-slot-body="time").
//   • Mode tabs strip + Options + Camera + Back patches on the far right
//     (host: data-slot-body="tabs").
//
// The id stays `#ts1-panel` and the `data-slot-body=*` hooks keep their names
// so the existing renderMotivesHud / renderTimeFundsHud / renderFamilyHud
// helpers in main.ts continue feeding the right targets.
//
// Background:
//   • PanelBack.png (804×100) is tiled horizontally across the full width so
//     the chrome stretches without distortion.
//
// All BMPs come from /assets/converted/ui/cpanel/ (gitignored, populated by
// `node scripts/extract-ui-graphics.mjs`).

import { UI_BASE } from "./bmp";

/** Tear down + rebuild the control panel container. Idempotent. */
export function mountCpanel(): HTMLDivElement {
  document.getElementById("ts1-panel")?.remove();

  const panel = document.createElement("div");
  panel.id = "ts1-panel";
  // The base strip — fixed 100px tall, full viewport width, tiled PanelBack.
  panel.style.cssText = [
    "position:fixed",
    "left:0",
    "right:0",
    "bottom:0",
    "height:100px",
    "z-index:80",
    `background:url("${UI_BASE}/Backgrounds/PanelBack.png") repeat-x left center`,
    "background-size:auto 100%",
    "font:11px/1.2 \"MS Sans Serif\",Geneva,Tahoma,sans-serif",
    "color:#ffdf80",
    "image-rendering:pixelated",
    "overflow:visible",
    "user-select:none",
  ].join(";");

  // LiveGadget — the arched left widget. Fixed 108×100 at the bottom-left.
  // The Sim portrait will dock inside via the family slot.
  const liveGadget = document.createElement("div");
  liveGadget.id = "cpanel-livegadget";
  liveGadget.style.cssText = [
    "position:absolute",
    "left:0",
    "bottom:0",
    "width:108px",
    "height:100px",
    `background:url("${UI_BASE}/Backgrounds/LiveGadget.png") no-repeat 0 0`,
    "background-size:108px 100px",
    "image-rendering:pixelated",
  ].join(";");
  // Inner host for the portrait + name + mood ring (the renderFamilyHud feed).
  const family = document.createElement("div");
  family.dataset["slotBody"] = "family";
  family.style.cssText = [
    "position:absolute",
    "left:8px",
    "top:6px",
    "right:8px",
    "bottom:6px",
    "display:flex",
    "flex-direction:column",
    "align-items:center",
    "justify-content:center",
    "gap:2px",
    "pointer-events:auto",
    "overflow:hidden",
  ].join(";");
  liveGadget.appendChild(family);
  panel.appendChild(liveGadget);

  // Motives strip — directly to the right of LiveGadget. The 8 bars are
  // populated by renderMotivesHud(); we just reserve the slot here at
  // authentic dimensions (8 × 40px wide = 320px).
  const motivesWrap = document.createElement("div");
  motivesWrap.id = "cpanel-motives-wrap";
  motivesWrap.style.cssText = [
    "position:absolute",
    "left:114px",
    "bottom:4px",
    "width:340px",
    "height:92px",
    "display:flex",
    "flex-direction:column",
    "gap:2px",
    "padding:4px 4px 2px 4px",
    "color:#ffdf80",
  ].join(";");
  const motivesSlot = document.createElement("div");
  motivesSlot.dataset["slotBody"] = "motives";
  motivesSlot.style.cssText = "flex:1;display:flex;flex-direction:column;gap:1px;overflow:hidden;";
  motivesWrap.appendChild(motivesSlot);
  panel.appendChild(motivesWrap);

  // Centre slot — sub-tabs (Live), catalogue (Buy), or tool palette (Build).
  // The active mode patch BMP underlays it. Dimensions follow LivePatch
  // (213×153) which is the largest of the three so it provides enough room
  // for the tallest mode. The patch BMPs are placed via setCpanelMode().
  const centerWrap = document.createElement("div");
  centerWrap.id = "cpanel-center-wrap";
  centerWrap.style.cssText = [
    "position:absolute",
    "left:464px",
    "bottom:0",
    "width:230px",
    "height:154px", // sticks up above the 100px base for the patches
    "pointer-events:none",
  ].join(";");
  const patchLayer = document.createElement("div");
  patchLayer.id = "cpanel-patch-layer";
  patchLayer.style.cssText = "position:absolute;left:0;right:0;bottom:0;top:0;pointer-events:none;";
  centerWrap.appendChild(patchLayer);
  const centerSlot = document.createElement("div");
  centerSlot.dataset["slotBody"] = "center";
  centerSlot.style.cssText = [
    "position:absolute",
    "left:6px",
    "right:6px",
    "top:6px",
    "bottom:4px",
    "pointer-events:auto",
    "overflow:hidden",
    "color:#ffdf80",
  ].join(";");
  centerWrap.appendChild(centerSlot);
  panel.appendChild(centerWrap);

  // Time / funds / speed — clock area. Sits to the right of the center patch.
  const timeWrap = document.createElement("div");
  timeWrap.id = "cpanel-time-wrap";
  timeWrap.style.cssText = [
    "position:absolute",
    "right:200px",
    "bottom:4px",
    "width:180px",
    "height:92px",
    "padding:4px 6px",
    "color:#ffdf80",
  ].join(";");
  const timeSlot = document.createElement("div");
  timeSlot.dataset["slotBody"] = "time";
  timeSlot.style.cssText = "display:flex;flex-direction:column;gap:4px;height:100%;";
  timeWrap.appendChild(timeSlot);
  panel.appendChild(timeWrap);

  // Mode tabs + ancillary patches (Options / Camera / Back). The tabs trigger
  // mode switches; the OptionsPatch / CameraPatch / BackPatch BMPs decorate
  // the right edge of the panel.
  const tabsWrap = document.createElement("div");
  tabsWrap.id = "cpanel-tabs-wrap";
  tabsWrap.style.cssText = [
    "position:absolute",
    "right:0",
    "bottom:0",
    "width:200px",
    "height:100px",
    "display:flex",
    "align-items:flex-end",
    "justify-content:flex-end",
    "padding:0",
  ].join(";");
  const tabsSlot = document.createElement("div");
  tabsSlot.dataset["slotBody"] = "tabs";
  tabsSlot.style.cssText =
    "display:flex;flex-direction:row;align-items:flex-end;gap:0;height:100%;";
  tabsWrap.appendChild(tabsSlot);
  panel.appendChild(tabsWrap);

  document.body.appendChild(panel);
  return panel;
}

/** Update the patch background (LivePatch / BuyPatch / BuildPatch / OptionsPatch)
 * to match the current mode. The patch overlays the center slot from the
 * underneath, providing the rounded chrome that surrounds the mode-specific
 * content. */
export function setCpanelMode(mode: "play" | "buy" | "build" | "options"): void {
  const layer = document.getElementById("cpanel-patch-layer");
  if (!layer) return;
  // Map each mode to its background BMP + native dimensions. The patch is
  // anchored to the bottom of the centerWrap so the over-height portion sticks
  // up naturally above the 100px panel base.
  const PATCHES: Record<typeof mode, { file: string; w: number; h: number }> = {
    play: { file: "LivePatch.png", w: 213, h: 153 },
    buy: { file: "BuyPatch.png", w: 156, h: 148 },
    build: { file: "BuildPatch.png", w: 107, h: 132 },
    options: { file: "OptionsPatch.png", w: 37, h: 100 },
  };
  const p = PATCHES[mode];
  layer.style.cssText = [
    "position:absolute",
    "left:50%",
    "bottom:0",
    `width:${p.w}px`,
    `height:${p.h}px`,
    "transform:translateX(-50%)",
    `background:url("${UI_BASE}/Backgrounds/${p.file}") no-repeat 0 0`,
    `background-size:${p.w}px ${p.h}px`,
    "image-rendering:pixelated",
    "pointer-events:none",
  ].join(";");
}
