/**
 * What the repository is in the middle of, and what would be lost if we acted on it.
 *
 * Two questions, both of which every write action has to ask first:
 *
 * **"What operation am I in?"** git records this as files in the git directory rather than
 * anywhere queryable, and getting it wrong is the top source of bugs in this kind of tool - it is
 * what produces "merge failed: you are in the middle of a rebase" three steps later. Note these
 * live in the **per-worktree** git dir, not the common one: two worktrees can be mid-different
 * operations at the same time.
 *
 * **"Is there uncommitted work?"** Tier-3 actions have to name the files they would destroy, and
 * "are you sure?" without a list is not a warning, it is a shrug.
 */

import { access, stat } from 'node:fs/promises';

import type { Git } from './exec.ts';
import type { RepoInfo } from './discovery.ts';

export const Operation = {
  None: 'none',
  Merge: 'merge',
  CherryPick: 'cherry-pick',
  Revert: 'revert',
  Rebase: 'rebase',
  Bisect: 'bisect',
  /**
   * `merge --squash`, staged and not yet committed.
   *
   * The odd one out, and the reason it is here at all: it leaves no `MERGE_HEAD`, so `git merge
   * --abort` refuses it - "There is no merge to abort" - and every other way out git offers is for
   * something this is not. Without it the repository sits with staged changes, possibly conflicted,
   * and no banner saying so. Offering a way into that state without recognising it would be worse
   * than not offering the state.
   */
  Squash: 'squash',
} as const;

export type Operation = (typeof Operation)[keyof typeof Operation];

export interface FileStatus {
  readonly path: string;
  /** Two-letter XY code as `git status --porcelain` spells it. */
  readonly code: string;
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly untracked: boolean;
  readonly conflicted: boolean;
}

/** Where the current branch stands against the branch it tracks. */
export interface Upstream {
  /** `origin/main`, as git spells it. */
  readonly ref: string;
  /** Commits on this branch that the upstream does not have. */
  readonly ahead: number;
  /** Commits on the upstream that this branch does not have. */
  readonly behind: number;
  /** Configured but no longer there - someone deleted the branch on the remote. */
  readonly gone: boolean;
}

export interface RepoState {
  readonly operation: Operation;
  readonly head: string | null;
  /** Branch name, or null when HEAD is detached or the repository has no commits yet. */
  readonly branch: string | null;
  readonly detached: boolean;
  readonly files: FileStatus[];
  /** Existing local branch names - actions that create or rename need to know what is taken. */
  readonly branches: string[];
  readonly tags: string[];
  readonly remotes: string[];
  /** null when the branch tracks nothing, HEAD is detached, or the repository is bare. */
  readonly upstream: Upstream | null;
  /** When a remote was last heard from, which is what the ahead/behind counts are true as of. */
  readonly fetchedAt: number | null;
}

/**
 * The `## branch...upstream [ahead 1, behind 2]` line `git status -b` puts first.
 *
 * Free information: status is already being run, and this is the only way to get the branch, its
 * upstream and both counts without three more processes. A branch name cannot contain `..`, so the
 * three dots are an unambiguous separator rather than a guess.
 */
export function parseBranchHeader(output: string): Upstream | null {
  const header = output.split('\x00').find((record) => record.startsWith('## '));

  if (header === undefined) {
    return null;
  }

  const body = header.slice(3);

  // `## HEAD (no branch)` when detached, and an unborn branch has no counts to report either.
  if (body.startsWith('No commits yet on')) {
    return null;
  }

  const separator = body.indexOf('...');

  if (separator < 0) {
    return null;
  }

  const rest = body.slice(separator + 3);
  const bracket = rest.indexOf(' [');
  const track = bracket < 0 ? '' : rest.slice(bracket + 2, -1);

  return {
    ref: bracket < 0 ? rest : rest.slice(0, bracket),
    ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
    behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
    gone: track === 'gone',
  };
}

