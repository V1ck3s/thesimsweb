/**
 * Camera tracking: the object the lot view keeps in sight.
 *
 * - Animator::SetTrackedObject (Mac 0x10473c80) keeps it in lbl_105BA3A8 and
 *   dispatches 0xf7 when one is set (HouseViewer::DoCommand: DoDynamicCutaway,
 *   whose Live mode part then follows the tracked person instead of the
 *   selected one);
 * - HouseViewer::UpdateWorld calls its Track (cXPerson::Track ->
 *   SAnimator::Track(true), cXObject::Track -> Animator::Track(true)) every
 *   frame while no smooth scroll runs (+0x1a4); the lot view does that part;
 * - cWinPeople::StopTracking / TrackPerson go through the Live panel the game
 *   keeps in lbl_105BA254 (the portrait's kTrackingTarget foreground).
 */

import type { PlacedObject } from "./objects.js";

/** What lbl_105BA254 (the cWinPeople instance) offers the other classes. */
export interface TrackingPanel {
  /** cWinPeople::StopTracking */
  stopTracking(): void;
  /** cWinPeople::TrackPerson */
  trackPerson(person: PlacedObject | null): void;
}

let tracked: PlacedObject | null = null;
let panel: TrackingPanel | null = null;
let dispatch: (() => void) | null = null;

/** lbl_105BA3A8 */
export function getTrackedObject(): PlacedObject | null {
  return tracked;
}

/** Animator::SetTrackedObject: GlobalDispatch(0xf7) when an object is set. */
export function setTrackedObject(o: PlacedObject | null): void {
  tracked = o;
  if (o) dispatch?.();
}

/** The lot view's GlobalDispatch(0xf7) handler (HouseViewer::DoCommand). */
export function setTrackingDispatch(fn: (() => void) | null): void {
  dispatch = fn;
}

/** cWinPeople::Init / ~cWinPeople set lbl_105BA254 (`p` null: only when `owner` is the one set). */
export function setTrackingPanel(p: TrackingPanel | null, owner: TrackingPanel | null = null): void {
  if (p || panel === owner) panel = p;
}

/** cWinPeople::StopTracking(lbl_105BA254); without a Live panel only its SetTrackedObject(0). */
export function stopTracking(): void {
  if (panel) panel.stopTracking();
  else setTrackedObject(null);
}

/** cWinPeople::TrackPerson(lbl_105BA254, person). */
export function trackPerson(person: PlacedObject | null): void {
  panel?.trackPerson(person);
}
