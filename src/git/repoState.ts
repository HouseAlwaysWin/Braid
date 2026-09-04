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

import { access } from 'node:fs/promises';

import type { Git } from './exec.ts';
import type { RepoInfo } from './discovery.ts';

export const Operation = {
  None: 'none',
  Merge: 'merge',
  CherryPick: 'cherry-pick',
  Revert: 'revert',
  Rebase: 'rebase',
  Bisect: 'bisect',
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

export interface RepoState {
  readonly operation: Operation;
  readonly head: string | null;
  /** Branch name, or null when HEAD is detached or the repository has no commits yet. */
  readonly branch: string | null;
  readonly detached: boolean;
  readonly files: FileStatus[];
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

  const [merge, cherryPick, revert, bisect] = await Promise.all([
    exists(`${gitDir}/MERGE_HEAD`),
    exists(`${gitDir}/CHERRY_PICK_HEAD`),
    exists(`${gitDir}/REVERT_HEAD`),
    exists(`${gitDir}/BISECT_LOG`),
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

export async function readRepoState(git: Git, repo: RepoInfo): Promise<RepoState> {
  const [operation, status, head, branch] = await Promise.all([
    readOperation(repo.gitDir),
    // A bare repository has no working tree, so there is nothing to be dirty.
    repo.isBare ? Promise.resolve('') : git.runRead(repo.root, ['status', '--porcelain', '-z']),
    git.runRead(repo.root, ['rev-parse', 'HEAD']).catch(() => ''),
    // Empty output and a non-zero exit both mean "not on a branch"; -q keeps the noise down.
    git.runRead(repo.root, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => ''),
  ]);

  const branchName = branch.trim();
  const headSha = head.trim();

  return {
    operation,
    head: headSha.length > 0 ? headSha : null,
    branch: branchName.length > 0 ? branchName : null,
    detached: headSha.length > 0 && branchName.length === 0,
    files: parseStatus(status),
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
    default:
      return null;
  }
}