/**
 * Unmerged states, as `git status --porcelain` reports them. `DD` and `AA` are both-sides changes;
 * anything with a `U` on either side is a conflict git could not resolve.
 */
function isConflicted(code: string): boolean {
  return code === 'DD' || code === 'AA' || code.includes('U');
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Which operation the git dir says is in progress.
 *
 * Order matters a little: a rebase that stops on a conflict also writes `REBASE_HEAD`, and a
 * cherry-pick during a rebase writes `CHERRY_PICK_HEAD`, so rebase is checked first and wins.
 * `rebase-merge` and `rebase-apply` are two different implementations of rebase, not two different
 * operations - checking only one of them misses half the cases.
 */
export async function readOperation(gitDir: string): Promise<Operation> {
  const [rebaseMerge, rebaseApply] = await Promise.all([
    exists(`${gitDir}/rebase-merge`),
    exists(`${gitDir}/rebase-apply`),
  ]);

  if (rebaseMerge || rebaseApply) {
    return Operation.Rebase;
  }

  const [merge, cherryPick, revert, bisect, squash] = await Promise.all([
    exists(`${gitDir}/MERGE_HEAD`),
    exists(`${gitDir}/CHERRY_PICK_HEAD`),
    exists(`${gitDir}/REVERT_HEAD`),
    exists(`${gitDir}/BISECT_LOG`),
    // Written by `merge --squash` whether or not it conflicted, and removed by the commit that
    // concludes it - so its presence means exactly "a squash is staged and not yet committed".
    exists(`${gitDir}/SQUASH_MSG`),
  ]);

  if (merge) {
    return Operation.Merge;
  }

  if (cherryPick) {
    return Operation.CherryPick;
  }

  if (revert) {
    return Operation.Revert;
  }

  if (bisect) {
    return Operation.Bisect;
  }

  // Last: a squash writes SQUASH_MSG and nothing else writes it, but checking it after the others
  // costs nothing and keeps a real merge winning if some future git ever wrote both.
  if (squash) {
    return Operation.Squash;
  }

  return Operation.None;
}

/**
 * Parse `git status --porcelain -z`.
 *
 * Records are `XY<space><path>` terminated by NUL. A rename carries two paths - the new one in the
 * record and the old one in the NUL-separated field that follows - so a parser that assumes one
 * path per record silently shifts everything after the first rename.
 */
export function parseStatus(output: string): FileStatus[] {
  const tokens = output.split('\x00');
  const files: FileStatus[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const record = tokens[i];

    if (record === undefined || record.length < 4) {
      continue;
    }

    // `-b` puts a branch header in front of the file records; it is not a file.
    if (record.startsWith('## ')) {
      continue;
    }

    const code = record.slice(0, 2);
    const path = record.slice(3);
    const x = code.charAt(0);
    const y = code.charAt(1);

    // A rename or copy consumes the following field as its source path.
    if (x === 'R' || x === 'C') {
      i++;
    }

    files.push({
      path,
      code,
      staged: x !== ' ' && x !== '?',
      unstaged: y !== ' ' && y !== '?',
      untracked: code === '??',
      conflicted: isConflicted(code),
    });
  }

  return files;
}

/** The working tree and where the branch stands - everything one `git status -b` already says. */
export interface WorkingTree {
  readonly files: FileStatus[];
  readonly branch: string | null;
  readonly upstream: Upstream | null;
  /** When a remote was last heard from, as epoch milliseconds, or null if it never has been. */
  readonly fetchedAt: number | null;
}

/**
 * When this repository last fetched.
 *
 * Every ahead/behind count is a statement about the moment of the last fetch and not about now:
 * `origin/main` is a local pointer that only a fetch moves, so "0 behind" means "0 behind as of
 * then". Without a timestamp beside them the numbers read as current and are believed.
 *
 * `FETCH_HEAD` is rewritten by every fetch, successful or not, so its mtime is the answer without
 * asking git anything. It lives in the common dir, which for a linked worktree is not its own.
 */
export async function lastFetch(repo: RepoInfo): Promise<number | null> {
  try {
    return (await stat(`${repo.commonDir}/FETCH_HEAD`)).mtimeMs;
  } catch {
    // Never fetched, or a repository with no remote at all.
    return null;
  }
}

/**
 * The working tree alone, in one process where `readRepoState` costs six.
 *
 * This is what a file being saved needs re-read, and saving a file cannot move a ref - so asking
 * for the branches, the tags and the remotes as well would be five processes spent on questions
 * nobody asked, on an event that arrives every time an editor autosaves.
 */
export async function readWorkingTree(git: Git, repo: RepoInfo): Promise<WorkingTree> {
  if (repo.isBare) {
    // Bare: no working tree to be dirty, but it can still have fetched.
    return { files: [], branch: null, upstream: null, fetchedAt: await lastFetch(repo) };
  }

  const [status, fetchedAt] = await Promise.all([
    git.runRead(repo.root, ['status', '--porcelain', '-z', '-b']),
    lastFetch(repo),
  ]);

  return {
    files: parseStatus(status),
    branch: parseBranchName(status),
    upstream: parseBranchHeader(status),
    fetchedAt,
  };
}

/**
 * The local branch out of the `## ` header, or null when HEAD is detached.
 *
 * git spells a detached HEAD `## HEAD (no branch)`, which is a sentinel rather than a branch called
 * HEAD - and a real branch cannot contain a space, so the two are told apart by that.
 */
export function parseBranchName(output: string): string | null {
  const line = output.split('\x00').find((record) => record.startsWith('## '));

  if (line === undefined) {
    return null;
  }

  const name = line.slice(3).split('...')[0]?.trim() ?? '';

  return name.length === 0 || name.includes(' ') ? null : name;
}

export async function readRepoState(git: Git, repo: RepoInfo): Promise<RepoState> {
  const [operation, status, head, branch, refs, remotes, fetchedAt] = await Promise.all([
    readOperation(repo.gitDir),
    // A bare repository has no working tree, so there is nothing to be dirty. `-b` costs nothing
    // and carries the upstream and the ahead/behind counts, which network actions need.
    repo.isBare ? Promise.resolve('') : git.runRead(repo.root, ['status', '--porcelain', '-z', '-b']),
    git.runRead(repo.root, ['rev-parse', 'HEAD']).catch(() => ''),
    // Empty output and a non-zero exit both mean "not on a branch"; -q keeps the noise down.
    git.runRead(repo.root, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => ''),
    git.runRead(repo.root, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/tags']),
    git.runRead(repo.root, ['remote']).catch(() => ''),
    lastFetch(repo),
  ]);

  const names = refs
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const branchName = branch.trim();
  const headSha = head.trim();

  return {
    operation,
    head: headSha.length > 0 ? headSha : null,
    branch: branchName.length > 0 ? branchName : null,
    detached: headSha.length > 0 && branchName.length === 0,
    files: parseStatus(status),
    branches: names.filter((r) => r.startsWith('refs/heads/')).map((r) => r.slice('refs/heads/'.length)),
    tags: names.filter((r) => r.startsWith('refs/tags/')).map((r) => r.slice('refs/tags/'.length)),
    remotes: remotes.split('\n').map((line) => line.trim()).filter((line) => line.length > 0),
    upstream: parseBranchHeader(status),
    fetchedAt,
  };
}

/** Files that a hard reset or a forced checkout would throw away. */
export function workAtRisk(state: RepoState): FileStatus[] {
  return state.files.filter((file) => !file.untracked);
}

/** A short phrase naming the operation, for messages like "finish the rebase first". */
export function describeOperation(operation: Operation): string | null {
  switch (operation) {
    case Operation.Merge:
      return 'a merge';
    case Operation.CherryPick:
      return 'a cherry-pick';
    case Operation.Revert:
      return 'a revert';
    case Operation.Rebase:
      return 'a rebase';
    case Operation.Bisect:
      return 'a bisect';
    case Operation.Squash:
      return 'a squash merge';
    default:
      return null;
  }
}
