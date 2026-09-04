/**
 * Who has committed to this repository.
 *
 * `shortlog -sne` is the right tool rather than counting `git log` output by hand: it groups by
 * identity and honours `.mailmap`, so someone who has committed from three addresses appears once
 * rather than three times - the same reason the log format uses `%aN` instead of `%an`.
 *
 * It walks the whole history, so this is loaded on demand rather than on open.
 */

import type { Git } from './exec.ts';
import type { RepoInfo } from './discovery.ts';

export interface Author {
  readonly name: string;
  readonly email: string;
  readonly commits: number;
}

/** `   42\tMartin Wang <martin@example.com>` */
const LINE = /^\s*(\d+)\s+(.*?)\s*<([^>]*)>\s*$/;

export async function listAuthors(git: Git, repo: RepoInfo): Promise<Author[]> {
  const out = await git
    .runRead(repo.root, ['shortlog', '--summary', '--numbered', '--email', '--all'])
    .catch(() => '');

  return out
    .split('\n')
    .flatMap((line) => {
      const match = LINE.exec(line);

      if (match === null) {
        return [];
      }

      return [
        {
          commits: Number(match[1]) || 0,
          name: match[2] ?? '',
          email: match[3] ?? '',
        },
      ];
    })
    .filter((author) => author.name.length > 0);
}

/**
 * `git log --author` takes a regular expression, and names contain characters that mean something
 * to a regex - `Foo (Bar)` and `A. Person` are ordinary names that would otherwise match the wrong
 * people or nobody at all.
 *
 * Escaping here rather than passing `--fixed-strings` is deliberate: that flag would also apply to
 * the user's message search, quietly changing what their own query means.
 */
export function authorArgs(names: readonly string[]): string[] {
  return names.map((name) => `--author=${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
}
