/**
 * Parses the fixed `git log --format=...` record Braid asks for.
 *
 * Ported from GitFlick's `Services/CommitLogParser.cs`, with two changes:
 *
 * - Fields are separated by NUL, which can never occur inside any of them, so no quoting games are
 *   needed. That part is unchanged.
 * - *Records* are separated by RS (`\x1e`) rather than by newline. `%s` is folded to a single line
 *   by git so newline-separated records do work, but leaning on that is a latent bug the first time
 *   a field is added that is not so well behaved.
 * - Author name and email use `%aN`/`%aE`, which honour `.mailmap`, so someone who has committed
 *   under three addresses shows up once.
 */

export const RefKind = {
  LocalBranch: 'local',
  RemoteBranch: 'remote',
  Tag: 'tag',
} as const;

export type RefKind = (typeof RefKind)[keyof typeof RefKind];

export interface GitRef {
  readonly name: string;
  readonly kind: RefKind;
}

export interface Commit {
  readonly sha: string;
  readonly parents: string[];
  readonly author: string;
  readonly email: string;
  /** ISO-8601 with offset, straight from git - parsed lazily by the webview for display. */
  readonly authorDate: string;
  readonly commitDate: string;
  readonly refs: GitRef[];
  readonly isHead: boolean;
  readonly subject: string;
}

const RECORD = '\x1e';
const FIELD = '\x00';

/** %H sha, %P parents, %aN/%aE mailmap author, %aI/%cI ISO dates, %D decorations, %s subject. */
export const LOG_FORMAT = `%x1e%H%x00%P%x00%aN%x00%aE%x00%aI%x00%cI%x00%D%x00%s`;

/** The flags that must accompany LOG_FORMAT for the output to parse. */
export const LOG_ARGS = [
  '--no-show-signature',
  // A parent must never precede its child or the lane layout waits forever for a SHA that already
  // went past. Chronological order can violate that under clock skew; --date-order cannot.
  '--date-order',
  '--decorate=full',
  `--format=${LOG_FORMAT}`,
] as const;

/**
 * Deduplicates the fields that repeat across a whole history.
 *
 * A repository has a handful of authors and tens of thousands of commits, but every record is
 * parsed with `String.split`, which allocates a fresh string per field. Interning the author and
 * email collapses 100k allocations back down to one per distinct person. Measured on the 100k-commit
 * fixture: 78 MB of parsed commits down to 68 MB, for one Map lookup per field.
 */
export class Interner {
  private readonly seen = new Map<string, string>();

  intern(value: string): string {
    const existing = this.seen.get(value);
    if (existing !== undefined) {
      return existing;
    }

    this.seen.set(value, value);
    return value;
  }
}

export function parseLog(output: string, interner?: Interner): Commit[] {
  const commits: Commit[] = [];
  const intern = interner === undefined ? (v: string): string => v : (v: string) => interner.intern(v);

  for (const record of output.split(RECORD)) {
    if (record.length === 0) {
      continue;
    }

    const f = record.split(FIELD);
    if (f.length < 8) {
      continue;
    }

    const parentField = f[1] as string;
    const { refs, isHead } = parseDecorations(f[6] as string);

    commits.push({
      sha: f[0] as string,
      parents: parentField.length === 0 ? [] : parentField.split(' ').filter((p) => p.length > 0),
      author: intern(f[2] as string),
      email: intern(f[3] as string),
      authorDate: f[4] as string,
      commitDate: f[5] as string,
      refs,
      isHead,
      // The subject is the last field, and git terminates the record with a newline.
      subject: (f[7] as string).replace(/\r?\n$/, ''),
    });
  }

  return commits;
}

/**
 * Turns `HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1` into friendly
 * names, and reports whether HEAD is here.
 */
function parseDecorations(decorations: string): { refs: GitRef[]; isHead: boolean } {
  const refs: GitRef[] = [];
  let isHead = false;

  if (decorations.length === 0) {
    return { refs, isHead };
  }

  for (const raw of decorations.split(', ')) {
    let token = raw.trim();
    if (token.length === 0) {
      continue;
    }

    // "HEAD -> refs/heads/main" - HEAD is attached to the branch that follows.
    if (token.startsWith('HEAD -> ')) {
      isHead = true;
      token = token.slice('HEAD -> '.length);
    } else if (token === 'HEAD') {
      // Detached HEAD: it decorates the commit but isn't a branch.
      isHead = true;
      continue;
    }

    // git prefixes annotated tags with "tag: " even under --decorate=full.
    if (token.startsWith('tag: ')) {
      token = token.slice('tag: '.length);
    }

    const local = strip(token, 'refs/heads/');
    if (local !== null) {
      refs.push({ name: local, kind: RefKind.LocalBranch });
      continue;
    }

    const remote = strip(token, 'refs/remotes/');
    if (remote !== null) {
      // Skip "origin/HEAD" - it is a symbolic alias, not a branch you can check out.
      if (!remote.endsWith('/HEAD')) {
        refs.push({ name: remote, kind: RefKind.RemoteBranch });
      }

      continue;
    }

    const tag = strip(token, 'refs/tags/');
    if (tag !== null) {
      refs.push({ name: tag, kind: RefKind.Tag });
    }
  }

  return { refs, isHead };
}

function strip(token: string, prefix: string): string | null {
  if (!token.startsWith(prefix)) {
    return null;
  }

  const name = token.slice(prefix.length);
  return name.length > 0 ? name : null;
}
