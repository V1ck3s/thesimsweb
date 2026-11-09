/**
 * The path search behind XRoute::FindPath (Routing.cpp): PenaltyRect,
 * RoutingParams, SpacePartition, Path and BuildRoomPartition.
 *
 * The router never searches tiles. It searches free rectangles (1/16 tile
 * units): a SpacePartition grows rectangles from seed points
 * (SpacePartition::ExpandRect) until they touch a blocked penalty rectangle
 * (the room partition's walls and out-of-room tiles, the obstacles'
 * footprints) or another free rectangle, and the A* (Path::OpenANode) walks
 * from rectangle to rectangle through the midpoints of their shared edges
 * (SpacePartition::FindInterfacePoint). A node is a (goal, rectangle) pair:
 * the start node 0 leads to one node per goal (cost: the goal's penalty),
 * the goal node 1 is reached from the node holding the goal's rectangle. The
 * cost of a step is (1 + its length) times the mean weight of the two
 * rectangles. The polyline is then smoothed (Path::DoOneSmooth): each
 * interface point slides along its shared edge while that shortens the path.
 *
 * Floats are single precision as in the original (Math.fround).
 */

import { getWall } from "../world/tilewalls.js";
import { ARRAY_SIZE } from "../world/world.js";
import type { SimModule } from "./simmodule.js";
import { EP } from "./objfntable.js";
import { getOtherSide } from "./portals.js";
import { tileObjects } from "./routing.js";

/** PenaltyRect (0x14 bytes): left, top, right, bottom (1/16 tile), weight. */
export interface PenaltyRect {
  l: number;
  t: number;
  r: number;
  b: number;
  w: number;
}

/** The weight of a rectangle nobody may enter. */
export const BLOCKED = 0x7fffffff;

/** PenaltyRect::PenaltyRect(left, top, right, bottom, weight). */
export function penaltyRect(l: number, t: number, r: number, b: number, w: number): PenaltyRect {
  return { l, t, r, b, w };
}

/** InflateRect. */
export function inflateRect(r: PenaltyRect, dx: number, dy: number): void {
  r.l -= dx;
  r.r += dx;
  r.t -= dy;
  r.b += dy;
}

/** The overlap test of FindIntersectingRect and SpacePartition (open rectangles). */
function overlaps(a: PenaltyRect, b: PenaltyRect): boolean {
  return a.t < b.b && b.t < a.b && a.l < b.r && b.l < a.r;
}

/** IntersectRect into `out` (all zeros when empty). */
function intersectRect(out: PenaltyRect, a: PenaltyRect, b: PenaltyRect): void {
  const l = Math.max(a.l, b.l);
  const r = Math.min(a.r, b.r);
  const t = Math.max(a.t, b.t);
  const bt = Math.min(a.b, b.b);
  if (l < r && t < bt) {
    out.l = l;
    out.r = r;
    out.t = t;
    out.b = bt;
  } else {
    out.l = out.t = out.r = out.b = 0;
  }
}

/** FindIntersectingRect(rect, vector): the first rectangle overlapping `r`, -1 when none. */
export function findIntersectingRect(r: PenaltyRect, v: readonly PenaltyRect[]): number {
  for (let i = 0; i < v.length; i++) if (overlaps(r, v[i]!)) return i;
  return -1;
}

/**
 * SpacePartition::GetIntersectingPartitionRect's search: the first blocked
 * obstacle or partition rectangle overlapping `r`, else the last one
 * overlapping it, else null.
 */
function intersectingPartitionRect(r: PenaltyRect, obstacles: readonly PenaltyRect[], partition: readonly PenaltyRect[] | null): PenaltyRect | null {
  let found: PenaltyRect | null = null;
  for (const o of obstacles) {
    if (overlaps(r, o)) {
      found = o;
      if (o.w === BLOCKED) return o;
    }
  }
  if (!partition) return found;
  for (const o of partition) {
    if (overlaps(r, o)) {
      found = o;
      if (o.w === BLOCKED) return o;
    }
  }
  return found;
}

/** C integer division (toward zero). */
const idiv = (a: number, b: number): number => Math.trunc(a / b);

/** sqrt of a single-precision sum of squares, rounded to float (Distance2, MeasureDistance, EstimateDistanceToGoal). */
function fdist(dx: number, dy: number): number {
  return Math.fround(Math.sqrt(Math.fround(Math.fround(dx * dx) + Math.fround(dy * dy))));
}

