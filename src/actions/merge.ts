/**
 * Merge, rebase, and getting out of either one.
 *
 * The operations themselves are two thin actions. The weight is in the third part: when a merge or
 * a rebase stops on a conflict, git leaves the repository in a state that has to be finished or
 * abandoned before anything else can happen, and a tool that shows a graph without showing that
 * state is how people end up three commands deep in something they did not know they were in.
 *
 * Weft does not try to resolve conflicts. VS Code's merge editor is better at that than anything
 * that would fit here, so Weft's job is to say what is going on, list the files, and offer the
 * three ways out git actually provides.
 */

import type { Action } from './types.ts';
import { Tier, blockedByOperation, revisionOf, shortLabel } from './types.ts';
import type { Git } from '../git/exec.ts';
import type { RepoInfo } from '../git/discovery.ts';
import { Operation, describeOperation } from '../git/repoState.ts';

/** The git subcommand each in-progress operation is finished or abandoned with. */
const CONTROL: Partial<Record<Operation, { verb: string; skips: boolean }>> = {
  [Operation.Merge]: { verb: 'merge', skips: false },
  [Operation.CherryPick]: { verb: 'cherry-pick', skips: true },
  [Operation.Revert]: { verb: 'revert', skips: true },
  [Operation.Rebase]: { verb: 'rebase', skips: true },
};

async function countAhead(git: Git, repo: RepoInfo, revision: string): Promise<number> {
  const out = await git
    .runRead(repo.root, ['rev-list', '--count', `HEAD..${revision}`])
    .catch(() => '0');

  return Number(out.trim()) || 0;
}

const merge: Action = {
  id: 'weft.merge',
  group: 'commit',
  // Forwards only: a merge adds a commit and moves the branch on. Nothing stops being reachable,
  // and a conflicted merge can be abandoned outright.
  tier: Tier.Safe,

  label: (target) => `Merge ${shortLabel(target)} into the current branch`,

  appliesTo: (target) => target.kind === 'ref' && target.refKind !== 'tag',

  unavailable(target, state) {
    const blocked = blockedByOperation(state);

    if (blocked !== null) {
      return blocked;
    }

    if (state.branch === null) {
      return 'Not on a branch';
    }

    if (target.kind === 'ref' && state.branch === target.label) {
      return 'Already on this branch';
    }

    return null;
  },

  async run({ git, repo, state, target, ui }) {
    const ahead = await countAhead(git, repo, revisionOf(target));

    if (ahead === 0) {
      return { message: `${shortLabel(target)} is already in ${state.branch ?? 'HEAD'}`, ran: false };
    }

    // --no-edit rather than relying on GIT_MERGE_AUTOEDIT: being explicit here means the command
    // behaves the same if anyone ever runs it by hand from the command log.
    await ui.progress(`Merging ${shortLabel(target)}`, () =>
      git.runWrite(repo.root, ['merge', '--no-edit', revisionOf(target)]),
    );

    return {
      message: `Merged ${ahead} ${ahead === 1 ? 'commit' : 'commits'} from ${shortLabel(target)}`,
      ran: true,
    };
  },
};

const rebase: Action = {
  id: 'weft.rebase',
  group: 'commit',
  // Rebase rewrites commits: the originals stop being reachable from the branch, and only the
  // reflog still knows about them.
  tier: Tier.Confirm,

  label: (target) => `Rebase the current branch onto ${shortLabel(target)}`,

  appliesTo: (target) => target.kind === 'commit' || (target.kind === 'ref' && target.refKind !== 'tag'),

  unavailable(target, state) {
    const blocked = blockedByOperation(state);

    if (blocked !== null) {
      return blocked;
    }

    if (state.branch === null) {
      return 'Not on a branch';
    }

    if (target.kind === 'ref' && state.branch === target.label) {
      return 'Already on this branch';
    }

    return null;
  },

  async confirmDetail({ git, repo, state, target }) {
    const revision = revisionOf(target);
    const rewritten = await git
      .runRead(repo.root, ['rev-list', '--count', `${revision}..HEAD`])
      .catch(() => '0');

    const count = Number(rewritten.trim()) || 0;
    const branch = state.branch ?? 'HEAD';

    if (count === 0) {
      return `${branch} has nothing that ${shortLabel(target)} does not, so this only moves the branch.`;
    }

    return (
      `${count} ${count === 1 ? 'commit' : 'commits'} on ${branch} will be rewritten onto ` +
      `${shortLabel(target)}. They get new hashes; the originals stay in the reflog.\n\n` +
      'If any of them are already pushed, everyone else will need to reconcile.'
    );
  },

  async run({ git, repo, state, target, ui }) {
    const branch = state.branch ?? 'HEAD';

    await ui.progress(`Rebasing ${branch}`, () =>
      git.runWrite(repo.root, ['rebase', revisionOf(target)]),
    );

    return { message: `Rebased ${branch} onto ${shortLabel(target)}`, ran: true };
  },
};

/**
 * The three ways out of a stopped operation.
 *
 * These are the mirror image of every other action: they are the only things available *while* an
 * operation is in progress, and unavailable at any other time.
 */
function control(
  kind: 'continue' | 'abort' | 'skip',
  options: { tier: Tier; label: string; detail?: string },
): Action {
  return {
    id: `weft.${kind}Operation`,
    // All three are the same kind of thing - a way out - and the banner selects on exactly this.
    // Abort still renders in red: the view styles by tier, not by group.
    group: 'operation',
    tier: options.tier,

    label: () => options.label,

    appliesTo: (target) => target.kind === 'repo',

    unavailable(_target, state) {
      if (state.operation === Operation.None) {
        return 'Nothing in progress';
      }

      const entry = CONTROL[state.operation];

      if (entry === undefined) {
        // Bisect is the odd one out: it has no --continue, and `bisect reset` is its way back.
        return kind === 'abort' ? null : 'Not available for this operation';
      }

      if (kind === 'skip' && !entry.skips) {
        return 'A merge cannot skip a commit';
      }

      if (kind === 'continue' && state.files.some((file) => file.conflicted)) {
        return 'Resolve the conflicts first';
      }

      return null;
    },

    async confirmDetail({ state }) {
      const name = describeOperation(state.operation) ?? 'the operation';
      return options.detail?.replace('{operation}', name) ?? '';
    },

    async run({ git, repo, state, ui }) {
      const name = describeOperation(state.operation) ?? 'the operation';
      const entry = CONTROL[state.operation];

      // Bisect ends with `bisect reset` rather than an --abort flag.
      const args =
        entry === undefined ? ['bisect', 'reset'] : [entry.verb, `--${kind}`];

      await ui.progress(`${options.label} ${name}`, () => git.runWrite(repo.root, args));

      return { message: `${options.label} ${name}`, ran: true };
    },
  };
}

export const MERGE_ACTIONS: readonly Action[] = [
  merge,
  rebase,
  control('continue', { tier: Tier.Safe, label: 'Continue' }),
  control('skip', {
    tier: Tier.Confirm,
    label: 'Skip',
    detail:
      'The commit being applied is dropped and {operation} carries on with the next one. It stays in the reflog.',
  }),
  control('abort', {
    tier: Tier.Confirm,
    label: 'Abort',
    detail:
      'Everything {operation} has done so far is undone and the repository goes back to where it started.',
  }),
];
