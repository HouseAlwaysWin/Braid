/**
 * Turns a commit list into lanes and connecting lines.
 *
 * Ported from GitFlick's `Services/CommitGraphBuilder.cs`, which in turn adapts SourceGit's
 * `Models/CommitGraph.cs` (MIT - see THIRD-PARTY-NOTICES.md). The shape of it:
 *
 * - A lane is an open line waiting for a specific SHA (`Lane.next`). The lane table is an ordered
 *   list - its index *is* the column.
 * - For each commit, the **leftmost** lane waiting for it wins and continues, re-aimed at the
 *   commit's first parent. Any other lane waiting for the same commit collapses into it.
 * - Freeing a lane and shifting the lanes right of it leftwards are the same operation: the
 *   running X is simply not advanced for a lane that dies.
 * - Extra parents of a merge take one of two paths: if the parent already has a lane, emit a
 *   curved link into it; if not, open a new lane. Handling only one of the two loses half the
 *   merge arcs.
 *
 * Requires commits ordered so a parent never precedes its child (`--date-order` or `--topo-order`);
 * otherwise lanes wait forever for a SHA that already went past.
 *
 * **What this port adds over the C# original:** the layout is *resumable*. The whole algorithm is
 * a single forward pass, so its entire continuation is `{unsolved lanes, colour queue, rowIndex}`.
 * Holding that in a `LayoutState` lets page N+1 be laid out without touching a single row of
 * pages 1..N - which is what makes a 100k-commit repo viable, and incidentally means a commit's
 * colour never changes once assigned.
 */

import type { CommitGraph, GraphCommit, GraphDot, GraphLink, GraphPath, Point } from './model.ts';
import { DotKind } from './model.ts';

const UNIT_WIDTH = 12;
const HALF_WIDTH = 6;
const UNIT_HEIGHT = 1; // one ROW, not one pixel
const HALF_HEIGHT = 0.5;

/** Number of lane colours before they start being reused. */
export const PALETTE_SIZE = 10;

/** Points appended to one lane's polyline during a single page. */
export interface PathDelta {
  readonly id: number;
  readonly color: number;
  readonly points: Point[];
}

/**
 * What one page of layout produced. Everything here is additive: the webview appends and never
 * revisits earlier rows.
 */
export interface GraphDelta {
  /** Index of the first row in this page. */
  readonly firstRow: number;
  readonly dots: GraphDot[];
  readonly links: GraphLink[];
  readonly paths: PathDelta[];
  /** Running pixel width of the whole graph so far. */
  readonly width: number;
}

export interface LayoutOptions {
  readonly firstParentOnly?: boolean;
}

/** An open line, waiting for `next` to show up. */
class Lane {
  next: string;
  readonly id: number;
  readonly color: number;
  readonly points: Point[] = [];
  /** Points added since the last drain - this is what makes incremental delivery possible. */
  pending: Point[] = [];
  lastX: number;
  private lastY: number;
  private endY: number;

  constructor(id: number, next: string, color: number, start: Point, to?: Point) {
    this.id = id;
    this.next = next;
    this.color = color;
    this.push(start);
    this.lastX = start.x;
    this.lastY = start.y;
    this.endY = start.y;

    if (to !== undefined) {
      // For a merge parent with no lane yet: starts at the merge dot, then steps out.
      this.push(to);
      this.lastX = to.x;
      this.lastY = to.y;
      this.endY = to.y;
    }
  }

  /** No commit on this row - carry the lane through, shifting column if needed. */
  pass(x: number, y: number): void {
    if (x > this.lastX) {
      this.add(this.lastX, this.lastY);
      this.add(x, y - HALF_HEIGHT);
    } else if (x < this.lastX) {
      this.add(this.lastX, y - HALF_HEIGHT);
      y += HALF_HEIGHT;
      this.add(x, y);
    }

    this.lastX = x;
    this.lastY = y;
  }