/**
 * RoutingParams (FindPath's stack copy): +0 the goals (1x1 rectangles
 * weighted (best score - score) * 16), +4 the obstacles, +8 the room
 * partition (null: none), +0xc / +0x10 the starting point, +0x14 no goal
 * point at the end, +0x1d keep rectangles square-ish (never set by
 * FindPath; that part of ExpandRect is not ported), +0x24 limit rectangle
 * sizes to +0x28, +0x2c the weight of free space, +0x30 smooth the path.
 */
export interface RoutingParams {
  goals: PenaltyRect[];
  obstacles: PenaltyRect[];
  partition: PenaltyRect[] | null;
  x: number;
  y: number;
  noGoalPoint: boolean;
  limitSize: boolean;
  maxSize: number;
  defaultWeight: number;
  smooth: boolean;
}

/** ASTNode (0x2c bytes). */
interface ASTNode {
  /** +0x00 goal index (-1: start / goal node). */
  goal: number;
  /** +0x04 rectangle index (-1: the goal node). */
  rect: number;
  /** +0x08 successor count (-1: not built yet), +0x0c first successor in the successor list. */
  nSucc: number;
  firstSucc: number;
  /** +0x10 the rectangle's (or the goal's) weight. */
  weight: number;
  /** +0x14 / +0x18 where the path enters the rectangle. */
  px: number;
  py: number;
  /** +0x1c parent node. */
  parent: number;
  /** +0x20 f, +0x24 g, +0x28 h. */
  f: number;
  g: number;
  h: number;
}

function astNode(goal: number, rect: number, weight: number): ASTNode {
  return { goal, rect, nSucc: -1, firstSucc: -1, weight, px: 0, py: 0, parent: -1, f: 0, g: 0, h: 0 };
}

/** A (goal, rectangle) pair as a map key (both >= -1). */
function nodeKey(goal: number, rect: number): number {
  return (goal + 1) * 0x10000 + rect + 1;
}

/** SpacePartition (the global lbl_105BA420). */
export class SpacePartition {
  params!: RoutingParams;
  /** +0x0c the free rectangles. */
  rects: PenaltyRect[] = [];
  /** +0x18 per goal: the node holding the goal's rectangle; +0x24 per goal: the goal's first node (in the start rectangle). */
  goalNodes: number[] = [];
  startNodes: number[] = [];
  /** +0x30 the successor lists, +0x3c the nodes. */
  succ: number[] = [];
  nodes: ASTNode[] = [];
  /** The first node of each (goal, rectangle) pair, for BuildSpatialSuccessorList's search of the node list (not in the original). */
  private nodeOf = new Map<number, number>();

  /** SpacePartition::Clear. */
  clear(): void {
    this.rects = [];
    this.nodes = [];
    this.nodeOf = new Map();
    this.goalNodes = [];
    this.startNodes = [];
    this.succ = [];
  }

  /**
   * SpacePartition::Init: the start rectangle (grown from the starting
   * point; kept even when it cannot grow) as node 0, the goal node 1, then
   * per goal not inside a blocked rectangle: the rectangle holding it (an
   * existing one, or grown from it with the weight of the penalty
   * rectangle it lies in) and the goal's start node.
   */
  init(params: RoutingParams): void {
    this.params = params;
    this.clear();
    const start = penaltyRect(params.x, params.y, params.x + 1, params.y + 1, 0);
    this.expandRect(start);
    this.rects.push(start);
    this.pushNode(astNode(-1, this.rects.length - 1, 0));
    this.pushNode(astNode(-1, -1, 0));
    params.goals.forEach((g, gi) => {
      this.goalNodes.push(-1);
      this.startNodes.push(-1);
      const blk = this.getIntersectingPartitionRect(g);
      if (blk && blk.w === BLOCKED) return;
      let ri = findIntersectingRect(g, this.rects);
      if (ri === -1) {
        const r = penaltyRect(g.l, g.t, g.r, g.b, blk ? blk.w : 0);
        if (!this.expandRect(r)) return;
        this.rects.push(r);
        ri = this.rects.length - 1;
      }
      this.pushNode(astNode(gi, ri, this.rects[ri]!.w));
      this.goalNodes[gi] = this.nodes.length - 1;
      this.pushNode(astNode(gi, this.nodes[0]!.rect, g.w));
      this.startNodes[gi] = this.nodes.length - 1;
    });
  }

  /** Appends a node (its index is nodes.length - 1). */
  private pushNode(n: ASTNode): void {
    const k = nodeKey(n.goal, n.rect);
    if (!this.nodeOf.has(k)) this.nodeOf.set(k, this.nodes.length);
    this.nodes.push(n);
  }

  /** SpacePartition::GetNode. */
  getNode(n: number): ASTNode | null {
    return n >= 0 && n < this.nodes.length ? this.nodes[n]! : null;
  }

