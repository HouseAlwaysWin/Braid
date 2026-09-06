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
  /** Who committed it, which a rebase, a squash or a web-UI merge makes different from the author. */
  Committer: 'committer',
  /** Diff content: commits where the number of matches for the pattern changed. */
  Content: 'content',
  /** Commits that touched a path. */
  Path: 'path',
} as const;

export type SearchMode = (typeof SearchMode)[keyof typeof SearchMode];

export type SearchToggle = 'caseSensitive' | 'regex' | 'allTerms' | 'invert' | 'follow';

export interface Search {
  readonly query: string;
  readonly mode: SearchMode;
  /** Off means the query matches as text; on means it matches as a pattern. */
  readonly regex: boolean;
  readonly caseSensitive: boolean;
  /** Split the query on spaces and require every word, rather than any one of them. */
  readonly allTerms: boolean;
  /** Show the commits that do *not* match. */
  readonly invert: boolean;
  /** Follow a path through renames, so a file's history does not stop where it was moved. */
  readonly follow: boolean;
}

/**
 * Which switches actually change the answer in each mode, measured against git rather than guessed:
 *
 * - `--invert-grep` inverts `--grep` and nothing else, so it means something only in message mode.
 * - Multiple `-G` do not intersect and multiple pathspecs are a union, so `allTerms` has no
 *   `--all-match` to reach for there.
 * - A pathspec is not a regex; it is a glob with its own magic prefixes, so `regex` is meaningless.
 *
 * The webview reads this table to decide which buttons to show, and `searchArgs` reads it to decide
 * what to honour - one table, so a button can never be offered for something that does nothing.
 */
export const TOGGLES: Readonly<Record<SearchMode, readonly SearchToggle[]>> = {
  [SearchMode.Message]: ['caseSensitive', 'regex', 'allTerms', 'invert'],
  [SearchMode.Author]: ['caseSensitive', 'regex', 'allTerms'],
  [SearchMode.Committer]: ['caseSensitive', 'regex', 'allTerms'],
  [SearchMode.Content]: ['caseSensitive', 'regex'],
  [SearchMode.Path]: ['caseSensitive', 'follow'],
};

/**
 * Escape a string so git matches it as text.
 *
 * git's `--grep`, `--author`, `--committer` and `-G` are POSIX **basic** regular expressions, and
 * BRE is not the dialect a JavaScript instinct reaches for. `.` `*` `[` `^` `$` are operators and
 * have to be escaped - but `+` `?` `(` `)` `{` `}` `|` are *literal until you escape them*, so the
 * usual "backslash every punctuation mark" turns a name like `C++` into a pattern meaning something
 * else entirely, and `A|B` into a pattern that matches two different people.
 *
 * `--fixed-strings` would do all of this for us, and it is deliberately not used: it is a global
 * flag, so it would also reach the `--author` arguments the Authors sidebar contributes and the
 * escaping they already carry.
 */
export function escapeBasicRegex(text: string): string {
  return text.replace(/[\\^$.*\[]/g, '\\$&');
}

/**
 * `git log` arguments for a search, or an empty list when there is nothing to search for.
 *
 * A path filter has to come last and behind `--`, or git tries to resolve it as a revision and
 * fails on anything that is not also a branch name. Whatever else is on the command line - the
 * Authors sidebar's `--author`, above all - has to be placed before this.
 */
export function searchArgs(search: Search | null): string[] {
  if (search === null) {
    return [];
  }

  const query = search.query.trim();

  if (query.length === 0) {
    return [];
  }

  const supported = TOGGLES[search.mode];
  const on = (toggle: SearchToggle): boolean => supported.includes(toggle) && search[toggle];
  const pattern = (text: string): string => (on('regex') ? text : escapeBasicRegex(text));
  const ignoreCase = on('caseSensitive') ? [] : ['--regexp-ignore-case'];

  if (search.mode === SearchMode.Path) {
    /*
     * A pathspec takes its switches inside itself rather than as flags: everything after `--` is a
     * path, so there is nowhere else for them to go.
     *
     * Except that `--follow` will not have them. `git log --follow -- ':(icase)src/x.ts'` is not a
     * quieter answer but a fatal error - "pathspec magic not supported by --follow" - which would
     * take the whole walk with it. Following renames therefore means matching the path exactly,
     * and the view says so by showing the case switch as locked on rather than letting someone
     * turn off something that was never going to happen.
     */
    const follow = on('follow');
    const icase = !follow && !on('caseSensitive') ? ':(icase)' : '';

    return [...(follow ? ['--follow'] : []), '--', `${icase}${query}`];
  }

  if (search.mode === SearchMode.Content) {
    // The one pattern `--fixed-strings` does not reach - measured - so text mode escapes it here.
    return [...ignoreCase, `-G${pattern(query)}`];
  }

  const flag =
    search.mode === SearchMode.Author
      ? '--author='
      : search.mode === SearchMode.Committer
        ? '--committer='
        : '--grep=';

  const terms = on('allTerms') ? query.split(/\s+/).filter((term) => term.length > 0) : [query];

  return [
    ...ignoreCase,
    // Only with something to intersect: on a single pattern it is noise, and it is a global flag.
    ...(terms.length > 1 ? ['--all-match'] : []),
    ...(on('invert') ? ['--invert-grep'] : []),
    ...terms.map((term) => `${flag}${pattern(term)}`),
  ];
}

/**
 * Everything that narrows the walk, in the one order git accepts.
 *
 * A path search ends in `-- <path>`, and everything after `--` is a pathspec - so anything placed
 * behind it stops being a filter and becomes a filename that matches nothing. The bug is silent:
 * the search still returns commits, just not the ones that were asked for.
 */
export function filterArgs(
  search: Search | null,
  authors: readonly string[],
  dates: readonly string[] = [],
): string[] {
  return [...authors, ...dates, ...searchArgs(search)];
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