  /** The commit sits on this lane and the lane continues to its first parent. */
  goto(x: number, y: number): void {
    if (x > this.lastX) {
      this.add(this.lastX, this.lastY);
      this.add(x, y - HALF_HEIGHT);
    } else if (x < this.lastX) {
      let minY = y - HALF_HEIGHT;
      if (minY > this.lastY) {
        minY -= HALF_HEIGHT;
      }

      this.add(this.lastX, minY);
      this.add(x, y);
    }

    this.lastX = x;
    this.lastY = y;
  }

  /** The lane terminates here. */
  end(x: number, y: number): void {
    if (x > this.lastX) {
      this.add(this.lastX, this.lastY);
      this.add(x, y - HALF_HEIGHT);
    } else if (x < this.lastX) {
      this.add(this.lastX, y - HALF_HEIGHT);
    }

    this.add(x, y);

    this.lastX = x;
    this.lastY = y;
  }

  // Points are only worth recording where the line turns, and Y must keep increasing.
  private add(x: number, y: number): void {
    if (this.endY < y) {
      this.push({ x, y });
      this.endY = y;
    }
  }

  private push(p: Point): void {
    this.points.push(p);
    this.pending.push(p);
  }
}

/**
 * Hands out lane colours round-robin and returns a dead lane's colour to the back of the queue, so
 * a colour is reused as late as possible.
 */
class ColorPicker {
  private readonly queue: number[] = [];

  next(): number {
    if (this.queue.length === 0) {
      for (let i = 0; i < PALETTE_SIZE; i++) {
        this.queue.push(i);
      }
    }

    return this.queue.shift() as number;
  }

  recycle(color: number): void {
    if (!this.queue.includes(color)) {
      this.queue.push(color);
    }
  }
}

/** Everything needed to resume the layout at the next page. */
export class LayoutState {
  readonly unsolved: Lane[] = [];
  readonly colors = new ColorPicker();
  /** Number of commits placed so far - also the index of the next row. */
  rowIndex = 0;
  maxWidth = 0;
  private nextPathId = 0;

  newLane(next: string, color: number, start: Point, to?: Point): Lane {
    return new Lane(this.nextPathId++, next, color, start, to);
  }

  get width(): number {
    return this.maxWidth + HALF_WIDTH + 2;
  }
}

/** Drain the pending points of every lane that moved this page into a delta. */
function drain(lanes: Iterable<Lane>): PathDelta[] {
  const deltas: PathDelta[] = [];

  for (const lane of lanes) {
    if (lane.pending.length > 0) {
      deltas.push({ id: lane.id, color: lane.color, points: lane.pending });
      lane.pending = [];
    }
  }

  return deltas;
}

/**
 * Lay out one page of commits, continuing from wherever `state` left off. The returned delta
 * covers only these rows; nothing about earlier rows changes.
 */
