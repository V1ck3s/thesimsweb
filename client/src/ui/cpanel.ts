// Authentic TS1 Control Panel — bottom-of-screen 100px strip composed of real
// Maxis bitmaps from UIGraphics.far. Replaces the previous fabricated panel.
//
// Layout (left → right):
//
//   ┌─ LivePatch / BuyPatch / BuildPatch (arch overlay, anchored bottom-left,
//   │  sticks up ~50px above the 100px base; hosts the active Sim portrait,
//   │  name and the 8 motive bars — matching TS1 native).
//   │
//   ├─ Center content slot — sub-tabs (House/Job/Friends/Personality) and
//   │  their content (skills, friend list, trait sliders…), or the Buy /
//   │  Build mode-specific UI. (data-slot-body="center")
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
  // content; for Live mode that's portrait + name + 8 motive bars.
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
    "pointer-events:none",
  ].join(";");
  panel.appendChild(patchWrap);

  // Inside the patch: family portrait (top of arch), then motives stacked
  // beneath. Both have pointer-events:auto so widgets through the transparent
  // arch remain clickable.
  const family = document.createElement("div");
  family.dataset["slotBody"] = "family";
  family.style.cssText = [
    "position:absolute",
    "left:42px", // arch's central oval is roughly the middle third
    "right:42px",
    "top:6px",
    "height:54px",
    "display:flex",
    "flex-direction:column",
    "align-items:center",
    "justify-content:center",
    "gap:1px",
    "pointer-events:auto",
    "overflow:hidden",
  ].join(";");
  patchWrap.appendChild(family);

  // Motives strip — 8 stacked bars below the portrait, still inside the arch.
  const motivesWrap = document.createElement("div");
  motivesWrap.style.cssText = [
    "position:absolute",
    "left:8px",
    "right:8px",
    "top:62px",
    "bottom:4px",
    "padding:1px 0",
    "pointer-events:auto",
    "overflow:hidden",
  ].join(";");
  const motivesSlot = document.createElement("div");
  motivesSlot.dataset["slotBody"] = "motives";
  motivesSlot.style.cssText = "display:flex;flex-direction:column;gap:1px;height:100%;";
  motivesWrap.appendChild(motivesSlot);
  patchWrap.appendChild(motivesWrap);

  // Center content slot — sub-tabs (House/Job/Friends/Personality) + their
  // content, or Buy catalog / Build tool palette. Lives RIGHT of the patch
  // arch, in the open part of the panel.
  const centerWrap = document.createElement("div");
  centerWrap.id = "cpanel-center-wrap";
  centerWrap.style.cssText = [
    "position:absolute",
    "left:218px",
    "right:340px",
    "bottom:4px",
    "top:4px",
    "padding:2px 6px",
    "color:#ffdf80",
  ].join(";");
  const centerSlot = document.createElement("div");
  centerSlot.dataset["slotBody"] = "center";
  centerSlot.style.cssText =
    "display:flex;flex-direction:column;gap:2px;height:100%;overflow:hidden;";
  centerWrap.appendChild(centerSlot);
  panel.appendChild(centerWrap);

  // Time / funds / speed — clock area. Sits to the right of the center slot,
  // before the mode tabs strip on the far right.
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
 * and resize the patch wrapper to the patch's native pixel dimensions. The
 * Live-only widgets (portrait + motives) live inside the arch in Live mode
 * but are hidden in Buy/Build so the patch's chrome wraps the mode UI cleanly. */
export function setCpanelMode(mode: "play" | "buy" | "build" | "options"): void {
  const wrap = document.getElementById("cpanel-patch-wrap");
  if (!wrap) return;
  const p = PATCH_DIMS[mode];
  wrap.style.width = `${p.w}px`;
  wrap.style.height = `${p.h}px`;
  wrap.style.backgroundImage = `url("${UI_BASE}/Backgrounds/${p.file}")`;
  wrap.style.backgroundSize = `${p.w}px ${p.h}px`;
  // Show portrait + motives only in Live mode; the other patches host their
  // own mode-specific UI inside (Buy catalog, Build tools, Options panel).
  const isLive = mode === "play";
  for (const child of wrap.children) {
    if (!(child instanceof HTMLElement)) continue;
    if (child.dataset["slotBody"] === "family") {
      child.style.display = isLive ? "" : "none";
    } else if (child.querySelector('[data-slot-body="motives"]')) {
      child.style.display = isLive ? "" : "none";
    }
  }
}
