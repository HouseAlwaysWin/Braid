/**
 * Stashes.
 *
 * A stash is a commit, which is why it can appear in the graph at all - but a commit with a shape
 * that would look absurd drawn literally. `git stash` records two or three parents: where HEAD was,
 * the state of the index, and, when `-u` was used, the untracked files. Drawn as-is, every stash
 * becomes a three-way merge blob attached to nothing anyone recognises.
 *
 * So Braid keeps only the first parent. The index and untracked-files parents are how git stores a
 * stash, not something the user put there.
 *
 * The other quirk: only the newest stash is a ref. `stash@{1}` and older live in the reflog of
 * `refs/stash`, so `--all` never sees them and they have to be named by SHA.
 */

import type { Git } from './exec.ts';
import type { RepoInfo } from './discovery.ts';

export interface Stash {
  readonly sha: string;
  /** `stash@{0}` - what git accepts as an argument and what the user recognises. */
  readonly name: string;
  /** The subject git generated, e.g. `WIP on main: 1234abc some commit`. */
  readonly message: string;
}

const RECORD = '\x1e';
const FIELD = '\x00';

/**
 * The separators are written as git's `%x1e`/`%x00` placeholders, never as the characters
 * themselves. An argv string ends at its first NUL, so interpolating a literal one truncates the
 * whole `--format` argument there - git then receives a format with no field separators at all and
 * every record parses as a single unusable field.
 */
const FORMAT = '--format=%x1e%H%x00%gd%x00%gs';

export async function listStashes(git: Git, repo: RepoInfo): Promise<Stash[]> {
  // A repository with no stashes has no refs/stash at all, and `stash list` exits 0 with nothing.
  const out = await git.runRead(repo.root, ['stash', 'list', FORMAT]).catch(() => '');

  return out
    .split(RECORD)
    .filter((record) => record.length > 0)
    .flatMap((record) => {
      const [sha = '', name = '', message = ''] = record.split(FIELD);

      if (sha.length === 0 || name.length === 0) {
        return [];
      }

      return [{ sha, name, message: message.replace(/\r?\n$/, '') }];
    });
}
