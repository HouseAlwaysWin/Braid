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
  readonly firstParentOnly?: boolean;
}

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

    // An empty ref list is not the same as no ref list: it means the user unticked everything, and
    // the honest answer to that is an empty graph rather than the whole history.
    const refs = options.refs ?? null;

    const args = [
      'log',
      ...LOG_ARGS,
      ...(refs === null ? ['--all'] : refs),
      `--max-count=${maxCommits}`,
      ...(options.filters ?? []),
    ];

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
            batch.push(...parseLog(part, interner));
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
      batch.push(...parseLog(buffer, interner));
    }

    flush();

    onPage({ commits: [], delta: finishLayout(this.state), done: true });
  }
}
