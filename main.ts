// A push-optimal Sokoban solver for make.fun's sokoban-solver-01.
//
// The levels are built from rooms off a hallway: each room holds its own
// boxes and as many goals, a box pushed out of its room can never come
// back, and the level's push optimum is the sum of the rooms' optima. So
// the solver first cuts the floor at its door squares — the squares whose
// removal splits off a part holding as many boxes as goals — and solves
// each room on its own. Inside a room (and for a level that does not
// split) the search is A* over pushes:
//
//   - a state is the player's square and the boxes'; a step is one push,
//     the walk to the pushing square found by flood fill, costing nothing;
//   - the estimate is the sum over boxes of their push distance to the
//     nearest goal (reverse breadth-first search over pushes on an empty
//     board): admissible, so the first solution found is push-optimal;
//   - squares no goal can be reached from, and frozen 2x2 blocks, prune
//     states the moment they appear;
//   - the player's square is canonicalised to the smallest square of
//     the region it can walk in, so states that differ only in where the
//     player stands inside one region are one state (each state still
//     remembers the square the player actually reached, which is what
//     the written solution replays).
//
// Everything is a function of the level alone — budgets are expansion
// counts, never the clock — so two runs write byte-identical solutions.
// A room the optimal search cannot finish inside its budget is retried
// with a greedy weighted search that still solves it, in more pushes
// rather than none; a level that does not split is searched whole, with
// the same fallbacks.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Expansion budgets (states, not time), per search.
const ROOM_BUDGET = 400_000;
const LEVEL_BUDGET = 30_000;

const DIRS = [
  { dx: 0, dy: -1, walk: 'u', push: 'U' },
  { dx: 0, dy: 1, walk: 'd', push: 'D' },
  { dx: -1, dy: 0, walk: 'l', push: 'L' },
  { dx: 1, dy: 0, walk: 'r', push: 'R' },
] as const;

interface Board {
  w: number;
  h: number;
  wall: Uint8Array; // walls and everything outside the board's area
  noBox: Uint8Array; // floor a box may never be pushed onto (door squares)
  goals: number[];
  goalSet: Set<number>;
  pushDist: Int32Array[]; // per goal: fewest pushes from each square
  dead: Uint8Array; // squares that can reach no goal
}

/** Push-distance and dead-square tables for one board. */
function buildBoard(w: number, h: number, wall: Uint8Array, noBox: Uint8Array, goals: number[]): Board {
  const goalSet = new Set(goals);
  const pushDist: Int32Array[] = goals.map((g) => {
    const dist = new Int32Array(w * h).fill(-1);
    dist[g] = 0;
    const queue = [g];
    for (let head = 0; head < queue.length; head++) {
      const c = queue[head]!;
      const cx = c % w;
      const cy = (c / w) | 0;
      for (const { dx, dy } of DIRS) {
        const bx = cx - dx;
        const by = cy - dy;
        const px = cx - 2 * dx;
        const py = cy - 2 * dy;
        if (bx < 0 || by < 0 || bx >= w || by >= h || px < 0 || py < 0 || px >= w || py >= h) continue;
        const b = by * w + bx;
        const p = py * w + px;
        if (wall[b] || noBox[b] || wall[p] || dist[b] !== -1) continue;
        dist[b] = dist[c]! + 1;
        queue.push(b);
      }
    }
    return dist;
  });
  const dead = new Uint8Array(w * h).fill(1);
  for (let c = 0; c < w * h; c++) {
    if (wall[c]) continue;
    for (const dist of pushDist) if (dist[c] !== -1) { dead[c] = 0; break; }
  }
  return { w, h, wall, noBox, goals, goalSet, pushDist, dead };
}

/** The admissible estimate: each box's push distance to its nearest goal. */
function estimate(B: Board, boxes: number[]): number {
  let sum = 0;
  for (const b of boxes) {
    let best = Infinity;
    for (const dist of B.pushDist) {
      const d = dist[b]!;
      if (d !== -1 && d < best) best = d;
    }
    if (best === Infinity) return Infinity;
    sum += best;
  }
  return sum;
}

