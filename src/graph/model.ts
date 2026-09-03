/**
 * The drawable form of a commit history.
 *
 * Coordinate convention: **X is in pixels, Y is in row units** — row `i` has its centre at
 * Y = `i + 0.5`. The renderer multiplies Y by the row height, so changing the row height needs
 * no regeneration of the layout.
 *
 * Derived from SourceGit's `Models/CommitGraph.cs` (MIT) — see THIRD-PARTY-NOTICES.md.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** `enum` is deliberately avoided: it is not erasable, and Node runs our tests by stripping types. */
export const DotKind = {
  Normal: 0,
  Head: 1,
  Merge: 2,
} as const;

export type DotKind = (typeof DotKind)[keyof typeof DotKind];

/**
 * A lane drawn as a polyline. Points are emitted only where the lane changes direction, so a lane
 * running straight for a thousand rows costs two points.
 */
export interface GraphPath {
  readonly points: Point[];
  readonly color: number;
}

/** A merge arc from a merge commit's dot into a lane that already exists. */
export interface GraphLink {
  readonly start: Point;
  readonly control: Point;
  readonly end: Point;
  readonly color: number;
}

export interface GraphDot {
  readonly center: Point;
  readonly color: number;
  readonly kind: DotKind;
}

export interface CommitGraph {
  readonly paths: GraphPath[];
  readonly links: GraphLink[];
  readonly dots: GraphDot[];
  /** Pixel width needed to draw every lane, so the commit list can indent past it. */
  width: number;
}

/** The minimum a commit has to expose for the layout to place it. */
export interface GraphCommit {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly isHead?: boolean;
}