  /**
   * SpacePartition::GetIntersectingPartitionRect: the first blocked
   * obstacle or partition rectangle overlapping `r`, else the last one
   * overlapping it, else null.
   */
  getIntersectingPartitionRect(r: PenaltyRect): PenaltyRect | null {
    return intersectingPartitionRect(r, this.params.obstacles, this.params.partition);
  }

  /**
   * SpacePartition::ExpandRect: grow `r` side by side (left, top, right,
   * bottom), each side by its step (32, or a quarter of the size limit)
   * while it stays free, inside the same penalty rectangle and clear of the
   * other free rectangles; a refused step is halved; stops when every step
   * is 0 (or after 200 moves). False when `r` cannot be a free rectangle.
   */
  expandRect(r: PenaltyRect): boolean {
    const p = this.params;
    const max = p.maxSize;
    const sizeOk = (): boolean => !p.limitSize || (r.r - r.l <= max && r.b - r.t <= max);
    if (!sizeOk()) return false;
    // With the size limit, `r` never leaves its start grown by the limit on every side: only
    // the rectangles overlapping that box (in their order) can answer the tests below.
    let obstacles = p.obstacles;
    let partition = p.partition;
    let rects: readonly PenaltyRect[] = this.rects;
    if (p.limitSize) {
      const box = penaltyRect(r.r - max - 1, r.b - max - 1, r.l + max + 1, r.t + max + 1, 0);
      const near = (v: readonly PenaltyRect[]): PenaltyRect[] => v.filter((o) => overlaps(box, o));
      obstacles = near(obstacles);
      partition = partition && near(partition);
      rects = near(rects);
    }
    const blk = intersectingPartitionRect(r, obstacles, partition);
    if (blk && blk.w === BLOCKED) return false;
    if (findIntersectingRect(r, rects) !== -1) return false;
    const step = p.limitSize ? Math.max(1, idiv(max, 4)) : 0x20;
    const delta = [-step, -step, step, step];
    const get = (side: number): number => (side === 0 ? r.l : side === 1 ? r.t : side === 2 ? r.r : r.b);
    const set = (side: number, v: number): void => {
      if (side === 0) r.l = v;
      else if (side === 1) r.t = v;
      else if (side === 2) r.r = v;
      else r.b = v;
    };
    let side = 0;
    let zeros = 0;
    for (let iter = 200; iter !== 0; iter--, side = (side + 1) & 3) {
      let accepted = false;
      for (;;) {
        if (zeros > 3) return r.l < r.r && r.t < r.b;
        const d = delta[side]!;
        if (d === 0) break;
        zeros = 0;
        set(side, get(side) + d);
        if (sizeOk()) {
          const q = intersectingPartitionRect(r, obstacles, partition);
          if (q === blk && (!q || q.w !== BLOCKED) && findIntersectingRect(r, rects) === -1) {
            if (!blk || (r.l >= blk.l && r.r <= blk.r && r.t >= blk.t && r.b <= blk.b)) {
              accepted = true;
              break;
            }
          }
        }
        set(side, get(side) - d);
        delta[side] = idiv(d, 2);
      }
      if (!accepted) zeros++;
    }
    return r.l < r.r && r.t < r.b;
  }

