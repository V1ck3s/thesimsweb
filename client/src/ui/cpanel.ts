// Authentic TS1 Control Panel — bottom-of-screen 100px strip composed of real
// Maxis bitmaps from UIGraphics.far. Replaces the previous fabricated panel.
//
// Layout (left → right):
//
//   ┌─ LivePatch / BuyPatch / BuildPatch (arch overlay, anchored bottom-left,
//   │  sticks up ~50px above the 100px base; hosts the active Sim portrait,
//   │  name and the mode-specific sub-tabs / catalog).
//   │
//   ├─ Motives strip — 8 stacked bars to the right of the patch arch.
//   │
//   ├─ Center content slot — built by mountLiveCenter / mountBuyCenter /
//   │  mountBuildCenter (data-slot-body="center").
//   │
//   ├─ Time + funds + speed widget (data-slot-body="time").
//   │
//   └─ Mode tabs strip + Options / Camera / Back patches on the far right
//      (data-slot-body="tabs").
//
// Internal slot hooks (data-slot-body=*) keep their names so the existing
// renderMotivesHud / renderTimeFundsHud / renderFamilyHud helpers in main.ts
// continue feeding the right targets without refactor.
//
// Backgrounds:
//   • PanelBack.png (804×100) is tiled horizontally across the full width so
//     the chrome stretches without distortion.
//   • LivePatch / BuyPatch / BuildPatch are anchored bottom-left so their
//     over-height portion (≥100px) sticks up naturally above the base strip,
//     matching how the original game frames its mode UIs.

import { UI_BASE } from "./bmp";

const PANEL_BASE_H = 100;

// Native sizes of each mode patch BMP. Anchored to the bottom-left of the
// panel so anything taller than 100px overhangs upward.
const PATCH_DIMS: Record<"play" | "buy" | "build" | "options", { file: string; w: number; h: number }> = {
  play: { file: "LivePatch.png", w: 213, h: 153 },
  buy: { file: "BuyPatch.png", w: 156, h: 148 },
  build: { file: "BuildPatch.png", w: 107, h: 132 },
  options: { file: "OptionsPatch.png", w: 37, h: 100 },
};