/** True when some 2x2 block of walls/boxes holds a box off its goal. */
function frozen(B: Board, boxSet: Uint8Array, boxes: number[]): boolean {
  for (const b of boxes) {
    if (B.goalSet.has(b)) continue;
    const bx = b % B.w;
    const by = (b / B.w) | 0;
    for (const [ox, oy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]] as const) {
      let allSolid = true;
      let anyOffGoal = false;
      for (let dy = 0; dy <= 1 && allSolid; dy++) {
        for (let dx = 0; dx <= 1; dx++) {
          const x = bx + ox + dx;
          const y = by + oy + dy;
          if (x < 0 || y < 0 || x >= B.w || y >= B.h) continue;
          const c = y * B.w + x;
          if (B.wall[c]) continue;
          if (boxSet[c]) {
            if (!B.goalSet.has(c)) anyOffGoal = true;
            continue;
          }
          allSolid = false;
        }
      }
      if (allSolid && anyOffGoal) return true;
    }
  }
  return false;
}

/** A reusable flood fill over floor squares, boxes as obstacles. */
class Flood {
  parent: Int32Array;
  queue: Int32Array;
  min = -1;
  constructor(size: number) {
    this.parent = new Int32Array(size).fill(-2);
    this.queue = new Int32Array(size);
  }
  /** Flood from `from`; returns the smallest square reached. */
  run(B: Board, boxSet: Uint8Array, from: number): number {
    const { parent, queue } = this;
    parent.fill(-2);
    let head = 0;
    let tail = 0;
    queue[tail++] = from;
    parent[from] = -1;
    let min = from;
    while (head < tail) {
      const c = queue[head++]!;
      if (c < min) min = c;
      const cx = c % B.w;
      const cy = (c / B.w) | 0;
      for (const { dx, dy } of DIRS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= B.w || ny >= B.h) continue;
        const n = ny * B.w + nx;
        if (B.wall[n] || boxSet[n] || parent[n] !== -2) continue;
        parent[n] = c;
        queue[tail++] = n;
      }
    }
    this.min = min;
    return min;
  }
  has(cell: number): boolean {
    return this.parent[cell] !== -2;
  }
  /** The walk moves from the flood's root to `to`. */
  path(B: Board, to: number): string {
    let out = '';
    for (let c = to; this.parent[c] !== -1; c = this.parent[c]!) {
      const d = c - this.parent[c]!;
      out = (d === -B.w ? 'u' : d === B.w ? 'd' : d === -1 ? 'l' : 'r') + out;
    }
    return out;
  }
}

interface Solved {
  moves: string;
  boxes: number[]; // sorted, after the moves
  player: number; // the square the player ends on
}

/**
 * A* over pushes on one board. exitTargets, when given, are squares the
 * player must still be able to walk to in the solved position (the way
 * back out of a room). Returns null when the budget runs out first.
 */