  /**
   * SpacePartition::BuildSpatialSuccessorList(node): walk a 1x1 probe
   * around the node's rectangle (top edge left to right, right edge down,
   * bottom edge right to left, left edge up); every free rectangle met
   * (an existing one, or one grown from the probe with the weight of the
   * penalty rectangle there, or of free space) becomes a successor node of
   * the same goal; the probe jumps past each rectangle met.
   */
  buildSpatialSuccessorList(n: number): void {
    const node = this.getNode(n);
    if (!node) return;
    const R = this.rects[node.rect]!;
    const L = R.l;
    const T = R.t;
    const Rr = R.r;
    const B = R.b;
    const P = penaltyRect(L, T - 1, L + 1, T, 0);
    const offset = (dx: number, dy: number): void => {
      P.l += dx;
      P.r += dx;
      P.t += dy;
      P.b += dy;
    };
    let side = 0;
    while (side < 4) {
      let nb: PenaltyRect;
      let next = -1;
      const blk = this.getIntersectingPartitionRect(P);
      if (!blk || blk.w !== BLOCKED) {
        let ri = findIntersectingRect(P, this.rects);
        if (ri === -1) {
          const q = penaltyRect(P.l, P.t, P.r, P.b, 0);
          if (this.expandRect(q)) {
            q.w = blk ? blk.w : this.params.defaultWeight;
            this.rects.push(q);
            ri = this.rects.length - 1;
          }
        }
        if (ri !== -1) {
          next = this.nodeOf.get(nodeKey(node.goal, ri)) ?? -1;
          if (next === -1) {
            this.pushNode(astNode(node.goal, ri, this.rects[ri]!.w));
            next = this.nodes.length - 1;
          }
          nb = this.rects[this.nodes[next]!.rect]!;
        } else {
          // Unreachable in the original (the probe is free, so it grows).
          nb = P;
        }
      } else {
        nb = blk;
      }
      if (next !== -1) {
        this.succ.push(next);
        node.nSucc++;
      }
      switch (side) {
        case 0:
          if (Rr < P.r || Rr <= nb.r) {
            offset(Rr - P.l, 1);
            side++;
          } else offset(nb.r - P.l, 0);
          break;
        case 1:
          if (B < P.b || B <= nb.b) {
            offset(-1, B - P.t);
            side++;
          } else offset(0, nb.b - P.t);
          break;
        case 2:
          if (P.l < L || nb.l <= L) {
            offset(L - P.l - 1, -1);
            side++;
          } else offset(nb.l - P.l - 1, 0);
          break;
        default:
          if (P.t < T || nb.t <= T) {
            offset(1, T - P.t - 1);
            side++;
          } else offset(0, nb.t - P.t - 1);
          break;
      }
    }
  }

  /**
   * SpacePartition::CountSuccessors(node), built on first use: the start
   * node leads to every goal's start node; another node to its spatial
   * neighbours, the goal node when it holds its goal's rectangle, and its
   * goal's rectangle node when that is the start rectangle.
   */
  countSuccessors(n: number): number {
    let node = this.getNode(n);
    if (!node) return 0;
    if (node.nSucc === -1) {
      node.nSucc = 0;
      node.firstSucc = this.succ.length;
      if (n === 0) {
        for (const s of this.startNodes) {
          if (s !== -1) {
            this.succ.push(s);
            node.nSucc++;
          }
        }
      } else if (n !== 1) {
        this.buildSpatialSuccessorList(n);
        node = this.getNode(n)!;
        if (this.goalNodes.includes(n)) {
          node.nSucc++;
          this.succ.push(1);
        }
        if (this.startNodes.includes(n)) {
          for (const a of this.goalNodes) {
            const an = a !== -1 ? this.getNode(a) : null;
            if (an && an.rect === node.rect && an.goal === node.goal) {
              node.nSucc++;
              this.succ.push(a);
            }
          }
        }
      }
    }
    return node.nSucc;
  }

  /** SpacePartition::GetNthSuccessor. */
  getNthSuccessor(n: number, i: number): number {
    const count = this.countSuccessors(n);
    if (i < 0 || i >= count) return -1;
    const node = this.getNode(n);
    return node ? this.succ[node.firstSucc + i]! : -1;
  }

  /**
   * SpacePartition::MeasureDistance(from, to, &point): from the start
   * node, the goal's weight (the point stays the start); to the goal node,
   * 0 (the point is left as it was); else (1 + the distance to the point
   * where `to` is entered) * the mean of both weights.
   */
  measureDistance(from: number, to: number, pt: { x: number; y: number }): number {
    const a = this.getNode(from);
    const b = this.getNode(to);
    if (!a || !b) return 0;
    if (from === 0) {
      const g = this.params.goals[b.goal];
      if (b.goal < 0 || !g) return 0;
      pt.x = a.px;
      pt.y = a.py;
      return Math.fround(g.w);
    }
    if (to === 1) return 0;
    if (a.rect === b.rect) {
      pt.x = a.px;
      pt.y = a.py;
    } else {
      const p = this.findInterfacePoint(a, b);
      pt.x = p.x;
      pt.y = p.y;
    }
    const d = fdist(pt.x - a.px, pt.y - a.py);
    return Math.fround(Math.fround(1 + d) * Math.fround((a.weight + b.weight + 2) >> 1));
  }

  /** SpacePartition::EstimateDistanceToGoal: from the node's point to its goal's center. */
  estimateDistanceToGoal(n: number): number {
    if (n === 0 || n === 1) return 0;
    const node = this.getNode(n);
    if (!node) return 0;
    const g = this.params.goals[node.goal];
    if (node.goal < 0 || !g) return 0;
    if (node.rect < 0 || node.rect >= this.rects.length) return 0;
    return fdist(idiv(g.l + g.r, 2) - node.px, idiv(g.t + g.b, 2) - node.py);
  }

