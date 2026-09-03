/**
 * Turning a search box into `git log` arguments.
 *
 * The whole point is that git does the work. Loading 100k commits and then filtering the array in
 * JavaScript means paying for every commit the user did not ask for; `--grep` and friends let git
 * skip them during the walk, and `-G` in particular searches the *contents* of every diff, which
 * is not something a client-side filter could do at any price.
 *
 * Nothing here quotes or escapes: arguments reach git as an array, so a query of `--exec=rm -rf /`
 * is just a string that matches nothing.
 */

export const SearchMode = {
  /** Commit message, subject and body. */
  Message: 'message',
  Author: 'author',
  /** Diff content: commits where the number of matches for the pattern changed. */
  Content: 'content',
  /** Commits that touched a path. */
  Path: 'path',
} as const;

export type SearchMode = (typeof SearchMode)[keyof typeof SearchMode];

export interface Search {
  readonly query: string;
  readonly mode: SearchMode;
}

/**
 * `git log` arguments for a search, or an empty list when there is nothing to search for.
 *
 * A path filter has to come last and behind `--`, or git tries to resolve it as a revision and
 * fails on anything that is not also a branch name.
 */
export function searchArgs(search: Search | null): string[] {
  if (search === null) {
    return [];
  }

  const query = search.query.trim();

  if (query.length === 0) {
    return [];
  }

  switch (search.mode) {
    case SearchMode.Message:
      return ['--regexp-ignore-case', `--grep=${query}`];
    case SearchMode.Author:
      return ['--regexp-ignore-case', `--author=${query}`];
    case SearchMode.Content:
      return ['--regexp-ignore-case', `-G${query}`];
    case SearchMode.Path:
      // `--` ends the revision list; everything after it is a path.
      return ['--', query];
    default:
      return [];
  }
}

/**
 * Whether a query is a commit id rather than something to grep for.
 *
 * Typing a hash into a search box should jump to that commit, not run a substring match over every
 * message. Seven hex characters is git's own default abbreviation length.
 */
export function looksLikeCommitId(query: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(query.trim());
}
