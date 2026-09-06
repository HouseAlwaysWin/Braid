/**
 * Commit-level actions: cherry-pick, revert, reset.
 *
 * Two things git makes the caller handle.
 *
 * **A merge has no single "the change".** `revert` and `cherry-pick` both refuse a merge commit
 * unless told which parent to treat as the mainline, so both look the commit up first and pass
 * `-m 1` when it has more than one. Parent 1 is the branch that was merged *into*, which is what
 * "undo this merge" means every time anyone says it.
 *
 * **Reset is three different operations wearing one name.** They differ only in what survives, so
 * they are three actions with three tiers rather than one action with a mode argument: `--soft` and
 * `--mixed` move a ref and leave every byte of work in place, while `--hard` is the only thing in
 * Weft that can destroy uncommitted work outright.
 */

import type { Action } from './types.ts';
import { Tier, blockedByOperation, revisionOf, shortLabel } from './types.ts';
import type { Git } from '../git/exec.ts';
import type { RepoInfo } from '../git/discovery.ts';
import { workAtRisk } from '../git/repoState.ts';

/** How many parents a commit has - the thing that decides whether `-m` is required. */
async function parentCount(git: Git, repo: RepoInfo, revision: string): Promise<number> {
  const out = await git.runRead(repo.root, ['rev-list', '--parents', '-n', '1', revision]);
  return out.trim().split(/\s+/).length - 1;
}

/** Commits that would stop being on the current branch if it were reset back to `revision`. */
async function commitsDropped(git: Git, repo: RepoInfo, revision: string): Promise<number> {
  const out = await git
    .runRead(repo.root, ['rev-list', '--count', `${revision}..HEAD`])
    .catch(() => '0');

  return Number(out.trim()) || 0;
}

/** What a reset would be moving: the branch name, or HEAD itself when detached. */
function movedRef(state: { branch: string | null }): string {
  return state.branch ?? 'HEAD';
}

const cherryPick: Action = {
  id: 'weft.cherryPick',
  group: 'commit',
  tier: Tier.Safe,

  label: (target) => `Cherry-pick ${shortLabel(target)}`,

  appliesTo: (target) => target.kind === 'commit',

  unavailable(target, state) {
    const blocked = blockedByOperation(state);

    if (blocked !== null) {
      return blocked;
    }

    if (target.kind === 'commit' && state.head === target.sha) {
      return 'Already the current commit';
    }

    return null;
  },

  async run({ git, repo, state, target, ui }) {
    const revision = revisionOf(target);
    const parents = await parentCount(git, repo, revision);
    const onto = movedRef(state);

    const args = ['cherry-pick', '--no-edit'];

    // A merge needs a mainline to pick relative to; without one git refuses outright.
    if (parents > 1) {
      args.push('-m', '1');
    }

    args.push(revision);

    await ui.progress(`Cherry-picking ${shortLabel(target)}`, () => git.runWrite(repo.root, args));

    return { message: `Cherry-picked ${shortLabel(target)} onto ${onto}`, ran: true };
  },
};

const revert: Action = {
  id: 'weft.revert',
  group: 'commit',
  tier: Tier.Safe,

  label: (target) => `Revert ${shortLabel(target)}`,

  appliesTo: (target) => target.kind === 'commit',

  unavailable: (_target, state) => blockedByOperation(state),

  async run({ git, repo, state, target, ui }) {
    const revision = revisionOf(target);
    const parents = await parentCount(git, repo, revision);
    const onto = movedRef(state);

    const args = ['revert', '--no-edit'];

    if (parents > 1) {
      args.push('-m', '1');
    }

    args.push(revision);

    await ui.progress(`Reverting ${shortLabel(target)}`, () => git.runWrite(repo.root, args));

    // Say when a mainline was assumed. Reverting a merge against the other parent is a different
    // change entirely, and silently picking one would be the kind of guess that costs an afternoon.
    const note = parents > 1 ? ', relative to the branch it was merged into' : '';
    return { message: `Reverted ${shortLabel(target)} on ${onto}${note}`, ran: true };
  },
};

/** The three resets differ only in what survives, so they are built from one description. */
function resetAction(
  mode: 'soft' | 'mixed' | 'hard',
  options: { tier: Tier; label: (at: string) => string; keeps: string },
): Action {
  return {
    id: `weft.reset${mode.charAt(0).toUpperCase()}${mode.slice(1)}`,
    group: 'danger',
    tier: options.tier,

    label: (target) => options.label(shortLabel(target)),

    appliesTo: (target) => target.kind === 'commit',

    unavailable(target, state) {
      const blocked = blockedByOperation(state);

      if (blocked !== null) {
        return blocked;
      }

      if (target.kind === 'commit' && state.head === target.sha && mode !== 'hard') {
        // A hard reset to the current commit is still useful - it discards the working tree - but
        // soft and mixed would do nothing at all.
        return 'Already here';
      }

      return null;
    },

    async confirmDetail(context) {
      const { git, repo, state, target } = context;
      const dropped = await commitsDropped(git, repo, revisionOf(target));
      const ref = movedRef(state);

      const lines = [
        dropped === 0
          ? `${ref} already points here.`
          : `${ref} moves back ${dropped} ${dropped === 1 ? 'commit' : 'commits'}. They stay in the reflog.`,
        options.keeps,
      ];

      if (mode === 'hard') {
        const atRisk = workAtRisk(state);

        lines.push(
          atRisk.length === 0
            ? 'The working tree is clean, so there is nothing uncommitted to lose.'
            : `These uncommitted changes are lost permanently:\n\n${atRisk
                .map((file) => `  ${file.path}`)
                .join('\n')}`,
        );
      }

      return lines.join('\n\n');
    },

    async run({ git, repo, state, target, ui }) {
      const ref = movedRef(state);

      await ui.progress(`Resetting ${ref}`, () =>
        git.runWrite(repo.root, ['reset', `--${mode}`, revisionOf(target)]),
      );

      return { message: `Reset ${ref} to ${shortLabel(target)} (${mode})`, ran: true };
    },
  };
}

export const COMMIT_ACTIONS: readonly Action[] = [
  cherryPick,
  revert,
  resetAction('soft', {
    tier: Tier.Confirm,
    label: (at) => `Reset to ${at}, keeping all changes`,
    keeps: 'Everything you had staged and unstaged stays exactly as it is.',
  }),
  resetAction('mixed', {
    tier: Tier.Confirm,
    label: (at) => `Reset to ${at}, keeping the working tree`,
    keeps: 'Your files are untouched; what was staged becomes unstaged.',
  }),
  resetAction('hard', {
    tier: Tier.Destructive,
    label: (at) => `Reset to ${at}, discarding all changes`,
    keeps: 'The working tree and the index are both thrown away.',
  }),
];