  /** SpacePartition::FindInterfaceRect: the shared edge of two nodes' rectangles (both inflated by 1, intersected). */
  findInterfaceRect(n1: number, n2: number): PenaltyRect {
    const out = penaltyRect(0, 0, 0, 0, 0);
    const a = this.getNode(n1);
    const b = this.getNode(n2);
    if (!a || !b) return out;
    const ra = this.rects[a.rect]!;
    const rb = this.rects[b.rect]!;
    const x = penaltyRect(ra.l, ra.t, ra.r, ra.b, 0);
    const y = penaltyRect(rb.l, rb.t, rb.r, rb.b, 0);
    inflateRect(y, 1, 1);
    inflateRect(x, 1, 1);
    intersectRect(out, y, x);
    return out;
  }

  /** SpacePartition::FindInterfacePoint: the middle of the shared edge. */
  findInterfacePoint(a: ASTNode, b: ASTNode): { x: number; y: number } {
    const ra = this.rects[a.rect]!;
    const rb = this.rects[b.rect]!;
    const x = penaltyRect(ra.l, ra.t, ra.r, ra.b, 0);
    const y = penaltyRect(rb.l, rb.t, rb.r, rb.b, 0);
    inflateRect(y, 1, 1);
    inflateRect(x, 1, 1);
    intersectRect(x, y, x);
    return { x: idiv(x.r + x.l, 2), y: idiv(x.b + x.t, 2) };
  }
}

/** Distance2(POINT, POINT). */
function distance2(ax: number, ay: number, bx: number, by: number): number {
  return fdist(ax - bx, ay - by);
}

/**
 * Path (A* over a SpacePartition, then smoothing). State (+0x28): 0 done,
 * 1 searching, 2 smoothing; +0x2c the steps taken (FindPath's budget).
 */
export class Path {
  readonly sp = new SpacePartition();
  params!: RoutingParams;
  /** +0x04 the node chain goal → start, +0x10 the nodes where the rectangle changes, +0x1c their points. */
  chain: number[] = [];
  turns: number[] = [];
  points: Array<{ x: number; y: number }> = [];
  state = 0;
  steps = 0;
  /** +0x30 open list, +0x3c closed list. */
  open: number[] = [];
  /** Membership of `open` (the array keeps the order FindSmallestOpenNode depends on) and the closed list (only tested for membership). */
  private openSet = new Set<number>();
  private closed = new Set<number>();
  /** +0x48 start node, +0x4c goal node, +0x50 current node, +0x54 the goal reached, +0x58 smoothing pass. */
  start = 0;
  goal = 1;
  cur = 0;
  goalIndex = -1;
  smoothPass = 0;

  /** Path::InitPath. */
  initPath(params: RoutingParams): void {
    this.params = params;
    this.sp.init(params);
    this.chain = [];
    this.turns = [];
    this.points = [];
    this.state = 0;
    this.smoothPass = 0;
    this.steps = 0;
    this.goalIndex = -1;
    if (this.initAST()) this.state = 1;
  }

  /** Path::InitAST: the start node opened at the starting point. */
  initAST(): boolean {
    this.open = [];
    this.openSet = new Set();
    this.closed = new Set();
    this.start = 0;
    this.goal = 1;
    const n = this.sp.getNode(0)!;
    n.px = this.params.x;
    n.py = this.params.y;
    const h = this.sp.estimateDistanceToGoal(this.start);
    n.h = h;
    n.g = 0;
    n.f = h;
    n.parent = -1;
    this.cur = this.start;
    this.open.push(this.start);
    this.openSet.add(this.start);
    return true;
  }

  /** Path::FindSmallestOpenNode (first of the smallest f). */
  findSmallestOpenNode(): number {
    let best = 0;
    let f = this.sp.getNode(this.open[0]!)!.f;
    for (let i = 1; i < this.open.length; i++) {
      const n = this.sp.getNode(this.open[i]!)!;
      if (n.f < f) {
        f = n.f;
        best = i;
      }
    }
    return this.open[best]!;
  }

