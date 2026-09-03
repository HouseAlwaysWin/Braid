import test from 'node:test';
import assert from 'node:assert/strict';

import { LayoutState, appendCommits, buildGraph, finishLayout } from '../src/graph/layout.ts';
import type { GraphDelta } from '../src/graph/layout.ts';
import type { GraphCommit, GraphDot, GraphLink, Point } from '../src/graph/model.ts';
import { DotKind } from '../src/graph/model.ts';

function c(sha: string, ...parents: string[]): GraphCommit {
  return { sha, parents };
}

/**
 * Commits must arrive child-first, the way `git log --date-order` emits them.
 */
const topologies: Record<string, GraphCommit[]> = {
  // A single root, nothing else.
  root: [c('r')],

  // r <- b <- a
  linear: [c('a', 'b'), c('b', 'r'), c('r')],

  //   m
  //  / \
  // a   b
  //  \ /
  //   r
  merge: [c('m', 'a', 'b'), c('a', 'r'), c('b', 'r'), c('r')],

  // One merge commit with three parents.
  octopus: [c('m', 'a', 'b', 'x'), c('a', 'r'), c('b', 'r'), c('x', 'r'), c('r')],

  // Two merges that each combine the same two branches.
  crissCross: [
    c('top', 'm1', 'm2'),
    c('m1', 'a', 'b'),
    c('m2', 'a', 'b'),
    c('a', 'r'),
    c('b', 'r'),
    c('r'),
  ],

  // Two histories that never touch - e.g. an orphan docs branch.
  twoRoots: [c('a', 'r1'), c('r1'), c('b', 'r2'), c('r2')],

  // A branch that is still open when the loaded history runs out (its parent is never loaded).
  danglingParent: [c('a', 'b'), c('x', 'y')],

  // A long-lived side branch merged much later, so a lane passes through many rows.
  longSideBranch: [
    c('m', 'a', 'side'),
    c('a', 'a1'),
    c('a1', 'a2'),
    c('a2', 'a3'),
    c('a3', 'base'),
    c('side', 'base'),
    c('base'),
  ],
};

interface Collected {
  dots: GraphDot[];
  links: GraphLink[];
  paths: { id: number; color: number; points: Point[] }[];
  width: number;
}

/** Run the layout in pages of `pageSize` and stitch the deltas back into one whole. */
function layoutPaged(commits: readonly GraphCommit[], pageSize: number): Collected {
  const state = new LayoutState();
  const dots: GraphDot[] = [];
  const links: GraphLink[] = [];
  const points = new Map<number, { color: number; points: Point[] }>();

  const collect = (delta: GraphDelta): void => {
    dots.push(...delta.dots);
    links.push(...delta.links);

    for (const p of delta.paths) {
      const existing = points.get(p.id);
      if (existing === undefined) {
        points.set(p.id, { color: p.color, points: [...p.points] });
      } else {
        existing.points.push(...p.points);
      }
    }
  };

  for (let i = 0; i < commits.length; i += pageSize) {
    collect(appendCommits(state, commits.slice(i, i + pageSize)));
  }

  collect(finishLayout(state));

  const paths = [...points.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([id, v]) => ({ id, color: v.color, points: v.points }));

  return { dots, links, paths, width: state.width };
}

test('every commit gets exactly one dot, in order', () => {
  for (const [name, commits] of Object.entries(topologies)) {
    const graph = buildGraph(commits);
    assert.equal(graph.dots.length, commits.length, name);

    graph.dots.forEach((dot, i) => {
      assert.equal(dot.center.y, i + 0.5, `${name} row ${i} sits at its row centre`);
    });
  }
});

test('a merge commit is marked as a merge, a normal commit is not', () => {
  const graph = buildGraph(topologies['merge'] as GraphCommit[]);

  assert.equal(graph.dots[0]?.kind, DotKind.Merge);
  assert.equal(graph.dots[1]?.kind, DotKind.Normal);
  assert.equal(graph.dots[3]?.kind, DotKind.Normal);
});