function search(
  B: Board,
  startBoxes: number[],
  startPlayer: number,
  budget: number,
  weight: number,
  exitTargets: Set<number> | null,
  floodA: Flood,
  floodB: Flood,
): Solved | null {
  const size = B.w * B.h;
  const boxSet = new Uint8Array(size);
  const nSet = new Uint8Array(size);
  const mark = (boxes: number[]): void => {
    boxSet.fill(0);
    for (const b of boxes) boxSet[b] = 1;
  };
  const markN = (boxes: number[]): void => {
    nSet.fill(0);
    for (const b of boxes) nSet[b] = 1;
  };
  const keyOf = (player: number, boxes: number[]): string => String.fromCharCode(player, ...boxes);

  mark(startBoxes);
  const startCanon = floodA.run(B, boxSet, startPlayer);
  const nodes: { canon: number; player: number; boxes: number[]; g: number; parent: number; segment: string }[] = [
    { canon: startCanon, player: startPlayer, boxes: startBoxes, g: 0, parent: -1, segment: '' },
  ];
  const best = new Map<string, number>([[keyOf(startCanon, startBoxes), 0]]);
  const closed = new Set<string>();
  const heap: { f: number; g: number; idx: number }[] = [];
  const less = (a: { f: number; g: number }, b: { f: number; g: number }): boolean =>
    a.f < b.f || (a.f === b.f && a.g > b.g);
  const heapPush = (e: { f: number; g: number; idx: number }): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): { f: number; g: number; idx: number } => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };
  const h0 = estimate(B, startBoxes);
  if (h0 === Infinity) return null;
  heapPush({ f: h0 * weight, g: 0, idx: 0 });

  let expanded = 0;
  while (heap.length > 0) {
    const { idx } = heapPop();
    const node = nodes[idx]!;
    const key = keyOf(node.canon, node.boxes);
    if (closed.has(key)) continue;
    closed.add(key);
    mark(node.boxes);
    if (node.boxes.every((b) => B.goalSet.has(b))) {
      // Solved: check the way back out, if one is owed.
      if (exitTargets === null || [...exitTargets].every((t) => floodA.run(B, boxSet, node.player) >= 0 && floodA.has(t))) {
        let moves = '';
        for (let t = idx; t > 0; t = nodes[t]!.parent) moves = nodes[t]!.segment + moves;
        return { moves, boxes: node.boxes, player: node.player };
      }
      continue;
    }
    if (++expanded > budget) return null;
    floodA.run(B, boxSet, node.player);
    for (let bi = 0; bi < node.boxes.length; bi++) {
      const b = node.boxes[bi]!;
      const bx = b % B.w;
      const by = (b / B.w) | 0;
      for (const dir of DIRS) {
        const stand = (by - dir.dy) * B.w + (bx - dir.dx);
        const dest = (by + dir.dy) * B.w + (bx + dir.dx);
        if (stand < 0 || dest < 0 || stand >= size || dest >= size) continue;
        if (B.wall[dest] || B.noBox[dest] || boxSet[dest]) continue;
        if (!floodA.has(stand)) continue;
        if (B.dead[dest] && !B.goalSet.has(dest)) continue;
        const nboxes = node.boxes.slice();
        nboxes[bi] = dest;
        nboxes.sort((a, b2) => a - b2);
        markN(nboxes);
        if (frozen(B, nSet, nboxes)) continue;
        const h = estimate(B, nboxes);
        if (h === Infinity) continue;
        const ncanon = floodB.run(B, nSet, b);
        const nkey = keyOf(ncanon, nboxes);
        const g = node.g + 1;
        const seen = best.get(nkey);
        if (seen !== undefined && seen <= g) continue;
        best.set(nkey, g);
        const segment = floodA.path(B, stand) + dir.push;
        nodes.push({ canon: ncanon, player: b, boxes: nboxes, g, parent: idx, segment });
        heapPush({ f: g + h * weight, g, idx: nodes.length - 1 });
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- levels

interface Parsed {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Parsed {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const ch = row[x] ?? '#';
      const i = y * w + x;
      if (ch !== '#') wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/** A room in the cut tree: its own squares, its door, its children. */
interface Region {
  cells: Set<number>; // own squares, its door and its children's doors included
  door: number; // the square the player enters by (the start, for the root)
  boxes: number[]; // boxes starting on its own squares (not in children)
  goals: number[];
  children: Region[];
}

/**
 * Cut a set of floor squares at door squares: repeatedly find a square
 * whose removal splits off a part — not holding the anchor — with as
 * many boxes as goals and at least one box; that part, cut recursively,
 * is a child region. What is left is this region's own squares.
 */
function cutRegions(P: Parsed, cells: Set<number>, anchor: number): Region {
  const rest = new Set(cells);
  const children: Region[] = [];
  const boxCount = (s: Set<number>): number => P.boxes.filter((b) => s.has(b)).length;
  const goalCount = (s: Set<number>): number => P.goals.filter((g) => s.has(g)).length;
  for (;;) {
    let cut: { door: number; part: Set<number> } | null = null;
    const ordered = [...rest].sort((a, b) => a - b);
    for (const c of ordered) {
      if (c === anchor) continue;
      if (P.boxes.includes(c) || P.goals.includes(c)) continue; // a door holds nothing
      // Components of rest without c.
      const seen = new Set<number>([c]);
      let anchorComp: Set<number> | null = null;
      const parts: Set<number>[] = [];
      for (const s of ordered) {
        if (seen.has(s)) continue;
        const comp = new Set<number>();
        const queue = [s];
        seen.add(s);
        for (let head = 0; head < queue.length; head++) {
          const cur = queue[head]!;
          comp.add(cur);
          const cx = cur % P.w;
          const cy = (cur / P.w) | 0;
          for (const { dx, dy } of DIRS) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= P.w || ny >= P.h) continue;
            const n = ny * P.w + nx;
            if (!rest.has(n) || seen.has(n)) continue;
            seen.add(n);
            queue.push(n);
          }
        }
        if (comp.has(anchor)) anchorComp = comp;
        else parts.push(comp);
      }
      if (anchorComp === null) continue;
      for (const part of parts) {
        const bc = boxCount(part);
        if (bc > 0 && bc === goalCount(part)) {
          cut = { door: c, part };
          break;
        }
      }
      if (cut) break;
    }
    if (!cut) break;
    for (const cell of cut.part) rest.delete(cell);
    const childCells = new Set(cut.part);
    childCells.add(cut.door);
    children.push(cutRegions(P, childCells, cut.door));
  }
  const own = new Set(rest);
  for (const child of children) own.add(child.door);
  return {
    cells: own,
    door: anchor,
    boxes: P.boxes.filter((b) => own.has(b) && !children.some((ch) => ch.cells.has(b) && ch.door !== b)),
    goals: P.goals.filter((g) => own.has(g)),
    children,
  };
}

function solveLevel(text: string): string {
  const P = parseLevel(text);
  const size = P.w * P.h;
  if (P.boxes.every((b) => P.goals.includes(b))) return '';
  const floodA = new Flood(size);
  const floodB = new Flood(size);
  const fullBoard = buildBoard(P.w, P.h, P.wall, new Uint8Array(size), P.goals);

  const floor = new Set<number>();
  for (let c = 0; c < size; c++) if (!P.wall[c]) floor.add(c);
  const root = cutRegions(P, floor, P.player);

  // The live position while the plan runs.
  let curBoxes = P.boxes.slice();
  let curPlayer = P.player;
  let moves = '';

  const boxSetNow = (): Uint8Array => {
    const s = new Uint8Array(size);
    for (const b of curBoxes) s[b] = 1;
    return s;
  };
  /** Walk the player to a square on the whole board; false if blocked. */
  const walkTo = (target: number): boolean => {
    if (curPlayer === target) return true;
    floodA.run(fullBoard, boxSetNow(), curPlayer);
    if (!floodA.has(target)) return false;
    moves += floodA.path(fullBoard, target);
    curPlayer = target;
    return true;
  };

  /** Solve one region: its children first, then its own boxes. */
  const solveRegion = (R: Region, isRoot: boolean): boolean => {
    for (const child of R.children) {
      if (!walkTo(child.door)) return false;
      if (!solveRegion(child, false)) return false;
      if (!walkTo(child.door)) return false;
    }
    if (R.boxes.length > 0) {
      const wall = new Uint8Array(size).fill(1);
      for (const c of R.cells) wall[c] = P.wall[c]!;
      const noBox = new Uint8Array(size);
      for (const child of R.children) noBox[child.door] = 1;
      const board = buildBoard(P.w, P.h, wall, noBox, R.goals);
      const startBoxes = curBoxes.filter((b) => R.cells.has(b) && R.boxes.includes(b));
      const targets = isRoot ? null : new Set([R.door]);
      const solved =
        search(board, startBoxes, curPlayer, ROOM_BUDGET, 1, targets, floodA, floodB) ??
        search(board, startBoxes, curPlayer, ROOM_BUDGET, 3, targets, floodA, floodB);
      if (!solved) return false;
      moves += solved.moves;
      const rest = curBoxes.filter((b) => !startBoxes.includes(b));
      curBoxes = [...rest, ...solved.boxes].sort((a, b) => a - b);
      curPlayer = solved.player;
    }
    return true;
  };

  if (root.children.length > 0 && solveRegion(root, true)) return moves;

  // No useful cut, or the plan failed: search the level whole.
  const whole =
    search(fullBoard, P.boxes, P.player, LEVEL_BUDGET, 1, null, floodA, floodB) ??
    search(fullBoard, P.boxes, P.player, LEVEL_BUDGET, 3, null, floodA, floodB);
  return whole?.moves ?? '';
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
