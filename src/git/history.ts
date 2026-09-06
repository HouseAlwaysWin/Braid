/**
 * Streams a repository's history into laid-out pages.
 *
 * The original plan was to page with `--skip=N --max-count=M` over a pinned set of tip SHAs. That
 * turned out to be solving a problem streaming does not have:
 *
 * - `--skip=N` makes git re-walk N commits for every page, which is quadratic across a full scroll.
 * - Pinning tips was only needed because separate `git log` calls can straddle a ref update. One
 *   long-lived process walks a single consistent snapshot, so the inconsistency cannot arise.
 *
 * So: one process, records parsed as they land, and a page emitted every `batchSize` commits. The
 * first page reaches the screen while git is still walking, which is the whole point.
 */

import type { Git } from './exec.ts';
import type { RepoInfo } from './discovery.ts';
import type { Commit } from './logParser.ts';
import { Interner, LOG_ARGS, parseLog } from './logParser.ts';
import type { CommitOrder } from '../protocol.ts';
import type { GraphDelta } from '../graph/layout.ts';
import { LayoutState, appendCommits, finishLayout } from '../graph/layout.ts';

const RECORD = '\x1e';

export interface Page {
  readonly commits: Commit[];
  readonly delta: GraphDelta;
  /** True on the final page, once every lane has been closed off. */
  readonly done: boolean;
}

export interface HistoryOptions {
  /** Commits per page delivered to the view. */
  readonly batchSize?: number;
  /** Hard ceiling, so a pathological repository cannot exhaust the extension host. */
  readonly maxCommits?: number;
  /** Extra `git log` arguments - this is where search and filter push work down into git. */
  readonly filters?: readonly string[];
  /**
   * Refs to walk. Omit, or pass null, to walk everything via `--all` - cheaper than spelling out
   * hundreds of refs on a command line when none of them are filtered out anyway.
   */
  readonly refs?: readonly string[] | null;
  /**
   * Walk only the first parent of every merge.
   *
   * Two halves of one thing: git is told to leave the merged-in commits out of the walk, and the
   * layout is told not to draw the arcs to them - which would otherwise point at rows that are no
   * longer there. Turning on only the drawing half would make a merge dot with nothing joining it,
   * a graph that lies by leaving something out.
   */
  readonly firstParentOnly?: boolean;
  /** How to order the walk. Omitted is `date`, which is what it always did. */
  readonly order?: CommitOrder;
  /**
   * Stash commits to fold into the walk, keyed by SHA. Only the newest stash is a ref, so the rest
   * have to be named explicitly or they are invisible.
   */
  readonly stashes?: ReadonlyMap<string, string>;
}

/*
 * The three orders, and why git's own default is not among them.
 *
 * A parent must never precede its child or the lane layout waits forever for a SHA that already
 * went past. Plain chronological order can violate that under clock skew - a commit dated before
 * its parent is one `git commit --date` away - and every one of these three cannot: each is
 * "sort by X, but never show a parent before all of its children". That guarantee is the floor,
 * not a preference, which is why this is a choice between three and not four.
 *
 * They cost the same. Measured on the 100k-commit fixture, first row: date 521ms, author-date
 * 551ms, topo 517ms. The ordering is a question of which shape the history reads best in, not one
 * of what it is worth waiting for.
 */
const ORDER_ARGS: Record<CommitOrder, readonly string[]> = {
  date: ['--date-order'],
  'author-date': ['--author-date-order'],
  topo: ['--topo-order'],
};

export class HistoryLoader {
  private readonly git: Git;
  private readonly repo: RepoInfo;
  private readonly state = new LayoutState();

  constructor(git: Git, repo: RepoInfo) {
    this.git = git;
    this.repo = repo;
  }

  /** Rows laid out so far. */
  get rowCount(): number {
    return this.state.rowIndex;
  }

  /**
   * Walk the history, calling `onPage` as pages become available. Resolves once git has finished
   * and the trailing lanes have been closed.
   */
  async load(
    onPage: (page: Page) => void,
    options: HistoryOptions = {},
    signal?: AbortSignal,
  ): Promise<void> {
    const batchSize = options.batchSize ?? 500;
    const maxCommits = options.maxCommits ?? 250_000;
    const layoutOptions = { firstParentOnly: options.firstParentOnly ?? false };

    const refs = options.refs ?? null;
    const stashes = options.stashes ?? new Map<string, string>();

    /*
     * An empty ref list is not the same as no ref list: it means the user unticked everything.
     *
     * This has to short-circuit rather than pass no revisions to git, because `git log` with no
     * revision argument defaults to HEAD - so "show me nothing" would quietly render the entire
     * history reachable from the current branch, which looks exactly like the filter being broken.
     */
    if (refs !== null && refs.length === 0) {
      onPage({ commits: [], delta: finishLayout(this.state), done: true });
      return;
    }

    const args = [
      'log',
      ...LOG_ARGS,
      ...(refs === null ? ['--all'] : refs),
      ...stashes.keys(),
      ...(options.firstParentOnly === true ? ['--first-parent'] : []),
      ...ORDER_ARGS[options.order ?? 'date'],
      `--max-count=${maxCommits}`,
      ...(options.filters ?? []),
    ];

    /**
     * A stash records two or three parents - where HEAD was, the index, and any untracked files -
     * and only the first is history. Drawn literally every stash becomes a three-way merge into
     * commits that exist for no reason the user would recognise, so the rest are dropped here,
     * before the layout ever sees them.
     */
    const foldStashParents = (commits: Commit[]): Commit[] =>
      stashes.size === 0
        ? commits
        : commits.map((commit) =>
            stashes.has(commit.sha) && commit.parents.length > 1
              ? { ...commit, parents: commit.parents.slice(0, 1) }
              : commit,
          );

    const interner = new Interner();
    let buffer = '';
    let batch: Commit[] = [];

    const flush = (): void => {
      if (batch.length === 0) {
        return;
      }

      const delta = appendCommits(this.state, batch, layoutOptions);
      onPage({ commits: batch, delta, done: false });
      batch = [];
    };

    await this.git.stream(
      this.repo.root,
      args,
      (text) => {
        buffer += text;

        // The last piece is whatever git has written so far of the *next* record; it only becomes
        // complete when the following separator arrives.
        const parts = buffer.split(RECORD);
        buffer = parts.pop() ?? '';

        for (const part of parts) {
          if (part.length > 0) {
            batch.push(...foldStashParents(parseLog(part, interner)));
          }
        }

        if (batch.length >= batchSize) {
          flush();
        }
      },
      signal === undefined ? {} : { signal },
    );

    // Whatever git wrote after the final separator is the last record.
    if (buffer.length > 0) {
      batch.push(...foldStashParents(parseLog(buffer, interner)));
    }

    flush();

    onPage({ commits: [], delta: finishLayout(this.state), done: true });
  }
}