export function appendCommits(
  state: LayoutState,
  commits: readonly GraphCommit[],
  options: LayoutOptions = {},
): GraphDelta {
  const firstParentOnly = options.firstParentOnly ?? false;
  const firstRow = state.rowIndex;
  const unsolved = state.unsolved;
  const dots: GraphDot[] = [];
  const links: GraphLink[] = [];
  const closed: Lane[] = [];
  const ended: Lane[] = [];

  for (const commit of commits) {
    let major: Lane | null = null;
    const offsetY = state.rowIndex * UNIT_HEIGHT + HALF_HEIGHT;
    state.rowIndex++;

    let offsetX = 4 - HALF_WIDTH;
    const rightmost = unsolved[unsolved.length - 1];
    const maxOffsetOld = rightmost !== undefined ? rightmost.lastX : offsetX + UNIT_WIDTH;

    for (const lane of unsolved) {
      if (lane.next === commit.sha) {
        if (major === null) {
          // Leftmost waiting lane wins: the commit sits here and the lane carries on.
          offsetX += UNIT_WIDTH;
          major = lane;

          const firstParent = commit.parents[0];
          if (firstParent !== undefined) {
            major.next = firstParent;
            major.goto(offsetX, offsetY);
          } else {
            major.end(offsetX, offsetY);
            ended.push(lane);
          }
        } else {
          // Another lane was also waiting for this commit: collapse it into the winner.
          lane.end(major.lastX, offsetY);
          ended.push(lane);
        }
      } else {
        // Not this commit's lane - it just passes through this row and keeps its slot.
        offsetX += UNIT_WIDTH;
        lane.pass(offsetX, offsetY);
      }
    }

    for (const lane of ended) {
      state.colors.recycle(lane.color);
      const at = unsolved.indexOf(lane);
      if (at >= 0) {
        unsolved.splice(at, 1);
      }

      closed.push(lane);
    }

    ended.length = 0;

    const firstParent = commit.parents[0];
    if (major === null && firstParent !== undefined) {
      // Nothing was waiting for it, so it's a branch tip: open a new lane on the right.
      offsetX += UNIT_WIDTH;
      major = state.newLane(firstParent, state.colors.next(), { x: offsetX, y: offsetY });
      unsolved.push(major);
    } else if (major === null) {
      // A root commit nobody references: a lone dot, no lane at all.
      offsetX += UNIT_WIDTH;
    }

    const position: Point = { x: major !== null ? major.lastX : offsetX, y: offsetY };

    dots.push({
      center: position,
      color: major !== null ? major.color : 0,
      kind:
        commit.isHead === true
          ? DotKind.Head
          : commit.parents.length > 1
            ? DotKind.Merge
            : DotKind.Normal,
    });

    // Parent 0 already continued the major lane. The rest are the merge arcs.
    if (!firstParentOnly) {
      for (let i = 1; i < commit.parents.length; i++) {
        const parentSha = commit.parents[i] as string;
        const parentLane = unsolved.find((l) => l.next === parentSha);

        if (parentLane !== undefined) {
          links.push({
            start: position,
            end: { x: parentLane.lastX, y: offsetY + HALF_HEIGHT },
            control: { x: parentLane.lastX, y: position.y },

            // The arc takes the PARENT lane's colour, not the merge commit's.
            color: parentLane.color,
          });
        } else {
          offsetX += UNIT_WIDTH;

          const lane = state.newLane(parentSha, state.colors.next(), position, {
            x: offsetX,
            y: position.y + HALF_HEIGHT,
          });

          unsolved.push(lane);
        }
      }
    }

    state.maxWidth = Math.max(state.maxWidth, Math.max(offsetX, maxOffsetOld));
  }

  return {
    firstRow,
    dots,
    links,
    paths: drain([...unsolved, ...closed]),
    width: state.width,
  };
}

/**
 * History has run out: draw the still-open lanes off the bottom edge. Only call this once the last
 * page has been appended - calling it mid-scroll would draw stubs that the next page contradicts.
 */
export function finishLayout(state: LayoutState): GraphDelta {
  const endY = state.rowIndex * UNIT_HEIGHT - HALF_HEIGHT;

  state.unsolved.forEach((lane, i) => {
    const only = lane.points[0];
    if (lane.points.length === 1 && only !== undefined && Math.abs(only.y - endY) < 0.0001) {
      return;
    }

    lane.end((i + HALF_HEIGHT) * UNIT_WIDTH + 4, endY + HALF_HEIGHT);
  });

  return {
    firstRow: state.rowIndex,
    dots: [],
    links: [],
    paths: drain(state.unsolved),
    width: state.width,
  };
}

/**
 * Lay out a complete history in one go. This is the convenience form used by tests and by anything
 * that already holds every commit; the extension itself pages through `appendCommits`.
 */
export function buildGraph(
  commits: readonly GraphCommit[],
  options: LayoutOptions = {},
): CommitGraph {
  const state = new LayoutState();
  const body = appendCommits(state, commits, options);
  const tail = finishLayout(state);

  const byId = new Map<number, GraphPath>();
  const paths: GraphPath[] = [];

  for (const delta of [body, tail]) {
    for (const p of delta.paths) {
      let path = byId.get(p.id);
      if (path === undefined) {
        path = { points: [], color: p.color };
        byId.set(p.id, path);
        paths.push(path);
      }

      path.points.push(...p.points);
    }
  }

  return { paths, links: body.links, dots: body.dots, width: state.width };
}
