/**
 * Noticing that the repository changed underneath us.
 *
 * git has no change notification, so the only option is to watch the filesystem. Two decisions
 * matter:
 *
 * **What to watch.** GitFlick watches the whole working tree, which is right for a GUI that also
 * shows uncommitted changes but far too expensive here - on a repository with 100k files it means
 * a recursive watch over all of them to learn about a branch switch. The graph only cares about
 * refs and HEAD, so watch the git directory instead. That is also where the worktree split bites:
 * refs and `packed-refs` live in the **common** dir and are shared, while `HEAD` lives in the
 * **per-worktree** dir. Watch only one and a branch switch inside a linked worktree goes unseen.
 *
 * **When to believe it.** One git command touches many paths in a burst - `index.lock`, the index,
 * refs, then the working tree - so events are debounced. And even after the dust settles, a
 * filesystem event is not proof anything the graph cares about actually moved: the caller confirms
 * with a cheap ref probe before paying for a reload.
 */

import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';

import type { Git } from './exec.ts';
import type { RepoInfo } from './discovery.ts';

/** Churn that says nothing about what the user would see. */
export function isNoise(path: string): boolean {
  const p = path.replace(/\\/g, '/');

  return (
    p.endsWith('.lock') ||
    p.includes('objects/') ||
    p.endsWith('COMMIT_EDITMSG') ||
    // Our own reads should never wake us up.
    p.endsWith('FETCH_HEAD')
  );
}

export class RepoWatcher {
  private readonly watchers: FSWatcher[] = [];
  private readonly onChange: () => void;
  private readonly debounceMs: number;
  private timer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(repo: RepoInfo, onChange: () => void, debounceMs = 600) {
    this.onChange = onChange;
    this.debounceMs = debounceMs;

    // The two dirs are the same for an ordinary clone; a Set keeps that from watching it twice.
    for (const dir of new Set([repo.commonDir, repo.gitDir])) {
      // The dir itself, shallow: HEAD, ORIG_HEAD, packed-refs.
      this.add(dir, false);
      // refs/, deep: loose refs live several levels down (refs/remotes/origin/feature/x).
      this.add(`${dir}/refs`, true);
    }
  }

  get watching(): number {
    return this.watchers.length;
  }

  private add(path: string, recursive: boolean): void {
    try {
      const watcher = watch(path, { recursive, persistent: false }, (_event, filename) => {
        if (filename === null || !isNoise(String(filename))) {
          this.schedule();
        }
      });

      // A path we cannot watch - a network share, a permission wall, a dir that does not exist
      // yet - just means no live updates from it. Manual refresh still works.
      watcher.on('error', () => undefined);
      this.watchers.push(watcher);
    } catch {
      // Same: not watchable, not fatal.
    }
  }

  private schedule(): void {
    if (this.disposed) {
      return;
    }

    if (this.timer !== null) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      this.onChange();
    }, this.debounceMs);
  }

  dispose(): void {
    this.disposed = true;

    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    for (const watcher of this.watchers) {
      watcher.close();
    }

    this.watchers.length = 0;
  }
}

/**
 * A cheap fingerprint of everything the graph draws from: every ref and where HEAD points.
 *
 * This is what stops a filesystem event from costing a full reload. `for-each-ref` on a repository
 * with a few hundred refs is a couple of milliseconds, against seconds to re-walk a large history,
 * so the common case - an editor wrote a file, git touched a lock - settles for the price of one
 * comparison.
 */
export async function refSignature(git: Git, repo: RepoInfo): Promise<string> {
  const [refs, head] = await Promise.all([
    git.run(repo.root, ['for-each-ref', '--format=%(objectname)%(refname)']),
    git.run(repo.root, ['rev-parse', 'HEAD']).catch(() => ''),
  ]);

  return `${head.trim()}\n${refs}`;
}