/** Tear down + rebuild the control panel container. Idempotent. */
export function mountCpanel(): HTMLDivElement {
  document.getElementById("ts1-panel")?.remove();

  const panel = document.createElement("div");
  panel.id = "ts1-panel";
  panel.style.cssText = [
    "position:fixed",
    "left:0",
    "right:0",
    "bottom:0",
    `height:${PANEL_BASE_H}px`,
    "z-index:80",
    `background:url("${UI_BASE}/Backgrounds/PanelBack.png") repeat-x left bottom`,
    "background-size:auto 100%",
    "background-color:#0d1a3a", // dark navy fallback so blank tiles don't show black
    "font:11px/1.2 \"MS Sans Serif\",Geneva,Tahoma,sans-serif",
    "color:#ffdf80",
    "image-rendering:pixelated",
    "overflow:visible",
    "user-select:none",
  ].join(";");

  // Mode patch arch — bottom-left anchored, dimensions set per-mode by
  // setCpanelMode(). The patch *is* the chrome that hosts the active-mode
  // content (portrait+motives in Live, catalog tabs in Buy, tool palette in
  // Build). Default values come from setCpanelMode() at boot.
  const patchWrap = document.createElement("div");
  patchWrap.id = "cpanel-patch-wrap";
  patchWrap.style.cssText = [
    "position:absolute",
    "left:0",
    "bottom:0",
    "width:213px",
    "height:153px",
    "background-repeat:no-repeat",
    "background-position:left bottom",
    "image-rendering:pixelated",
    "pointer-events:none", // content layer below claims its own pointer-events
  ].join(";");
  panel.appendChild(patchWrap);

  // Inside the patch: family portrait (top), then the mode-specific center
  // slot. Both have pointer-events:auto so buttons / icons remain clickable
  // through the transparent patchWrap.
  const family = document.createElement("div");
  family.dataset["slotBody"] = "family";
  family.style.cssText = [
    "position:absolute",
    "left:0",
    "right:0",
    "top:4px",
    "height:62px", // sits in the arch's upper bell
    "display:flex",
    "flex-direction:column",
    "align-items:center",
    "justify-content:center",
    "gap:2px",
    "pointer-events:auto",
    "overflow:hidden",
  ].join(";");
  patchWrap.appendChild(family);

  const centerSlot = document.createElement("div");
  centerSlot.dataset["slotBody"] = "center";
  centerSlot.style.cssText = [
    "position:absolute",
    "left:6px",
    "right:6px",
    "bottom:4px",
    "top:66px", // below the family portrait area
    "pointer-events:auto",
    "overflow:hidden",
    "color:#ffdf80",
  ].join(";");
  patchWrap.appendChild(centerSlot);

  // Motives strip — right of the patch, 8 stacked bars. Default left:218px
  // (just past LivePatch w=213). Width chosen so 8 × ~10px rows fit at
  // authentic 40px native bar width.
  const motivesWrap = document.createElement("div");
  motivesWrap.id = "cpanel-motives-wrap";
  motivesWrap.style.cssText = [
    "position:absolute",
    "left:218px",
    "bottom:4px",
    "top:4px",
    "width:340px",
    "display:flex",
    "flex-direction:column",
    "gap:1px",
    "padding:2px 4px",
    "color:#ffdf80",
  ].join(";");
  const motivesSlot = document.createElement("div");
  motivesSlot.dataset["slotBody"] = "motives";
  motivesSlot.style.cssText = "flex:1;display:flex;flex-direction:column;gap:1px;overflow:hidden;";
  motivesWrap.appendChild(motivesSlot);
  panel.appendChild(motivesWrap);

  // LiveGadget (6-portrait family grid) is not displayed in single-Sim view —
  // TS1 only surfaces it when there are multiple Sims in the household and
  // you're using the family overview. The active Sim portrait + name lives
  // inside the LivePatch arch above instead. The bitmap is still extracted
  // and available at /assets/converted/ui/cpanel/Backgrounds/LiveGadget.png
  // for a future family-pane feature.

  // Time / funds / speed — clock area. Sits in the right portion, before the
  // mode tabs strip on the far right.
  const timeWrap = document.createElement("div");
  timeWrap.id = "cpanel-time-wrap";
  timeWrap.style.cssText = [
    "position:absolute",
    "right:144px",
    "bottom:4px",
    "top:4px",
    "width:180px",
    "padding:4px 6px",
    "color:#ffdf80",
  ].join(";");
  const timeSlot = document.createElement("div");
  timeSlot.dataset["slotBody"] = "time";
  timeSlot.style.cssText = "display:flex;flex-direction:column;gap:4px;height:100%;";
  timeWrap.appendChild(timeSlot);
  panel.appendChild(timeWrap);

  // Mode tabs strip — far right, narrow vertical column.
  const tabsWrap = document.createElement("div");
  tabsWrap.id = "cpanel-tabs-wrap";
  tabsWrap.style.cssText = [
    "position:absolute",
    "right:0",
    "bottom:0",
    "width:140px",
    `height:${PANEL_BASE_H}px`,
    "display:flex",
    "align-items:center",
    "padding:2px 4px",
  ].join(";");
  const tabsSlot = document.createElement("div");
  tabsSlot.dataset["slotBody"] = "tabs";
  tabsSlot.style.cssText =
    "display:flex;flex-direction:column;gap:1px;width:100%;";
  tabsWrap.appendChild(tabsSlot);
  panel.appendChild(tabsWrap);

  document.body.appendChild(panel);
  return panel;
}

/** Set the active mode patch BMP (LivePatch / BuyPatch / BuildPatch / OptionsPatch)
 * and resize the patch wrapper to the patch's native pixel dimensions. */
export function setCpanelMode(mode: "play" | "buy" | "build" | "options"): void {
  const wrap = document.getElementById("cpanel-patch-wrap");
  if (!wrap) return;
  const p = PATCH_DIMS[mode];
  wrap.style.width = `${p.w}px`;
  wrap.style.height = `${p.h}px`;
  wrap.style.backgroundImage = `url("${UI_BASE}/Backgrounds/${p.file}")`;
  wrap.style.backgroundSize = `${p.w}px ${p.h}px`;
}
