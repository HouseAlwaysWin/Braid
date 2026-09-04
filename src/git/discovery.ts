/**
 * Working out what kind of repository a folder actually is.
 *
 * This is where a graph viewer usually goes wrong, because the obvious question - "where is the
 * .git directory?" - has four different answers:
 *
 * | layout           | `.git` at the root | `--git-dir`                      | `--git-common-dir` |
 * | ---------------- | ------------------ | -------------------------------- | ------------------ |
 * | ordinary clone   | a directory        | `<root>/.git`                    | same               |
 * | linked worktree  | a **file**         | `<main>/.git/worktrees/<name>`   | `<main>/.git`      |
 * | submodule        | a **file**         | `<super>/.git/modules/<name>`    | same               |
 * | bare repo        | absent             | the repo itself                  | same               |
 *
 * The split between the two dirs is the part that matters and the part that gets missed: refs,
 * `packed-refs` and the object store live in the **common** dir and are shared by every worktree,
 * while `HEAD` and `index` live in the **per-worktree** git dir. Watch only one of them and you
 * miss half the changes; read refs from the wrong one and a linked worktree shows an empty graph.
 */

import type { Git } from './exec.ts';

export interface RepoInfo {
  /** Working tree root, or the repository itself when bare. */
  readonly root: string;
  /** Per-worktree git dir: holds HEAD and index. */
  readonly gitDir: string;
  /** Shared git dir: holds refs, packed-refs and objects. Equal to gitDir for an ordinary clone. */
  readonly commonDir: string;
  readonly isBare: boolean;
  readonly isLinkedWorktree: boolean;
  /** Working tree of the superproject, when this repo is a submodule of one. */
  readonly superproject: string | null;
}

export interface Worktree {
  readonly path: string;
  readonly head: string | null;
  /** Full ref name, e.g. `refs/heads/main`; null when HEAD is detached. */
  readonly branch: string | null;
  readonly isBare: boolean;
  readonly isDetached: boolean;
  readonly isLocked: boolean;
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? '';
}

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Compare two git-reported paths. git always reports forward slashes, even on Windows. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Identify the repository containing `startPath`, or null if there isn't one.
 *
 * `--path-format=absolute` (git 2.31+) is what keeps this honest: without it `--git-dir` answers
 * with a bare `.git`, relative to a cwd the caller has to remember.
 */
export async function discover(git: Git, startPath: string): Promise<RepoInfo | null> {
  const probe = await git.tryRead(startPath, [
    'rev-parse',
    '--path-format=absolute',
    '--git-dir',
    '--git-common-dir',
  ]);

  if (probe.exitCode !== 0) {
    return null;
  }

  const dirs = lines(probe.stdout);
  const gitDir = dirs[0];
  const commonDir = dirs[1] ?? gitDir;

  if (gitDir === undefined || commonDir === undefined) {
    return null;
  }

  // --is-bare-repository and --show-superproject-working-tree are asked separately because
  // --show-toplevel *fails outright* inside a bare repo, and one failing option fails the lot.
  const [bareOut, superOut] = await Promise.all([
    git.runRead(startPath, ['rev-parse', '--is-bare-repository']),
    git.runRead(startPath, ['rev-parse', '--path-format=absolute', '--show-superproject-working-tree']),
  ]);

  const isBare = firstLine(bareOut) === 'true';
  const superproject = firstLine(superOut);

  const root = isBare
    ? commonDir
    : firstLine(await git.runRead(startPath, ['rev-parse', '--path-format=absolute', '--show-toplevel']));

  return {
    root,
    gitDir,
    commonDir,
    isBare,
    isLinkedWorktree: !samePath(gitDir, commonDir),
    superproject: superproject.length > 0 ? superproject : null,
  };
}

/**
 * Every worktree attached to this repository. The porcelain format is a blank-line-separated block
 * per worktree, with `<key> <value>` lines and bare `<key>` flags.
 */
export async function listWorktrees(git: Git, repo: RepoInfo): Promise<Worktree[]> {
  const out = await git.runRead(repo.root, ['worktree', 'list', '--porcelain']);
  const worktrees: Worktree[] = [];

  for (const block of out.split(/\r?\n\r?\n/)) {
    let path: string | null = null;
    let head: string | null = null;
    let branch: string | null = null;
    let isBare = false;
    let isDetached = false;
    let isLocked = false;

    for (const line of lines(block)) {
      const space = line.indexOf(' ');
      const key = space < 0 ? line : line.slice(0, space);
      const value = space < 0 ? '' : line.slice(space + 1);

      switch (key) {
        case 'worktree':
          path = value;
          break;
        case 'HEAD':
          head = value;
          break;
        case 'branch':
          branch = value;
          break;
        case 'bare':
          isBare = true;
          break;
        case 'detached':
          isDetached = true;
          break;
        case 'locked':
          isLocked = true;
          break;
        default:
          break;
      }
    }

    if (path !== null) {
      worktrees.push({ path, head, branch, isBare, isDetached, isLocked });
    }
  }

  return worktrees;
}

/**
 * The paths worth watching for "something changed". Refs live in the common dir and are shared;
 * HEAD and the index are per-worktree. A linked worktree needs both or a branch switch made in it
 * goes unnoticed.
 */
export function watchTargets(repo: RepoInfo): string[] {
  const targets = new Set<string>();

  for (const dir of [repo.commonDir, repo.gitDir]) {
    targets.add(`${dir}/HEAD`);
    targets.add(`${dir}/ORIG_HEAD`);
    targets.add(`${dir}/packed-refs`);
    targets.add(`${dir}/refs/**`);
  }

  return [...targets];
}
