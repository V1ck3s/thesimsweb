/**
 * Primitive names for traces: what cXObject::TryElement's jump table
 * (lbl_10601898) runs for each opcode (the cXObject::Try* function, or the
 * inline case). "person" entries throw error 5 on objects: cXPerson
 * handles them.
 */

const NAMES: readonly string[] = [
  "Idle (sleep)",
  "GenericSimCall",
  "Expression",
  "person: find best interaction",
  "grab (inline)",
  "drop (inline)",
  "person: change suit",
  "Update (refresh)",
  "Random",
  "Burn",
  "Tutorial",
  "get distance to (inline)",
  "DirectionTo",
  "PushAction",
  "FindFunctionalObject",
  "breakpoint (inline)",
  "FindGoodLocation",
  "person: idle for input",
  "KillObject",
  "MakeNewCharacter",
  "CallFunctionalTree",
  "show string (inline)",
  "person: look towards",
  "PlaySound",
  "Relationship (old)",
  "Budget",
  "Relationship2",
  "person: go to relative",
  "CallNamedTree",
  "person: motive change",
  "person: gosub found action",
  "SetToNext",
  "test object type (inline)",
  "Find5WorstMotives",
  "ui effect (inline)",
  "UserEvent",
  "Dialog",
  "person: test interacting with",
  "unused",
  "unused",
  "unused",
  "SetBalloon",
  "CreateObject",
  "DropOnto",
  "person: animate",
  "person: go to routing slot",
  "Snap",
  "person: reach",
  "KillSounds",
  "notify out of idle (inline)",
  "MakeActionString",
  "InventoryAction",
];

export function primitiveName(op: number): string {
  return NAMES[op] ?? `primitive ${op}`;
}