  /**
   * Path::OpenANode: one A* step. At the goal node, collects the chain,
   * the nodes where the rectangle changes and their points, plus the
   * goal's center; returns true (also when the open list runs dry).
   */
  openANode(): boolean {
    const sp = this.sp;
    if (this.cur === this.goal) {
      while (this.cur !== -1) {
        this.chain.push(this.cur);
        const n = sp.getNode(this.cur)!;
        this.cur = n.parent;
        if (this.goalIndex === -1 && n.goal !== -1) this.goalIndex = n.goal;
      }
      let last = -1;
      for (let i = this.chain.length - 1; i >= 0; i--) {
        const id = this.chain[i]!;
        const n = sp.getNode(id)!;
        if (n.rect !== -1 && n.rect !== last) {
          this.turns.push(id);
          last = n.rect;
        }
      }
      for (const id of this.turns) {
        const n = sp.getNode(id)!;
        this.points.push({ x: n.px, y: n.py });
      }
      if (this.turns.length !== 0 && !this.params.noGoalPoint) {
        const n = sp.getNode(this.chain[1]!)!;
        const g = this.params.goals[n.goal]!;
        this.points.push({ x: idiv(g.l + g.r, 2), y: idiv(g.t + g.b, 2) });
      }
      return true;
    }
    const count = sp.countSuccessors(this.cur);
    const pt = { x: 0, y: 0 };
    for (let i = 0; i < count; i++) {
      const s = sp.getNthSuccessor(this.cur, i);
      const sn = sp.getNode(s)!;
      const d = sp.measureDistance(this.cur, s, pt);
      const g = Math.fround(sp.getNode(this.cur)!.g + d);
      if (this.closed.has(s)) {
        if (!(g < sn.g)) continue;
        this.closed.delete(s);
      }
      if (this.openSet.has(s)) {
        if (sn.g <= g) continue;
      } else {
        this.open.push(s);
        this.openSet.add(s);
      }
      sn.g = g;
      sn.px = pt.x;
      sn.py = pt.y;
      const h = sp.estimateDistanceToGoal(s);
      sn.h = h;
      sn.f = Math.fround(sn.g + h);
      sn.parent = this.cur;
    }
    if (this.openSet.delete(this.cur)) this.open.splice(this.open.indexOf(this.cur), 1);
    this.closed.add(this.cur);
    if (this.open.length === 0) return true;
    this.cur = this.findSmallestOpenNode();
    return false;
  }

  /**
   * Path::DoOneSmooth: slide each interface point along its shared edge
   * by the pass's step (100 / (pass + 1)², at least 1) in x then y while
   * that shortens the path through it (EvalPoint); true when a 1-step
   * pass changes nothing.
   */
  doOneSmooth(): boolean {
    const n = this.turns.length;
    if (n < 2) return true;
    const pts = this.points;
    let moved = 0;
    let step: number;
    do {
      step = Math.max(1, idiv(100, (this.smoothPass + 1) * (this.smoothPass + 1)));
      for (let i = 1; i < n; i++) {
        const ir = this.sp.findInterfaceRect(this.turns[i - 1]!, this.turns[i]!);
        const prev = pts[i - 1]!;
        const cur = pts[i]!;
        const next = i + 1 < pts.length ? pts[i + 1]! : cur;
        const best = { x: cur.x, y: cur.y };
        const dist = { v: Math.fround(distance2(prev.x, prev.y, cur.x, cur.y) + distance2(cur.x, cur.y, next.x, next.y)) };
        const evalPoint = (x: number, y: number): void => {
          const d = Math.fround(distance2(x, y, next.x, next.y) + distance2(prev.x, prev.y, x, y));
          if (d < dist.v) {
            dist.v = d;
            best.x = x;
            best.y = y;
            moved++;
          }
        };
        if (ir.r - ir.l > 2) {
          if (cur.x < ir.r - step) evalPoint(cur.x + step, cur.y);
          if (ir.l + step < cur.x) evalPoint(cur.x - step, cur.y);
        }
        if (ir.b - ir.t > 2) {
          if (cur.y < ir.b - step) evalPoint(cur.x, cur.y + step);
          if (ir.t + step < cur.y) evalPoint(cur.x, cur.y - step);
        }
        pts[i] = best;
      }
    } while (moved === 0 && (this.smoothPass++, step > 1));
    return moved === 0;
  }

  /** FindPath's loop: search, then smooth when asked, within `budget` steps. */
  run(budget: number): void {
    while (this.state !== 0 && this.steps <= budget) {
      if (this.state === 1) {
        this.steps++;
        if (this.openANode()) this.state = this.params.smooth ? 2 : 0;
      } else if (this.state === 2) {
        this.steps++;
        if (this.doOneSmooth()) this.state = 0;
      }
    }
  }
}

/** Wall styles people walk through (doorways, arches: SectWall's list). */
export function isOpenWallStyle(s: number): boolean {
  return s === 3 || s === 5 || s === 6 || s === 0xf || s === 0x17;
}

/** Room::GetLevel: from the room id. */
export function roomLevel(room: number): number {
  return ((room >> 10) & 3) + 1;
}

