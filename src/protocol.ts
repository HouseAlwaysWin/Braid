/**
 * The extension <-> webview contract.
 *
 * Two rules keep this cheap:
 *
 * - **Pages, never the whole history.** `postMessage` structured-clones its payload; handing it
 *   100k commits in one call freezes the extension host for seconds. Rows arrive in batches as git
 *   produces them.
 * - **Deltas, never restatements.** A page carries only the rows and lane points that are new. The
 *   webview appends; it never re-lays-out or re-renders what it already has.
 */

import type { GraphDelta } from './graph/layout.ts';
import type { GitRef } from './git/logParser.ts';
import type { CommitDetails } from './git/details.ts';
import type { Search } from './git/search.ts';
import type { MenuItem, Target } from './actions/registry.ts';

/** One commit as the webview needs it - the extension's richer `Commit` is not sent wholesale. */
export interface Row {
  readonly sha: string;
  readonly subject: string;
  readonly author: string;
  readonly date: string;
  readonly refs: readonly GitRef[];
  readonly isHead: boolean;
  /** `stash@{0}` when this row is a stash rather than a commit. */
  readonly stash?: string;
}

export type HostMessage =
  | {
      readonly type: 'init';
      readonly repoName: string;
      readonly repoRoot: string;
      readonly rowHeight: number;
      /** Whether author names are tinted per author. */
      readonly authorColors: boolean;
      /** Set when the repository is anything other than an ordinary clone, for the header. */
      readonly kind: string | null;
    }
  | {
      readonly type: 'page';
      readonly rows: readonly Row[];
      readonly delta: GraphDelta;
    }
  | { readonly type: 'done'; readonly total: number; readonly elapsedMs: number }
  | { readonly type: 'reset' }
  | { readonly type: 'details'; readonly details: CommitDetails }
  /** The repository changed under us and the graph has been reloaded from scratch. */
  | { readonly type: 'reloading'; readonly reason: string }
  | {
      readonly type: 'menu';
      readonly target: Target;
      readonly items: readonly MenuItem[];
      /** Echoed back from the request so the menu opens where the click was. */
      readonly x: number;
      readonly y: number;
    }
  /**
   * What git is halfway through, if anything. Sent on every reload: a graph that shows history
   * while hiding an unfinished rebase is how people end up several commands deep in something they
   * did not know they were in.
   */
  | {
      readonly type: 'operation';
      /** 'none' when nothing is in progress. */
      readonly operation: string;
      readonly description: string;
      readonly conflicted: readonly string[];
      readonly controls: readonly MenuItem[];
    }
  | { readonly type: 'error'; readonly message: string };

export type WebviewMessage =
  | { readonly type: 'ready' }
  | { readonly type: 'refresh' }
  | { readonly type: 'search'; readonly search: Search | null }
  | { readonly type: 'selectCommit'; readonly sha: string }
  /** Open one of the selected commit's files in VS Code's diff editor. */
  | { readonly type: 'openDiff'; readonly sha: string; readonly index: number }
  | { readonly type: 'copy'; readonly text: string }
  /** Right-click: the host decides what is on the menu, because availability depends on repo state. */
  | { readonly type: 'requestMenu'; readonly target: Target; readonly x: number; readonly y: number }
  | { readonly type: 'runAction'; readonly id: string; readonly target: Target }
  /** Hand a conflicted file to VS Code, whose merge editor is better at this than anything here. */
  | { readonly type: 'openConflict'; readonly path: string };
