/**
 * What one commit contains: its full message, and the files it changed.
 *
 * The file list comes from `--raw`, not `--name-status`, because raw records carry the **blob
 * OIDs** on both sides. Addressing a revision's content by blob OID rather than by
 * `<commit>:<path>` sidesteps rename resolution entirely - for a renamed file, `git show
 * <commit>:<newpath>` and `<parent>:<oldpath>` need two different paths, while the two blob OIDs
 * are right there in the record.
 */

import type { Git } from './exec.ts';
import type { RepoInfo } from './discovery.ts';

/** git's single-letter status, kept as git spells it rather than renamed to something friendlier. */
export const ChangeStatus = {
  Added: 'A',
  Copied: 'C',
  Deleted: 'D',
  Modified: 'M',
  Renamed: 'R',
  TypeChanged: 'T',
  Unmerged: 'U',
  Unknown: 'X',
} as const;

export type ChangeStatus = (typeof ChangeStatus)[keyof typeof ChangeStatus];

/** A blob OID of all zeroes means the file is absent on that side. */
const ABSENT = /^0+$/;

export interface FileChange {
  readonly status: ChangeStatus;
  readonly path: string;
  /** Set only for renames and copies. */
  readonly oldPath: string | null;
  /** Blob OID before the change, or null when the file did not exist. */
  readonly oldBlob: string | null;
  /** Blob OID after the change, or null when the file was deleted. */
  readonly newBlob: string | null;
  /** How similar the two sides are, for renames and copies (0-100). */
  readonly similarity: number | null;
}

export interface CommitDetails {
  readonly sha: string;
  readonly parents: string[];
  readonly author: string;
  readonly authorEmail: string;
  readonly authorDate: string;
  readonly committer: string;
  readonly committerDate: string;
  /** The whole message, subject line included. */
  readonly body: string;
  readonly files: FileChange[];
}

const DETAIL_FORMAT = '%H%x00%P%x00%aN%x00%aE%x00%aI%x00%cN%x00%cI%x00%B';

function toBlob(oid: string): string | null {
  return ABSENT.test(oid) ? null : oid;
}

/**
 * Parse `git show --format= -z --raw` output.
 *
 * Each record is `:<oldmode> <newmode> <oldblob> <newblob> <status>` followed by NUL and then one
 * path - or two, for a rename or copy. Under `-z` nothing is quoted or escaped, so paths with
 * spaces, quotes or non-ASCII characters come through byte for byte.
 */
export function parseRawDiff(output: string): FileChange[] {
  const tokens = output.split('\x00');
  const files: FileChange[] = [];
  let i = 0;

  while (i < tokens.length) {
    const header = tokens[i];

    if (header === undefined || !header.startsWith(':')) {
      i++;
      continue;
    }

    const fields = header.slice(1).split(' ');
    const rawStatus = fields[4] ?? '';
    const letter = rawStatus.charAt(0).toUpperCase();
    const similarity = rawStatus.length > 1 ? Number(rawStatus.slice(1)) : null;
    const renameLike = letter === 'R' || letter === 'C';

    const first = tokens[i + 1];
    const second = renameLike ? tokens[i + 2] : undefined;
    i += renameLike ? 3 : 2;

    if (first === undefined || (renameLike && second === undefined)) {
      continue;
    }

    files.push({
      status: (Object.values(ChangeStatus) as string[]).includes(letter)
        ? (letter as ChangeStatus)
        : ChangeStatus.Unknown,
      path: renameLike ? (second as string) : first,
      oldPath: renameLike ? first : null,
      oldBlob: toBlob(fields[2] ?? ''),
      newBlob: toBlob(fields[3] ?? ''),
      similarity: similarity !== null && Number.isFinite(similarity) ? similarity : null,
    });
  }

  return files;
}

export async function loadCommitDetails(
  git: Git,
  repo: RepoInfo,
  sha: string,
  signal?: AbortSignal,
): Promise<CommitDetails> {
  const options = signal === undefined ? {} : { signal };

  const [meta, raw] = await Promise.all([
    git.run(repo.root, ['show', '--no-patch', '--no-show-signature', `--format=${DETAIL_FORMAT}`, sha], options),
    git.run(
      repo.root,
      [
        'show',
        '--format=',
        '-z',
        '--raw',
        // Detect renames and copies so a moved file reads as one change rather than an add plus a
        // delete - and so both blob OIDs are available for the diff.
        '-M',
        '-C',
        // A merge's default is a dense combined diff, which is expensive and not what a file list
        // wants. Show what the merge brought in relative to the branch it landed on.
        '--diff-merges=first-parent',
        sha,
      ],
      options,
    ),
  ]);

  const f = meta.split('\x00');
  const parentField = f[1] ?? '';

  return {
    sha: f[0] ?? sha,
    parents: parentField.length === 0 ? [] : parentField.split(' ').filter((p) => p.length > 0),
    author: f[2] ?? '',
    authorEmail: f[3] ?? '',
    authorDate: f[4] ?? '',
    committer: f[5] ?? '',
    committerDate: f[6] ?? '',
    body: (f[7] ?? '').replace(/\s+$/, ''),
    files: parseRawDiff(raw),
  };
}