/**
 * BuildRoomPartition(room, out, withPaths): the blocked rectangles of a
 * room (1/16 tile): a frame one tile outside the room's bounds (grown by
 * one tile within the lot), the walls between two tiles of the room
 * (doorway / arch styles excepted), the diagonal walls (two points on the
 * diagonal), and runs of tiles that are not the room's merged into
 * rectangles; all inflated by 7. A tile is the room's when the room array
 * says so (or the tile is split by a diagonal), or a portal on it leads
 * into the room, and it has no water unless an object there allows walking
 * on water (flag 0x1000). With `withPaths` on the ground floor outside of
 * a residential lot, floored tiles (paths) are added as rectangles of
 * weight 0 (10 off the editable lot), not inflated.
 */
export function buildRoomPartition(module: SimModule, room: number, withPaths = true): PenaltyRect[] {
  const fixed = module.sim.world!;
  const level = roomLevel(room);
  const out: PenaltyRect[] = [];
  if (level < 1 || level > 2) return out;
  const rooms = fixed.rooms[level - 1]!;
  const floors = fixed.floors[level - 1]!;
  const size = fixed.size;
  let paths = false;
  if (withPaths && level === 1 && roomIsOutside(module, room) && module.getZoningType(module.sim.globals[10]!) === 1) paths = true;
  let minX = 0;
  let maxX = 0;
  let minY = 0;
  let maxY = 0;
  let found = false;
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      if (rooms.u16(x, y) !== room) continue;
      if (!found) {
        minX = maxX = x;
        minY = maxY = y;
        found = true;
      } else {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (!found) return out;
  if (minX > 1) minX--;
  if (maxX < size - 2) maxX++;
  if (minY > 1) minY--;
  if (maxY < size - 2) maxY++;
  const tileRect = (l: number, t: number, r: number, b: number, w: number): PenaltyRect => penaltyRect(l << 4, t << 4, r << 4, b << 4, w);
  // walkable() is asked again and again for the same tiles by the rectangle merges below:
  // its answers are kept for this call (0 unknown, 1 no, 2 yes); the world does not change meanwhile.
  const known = new Uint8Array(ARRAY_SIZE * ARRAY_SIZE);
  const walkable = (x: number, y: number): boolean => {
    const k = y * ARRAY_SIZE + x;
    const c = x >= 0 && y >= 0 && x < ARRAY_SIZE && y < ARRAY_SIZE ? known[k]! : 3;
    if (c === 1 || c === 2) return c === 2;
    const mine = walkableTile(x, y);
    if (c === 0) known[k] = mine ? 2 : 1;
    return mine;
  };
  const walkableTile = (x: number, y: number): boolean => {
    const id = rooms.u16(x, y);
    let mine = id === room || id === 0xfffb;
    if (!mine) {
      for (const o of tileObjects(module, x, y, level)) {
        if (o.obj.selector.objd.objectType !== 8 || o.fnTable.getTreeID(EP.portal) === 0) continue;
        const other = getOtherSide(module, o);
        if (other && (other.obj.objectData[29]! & 0xffff) === room) mine = true;
      }
    }
    if (mine && fixed.hasWater(x, y, level)) {
      mine = false;
      for (const o of tileObjects(module, x, y, level)) {
        if (o.obj.objectData[8]! & 0x1000) {
          mine = true;
          break;
        }
      }
    }
    return mine;
  };
  // The frame: left / right, top / bottom.
  const left = tileRect(minX - 1, minY - 1, minX, maxY + 2, BLOCKED);
  out.push({ ...left });
  left.l += (maxX - minX + 2) * 16;
  left.r += (maxX - minX + 2) * 16;
  out.push(left);
  const top = tileRect(minX - 1, minY - 1, maxX + 2, minY, BLOCKED);
  out.push({ ...top });
  top.t += (maxY - minY + 2) * 16;
  top.b += (maxY - minY + 2) * 16;
  out.push(top);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (walkable(x, y)) {
        const w = getWall(fixed, x, y, level);
        if ((w.segs & 8) === 8 && !isOpenWallStyle(w.styles[3]!) && walkable(x, y + 1)) out.push(tileRect(x, y + 1, x + 1, y + 1, BLOCKED));
        if ((w.segs & 4) === 4 && !isOpenWallStyle(w.styles[2]!) && walkable(x + 1, y)) out.push(tileRect(x + 1, y, x + 1, y + 1, BLOCKED));
        if (w.segs & 0x30) {
          // Two points on the diagonal (the halves' inner corners shrunk by 4).
          const L = x << 4;
          const T = y << 4;
          const a = penaltyRect(L, T, L + 8, T + 8, BLOCKED);
          const b = penaltyRect(L + 8, T + 8, L + 16, T + 16, BLOCKED);
          if ((w.segs & 0x10) === 0x10) {
            a.t = T + 8;
            a.b = T + 16;
            b.t = T;
            b.b = T + 8;
          }
          inflateRect(a, -4, -4);
          inflateRect(b, -4, -4);
          out.push(a, b);
        }
      } else {
        const r = tileRect(x, y, x + 1, y + 1, BLOCKED);
        const i = findIntersectingRect(r, out);
        if (i === -1) {
          let x2 = x;
          do x2++;
          while (x2 <= maxX && !walkable(x2, y));
          let y2 = y;
          let all = true;
          do {
            y2++;
            for (let xx = x; xx < x2; xx++) {
              if (walkable(xx, y2)) {
                all = false;
                break;
              }
            }
          } while (all && y2 <= maxY);
          r.r = x2 << 4;
          r.b = y2 << 4;
          out.push(r);
        } else {
          const rr = idiv(out[i]!.r, 16);
          if (rr !== x) x = rr - 1;
        }
      }
    }
  }
  const walls = out.length;
  if (paths) {
    const offLot = fixed.flags[0]!;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (floors.u16(x, y) === 0) continue;
        // lbl_105BA244 (the off-lot editing cheat) is 0.
        const w = offLot.u8(x, y) & 0x20 ? 10 : 0;
        const r = tileRect(x, y, x + 1, y + 1, w);
        const i = findIntersectingRect(r, out);
        if (i === -1) {
          let x2 = x;
          do x2++;
          while (x2 <= maxX && floors.u16(x2, y) !== 0 && walkable(x2, y));
          let y2 = y;
          let all = true;
          do {
            y2++;
            for (let xx = x; xx < x2; xx++) {
              if (floors.u16(xx, y2) === 0 || !walkable(xx, y2)) {
                all = false;
                break;
              }
            }
          } while (all && y2 <= maxY);
          r.r = x2 << 4;
          r.b = y2 << 4;
          out.push(r);
        } else {
          const rr = idiv(out[i]!.r, 16);
          if (rr !== x) x = rr - 1;
        }
      }
    }
  }
  for (let i = 0; i < walls; i++) inflateRect(out[i]!, 7, 7);
  return out;
}

