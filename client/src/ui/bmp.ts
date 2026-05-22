// Helpers for laying out the authentic TS1 Maxis bitmaps in the DOM.
// Every BMP under server/assets/converted/ui/cpanel/ is original Maxis art and
// must be rendered at native pixel scale (no smoothing) to preserve the look.

export const UI_BASE = "/assets/converted/ui/cpanel";

/** Build a `<img>` element pointing at a cpanel BMP. */
export function bmp(path: string, alt: string = ""): HTMLImageElement {
  const i = new Image();
  i.src = `${UI_BASE}/${path}`;
  i.alt = alt;
  i.draggable = false;
  i.style.imageRendering = "pixelated";
  i.style.display = "block";
  i.style.userSelect = "none";
  return i;
}

/** Compose an inline `background-image` style fragment for a panel chrome BMP. */
export function bmpBackground(path: string): string {
  return `background-image:url("${UI_BASE}/${path}");image-rendering:pixelated;`;
}

/** Compose a positioned absolute layer using a BMP as background. */
export function bmpLayer(
  path: string,
  width: number,
  height: number,
  pos: { left?: number; right?: number; top?: number; bottom?: number },
): HTMLDivElement {
  const d = document.createElement("div");
  d.style.position = "absolute";
  d.style.width = `${width}px`;
  d.style.height = `${height}px`;
  if (pos.left !== undefined) d.style.left = `${pos.left}px`;
  if (pos.right !== undefined) d.style.right = `${pos.right}px`;
  if (pos.top !== undefined) d.style.top = `${pos.top}px`;
  if (pos.bottom !== undefined) d.style.bottom = `${pos.bottom}px`;
  d.style.backgroundImage = `url("${UI_BASE}/${path}")`;
  d.style.backgroundRepeat = "no-repeat";
  d.style.backgroundPosition = "0 0";
  // Pixelated rendering is a property of the *element* (image-rendering) — applies
  // to images / canvases. For background-image scaling, we leave it implicit;
  // most cpanel BMPs are used at native size so it doesn't matter, but if we
  // ever scale them we'd add `image-rendering: pixelated` via CSS class.
  d.style.pointerEvents = "auto";
  return d;
}

/** Add a click handler to an element and visually mark it as clickable. */
export function clickable(el: HTMLElement, onClick: (ev: MouseEvent) => void, title?: string): void {
  el.style.cursor = "pointer";
  if (title) el.title = title;
  el.addEventListener("click", onClick);
}

/** Disable an element visually + interactively (matches the TS1 patches'
 * dim grey-out look for unavailable buttons). */
export function setDisabled(el: HTMLElement, disabled: boolean, tooltip?: string): void {
  el.style.opacity = disabled ? "0.4" : "1";
  el.style.cursor = disabled ? "not-allowed" : "pointer";
  el.style.filter = disabled ? "grayscale(0.6)" : "";
  if (tooltip !== undefined) el.title = tooltip;
}