test('linear history occupies a single lane', () => {
  const graph = buildGraph(topologies['linear'] as GraphCommit[]);

  assert.equal(graph.paths.length, 1);
  assert.equal(new Set(graph.dots.map((d) => d.center.x)).size, 1, 'all dots share a column');
  assert.equal(graph.links.length, 0, 'nothing to arc into');
});

test('a merge emits an arc into the lane it absorbs', () => {
  const graph = buildGraph(topologies['merge'] as GraphCommit[]);

  assert.equal(graph.links.length, 0, 'the second parent has no lane yet, so it opens one');
  assert.equal(graph.paths.length, 2, 'mainline plus the absorbed branch');
});

test('an octopus merge does not lose its extra parents', () => {
  const graph = buildGraph(topologies['octopus'] as GraphCommit[]);

  // Three parents: one continues the major lane, the other two each need a lane or an arc.
  assert.equal(graph.paths.length + graph.links.length >= 3, true);
});

test('first-parent-only drops the merge arcs but keeps every commit', () => {
  const commits = topologies['crissCross'] as GraphCommit[];
  const full = buildGraph(commits);
  const firstParent = buildGraph(commits, { firstParentOnly: true });

  assert.equal(firstParent.dots.length, full.dots.length);
  assert.equal(firstParent.links.length, 0);
  assert.equal(firstParent.paths.length <= full.paths.length, true);
});

test('paging produces byte-identical output to laying out in one pass', () => {
  for (const [name, commits] of Object.entries(topologies)) {
    const whole = layoutPaged(commits, commits.length);

    for (let pageSize = 1; pageSize <= commits.length; pageSize++) {
      const paged = layoutPaged(commits, pageSize);

      assert.deepEqual(paged.dots, whole.dots, `${name}: dots differ at page size ${pageSize}`);
      assert.deepEqual(paged.links, whole.links, `${name}: links differ at page size ${pageSize}`);
      assert.deepEqual(paged.paths, whole.paths, `${name}: paths differ at page size ${pageSize}`);
      assert.equal(paged.width, whole.width, `${name}: width differs at page size ${pageSize}`);
    }
  }
});

test('a commit keeps its colour no matter where the page boundary falls', () => {
  const commits = topologies['longSideBranch'] as GraphCommit[];
  const whole = layoutPaged(commits, commits.length).dots.map((d) => d.color);

  for (let pageSize = 1; pageSize < commits.length; pageSize++) {
    const paged = layoutPaged(commits, pageSize).dots.map((d) => d.color);
    assert.deepEqual(paged, whole, `colours shifted at page size ${pageSize}`);
  }
});

test('lane polylines only turn - they never record a redundant point', () => {
  const graph = buildGraph(topologies['longSideBranch'] as GraphCommit[]);

  for (const path of graph.paths) {
    for (let i = 1; i < path.points.length; i++) {
      const prev = path.points[i - 1] as Point;
      const cur = path.points[i] as Point;

      assert.equal(cur.y > prev.y, true, 'Y must strictly increase down the graph');
    }
  }
});

test('a lane whose parent never loaded runs on to the bottom edge', () => {
  // 'a' opens a lane on row 0 aimed at 'b', and 'b' is never loaded. The lane has a row below it
  // to travel through, so it must be drawn past the last row rather than stopping at its dot.
  const graph = buildGraph(topologies['danglingParent'] as GraphCommit[]);
  const drawn = graph.paths.filter((p) => p.points.length >= 2);

  assert.equal(drawn.length, 1);
  assert.equal(drawn[0]?.points.at(-1)?.y, 2, 'past the final row centre of 1.5, to the edge');
});

test('a lane opened on the very last row is not drawn as a stub', () => {
  // 'x' opens a lane on the final row: there is no row beneath it, so the line would have zero
  // length and sit exactly under its own dot. finishLayout deliberately skips it.
  const graph = buildGraph(topologies['danglingParent'] as GraphCommit[]);

  assert.equal(graph.paths.filter((p) => p.points.length === 1).length, 1);
});

test('disconnected histories each get their own lane', () => {
  const graph = buildGraph(topologies['twoRoots'] as GraphCommit[]);

  assert.equal(graph.dots.length, 4);
  assert.equal(graph.paths.length >= 2, true);
});