/** Room::IsOutside: the outside flag (0x04) of the room's first tile. */
export function roomIsOutside(module: SimModule, room: number): boolean {
  return roomOutside(module, room) === true;
}

/**
 * RoomManager::GetRoom then Room::IsOutside: null when no tile holds `room`
 * (no Room), else the outside flag (0x04) of its first tile.
 */
export function roomOutside(module: SimModule, room: number): boolean | null {
  const fixed = module.sim.world!;
  const level = roomLevel(room);
  const rooms = fixed.rooms[level - 1];
  if (!rooms) return null;
  for (let x = 0; x < fixed.size; x++) for (let y = 0; y < fixed.size; y++) if (rooms.u16(x, y) === room) return (fixed.flags[level - 1]!.u8(x, y) & 4) !== 0;
  return null;
}

/**
 * Room::GetArea (Room +0x38 / 2, summed by CollectTileStats: 2 per tile,
 * 1 per half of a tile split by a diagonal wall inside) and the objects
 * counted by CollectObjectStats (not hidden, object data 34).
 */
export function roomStats(module: SimModule, room: number): { area: number; objects: number; tiles: number } {
  // The Room of the last ComputeRooms (its CollectTileStats / CollectObjectStats); the
  // count below is the fallback without the lot view's rooms.
  const info = module.roomHooks?.room(room);
  if (info) return { area: info.area, objects: info.objects, tiles: 1 };
  const fixed = module.sim.world!;
  const level = roomLevel(room);
  const rooms = fixed.rooms[level - 1]!;
  const outside = roomIsOutside(module, room);
  let half = 0;
  let tiles = 0;
  for (let x = 0; x < fixed.size; x++) {
    for (let y = 0; y < fixed.size; y++) {
      const id = rooms.u16(x, y);
      if (id === room) {
        tiles++;
        half += outside || (getWall(fixed, x, y, level).segs & 0x30) === 0 ? 2 : 1;
      } else if (id === 0xfffb && x > 0 && y > 0 && x < fixed.size - 1 && y < fixed.size - 1) {
        // A tile two rooms share: each half counts 1 for its room.
        if (rooms.u16(x - 1, y) === room) half++;
        if (rooms.u16(x + 1, y) === room) half++;
      }
    }
  }
  let objects = 0;
  for (const o of module.list) if ((o.obj.objectData[29]! & 0xffff) === room && o.obj.objectData[34] === 0) objects++;
  return { area: half >> 1, objects, tiles };
}
