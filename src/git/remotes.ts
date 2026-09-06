/**
 * The remotes themselves, rather than what is on them.
 *
 * `repoState` already reads the names, because almost every network action needs to know whether
 * there are any and which one to reach for. It reads names only: that is one line of `git remote`
 * on a path that runs on every refresh, and a URL is not worth a second process there.
 *
 * Managing them is the other case. It happens once, when asked, and it needs what the names alone
 * cannot say - where each one points, and what would go if it were removed.
 */

import type { Git } from './exec.ts';
import type { RepoInfo } from './discovery.ts';

export interface Remote {
  readonly name: string;
  /** Where a fetch goes. */
  readonly fetchUrl: string;
  /** Where a push goes, when that is somewhere else - `remote.<name>.pushurl`. Usually null. */
  readonly pushUrl: string | null;
}

/**
 * Every remote, with its URLs.
 *
 * `git remote -v` rather than reading config, because a remote can have a separate push URL and
 * more than one URL for fetch, and `-v` is the shape git itself reports rather than one assembled
 * out of config keys that may or may not be there.
 */
export async function readRemotes(git: Git, repo: RepoInfo): Promise<Remote[]> {
  const out = await git.runRead(repo.root, ['remote', '-v']).catch(() => '');
  const fetchUrls = new Map<string, string>();
  const pushUrls = new Map<string, string>();

  for (const line of out.split('\n')) {
    // `name<TAB>url (fetch)`. The URL can contain spaces on a local path, so take the direction
    // off the end and the name off the front rather than splitting the middle.
    const match = /^(\S+)\s+(.*)\s+\((fetch|push)\)$/.exec(line.trim());

    if (match === null) {
      continue;
    }

    const [, name, url, direction] = match;

    if (name !== undefined && url !== undefined) {
      (direction === 'fetch' ? fetchUrls : pushUrls).set(name, url);
    }
  }

  return [...fetchUrls].map(([name, fetchUrl]) => ({
    name,
    fetchUrl,
    // Only interesting when it differs; git reports the fetch URL for push when none is set.
    pushUrl: pushUrls.get(name) === fetchUrl ? null : (pushUrls.get(name) ?? null),
  }));
}

/** How many remote-tracking branches belong to a remote - what removing it would take with it. */
export async function countTrackingRefs(git: Git, repo: RepoInfo, name: string): Promise<number> {
  const out = await git
    .runRead(repo.root, ['for-each-ref', '--format=%(refname)', `refs/remotes/${name}/`])
    .catch(() => '');

  return out.split('\n').filter((line) => line.trim().length > 0).length;
}

/**
 * Whether git will accept this as a remote name.
 *
 * Git's own rule is `check_ref_format` against `refs/remotes/<name>/HEAD`, which is more permissive
 * than anyone expects and rejects things at a layer that reports them badly. These are the cases
 * that actually come up, refused here where the message can say what is wrong with them.
 */
export function nameProblem(name: string, taken: readonly string[]): string | null {
  if (name.length === 0) {
    return 'A remote needs a name';
  }

  if (/\s/.test(name)) {
    return 'A remote name cannot contain spaces';
  }

  if (name.includes('/')) {
    // `origin/main` is a branch. A remote called `origin/x` would make `origin/x/main` ambiguous.
    return 'A remote name cannot contain a slash';
  }

  if (name.startsWith('-')) {
    return 'A remote name cannot start with a dash';
  }

  if (name === '.') {
    // `branch.<name>.remote = .` already means "this repository".
    return '"." means this repository to git';
  }

  if (taken.includes(name)) {
    return `There is already a remote called ${name}`;
  }

  return null;
}
