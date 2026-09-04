/**
 * Stash actions.
 *
 * Two things make stashes different from everything else here.
 *
 * **The names shift.** `stash@{0}` is a position, not an identity: drop `stash@{0}` and what was
 * `stash@{1}` becomes `stash@{0}`. So every action resolves the position to a SHA first and checks
 * that it still points where the menu thought it did. Acting on a name that moved is how a tool
 * drops the wrong stash.
 *
 * **Dropping is the one genuinely unrecoverable thing here.** The commit survives until garbage
 * collection, so the confirmation hands over the SHA - that is the difference between "gone" and
 * "recoverable if you wrote the number down".
 */

import type { Action, ActionContext } from './types.ts';
import { Tier, blockedByOperation } from './types.ts';
import { listStashes } from '../git/stash.ts';

/**
 * Re-read the stash list and confirm the position still holds the SHA the menu was built from.
 *
 * Between opening the menu and clicking, another window may have popped a stash. Resolving by name
 * alone would then act on whatever slid into that slot.
 */
async function verifyStash(context: ActionContext): Promise<string | null> {
  const target = context.target;

  if (target.kind !== 'stash') {
    return 'Not a stash';
  }

  const stashes = await listStashes(context.git, context.repo);
  const found = stashes.find((stash) => stash.name === target.name);

  if (found === undefined) {
    return `${target.name} no longer exists`;
  }

  if (found.sha !== target.sha) {
    return `${target.name} now refers to a different stash - reopen the graph`;
  }

  return null;
}

const stashPush: Action = {
  id: 'braid.stashPush',
  group: 'stash',
  tier: Tier.Safe,

  label: () => 'Stash changes…',

  // Repo-level rather than aimed at a row: what gets stashed is the working tree, not a commit.
  appliesTo: (target) => target.kind === 'repo',

  unavailable(_target, state) {
    const blocked = blockedByOperation(state);

    if (blocked !== null) {
      return blocked;
    }

    return state.files.length === 0 ? 'Nothing to stash' : null;
  },

  async run({ git, repo, state, ui }) {
    const message = await ui.input({
      title: 'Stash the working tree',
      placeholder: 'Description (optional)',
    });

    if (message === null) {
      return { message: '', ran: false };
    }

    const untracked = state.files.filter((file) => file.untracked).length;

    // Untracked files are not stashed unless asked for, and leaving them behind is the surprise
    // that makes people think stash lost their work - so ask rather than guess.
    const includeUntracked =
      untracked === 0 ||
      (await ui.confirm({
        title: `Include ${untracked} untracked ${untracked === 1 ? 'file' : 'files'}?`,
        detail:
          'Untracked files stay in the working tree unless they are stashed too. Choosing not to include them leaves them where they are.',
        confirmLabel: 'Include them',
        destructive: false,
      }));

    const args = ['stash', 'push'];

    if (includeUntracked && untracked > 0) {
      args.push('--include-untracked');
    }

    if (message.trim().length > 0) {
      args.push('-m', message.trim());
    }

    await ui.progress('Stashing', () => git.runWrite(repo.root, args));

    return { message: 'Stashed the working tree', ran: true };
  },
};

const stashApply: Action = {
  id: 'braid.stashApply',
  group: 'stash',
  tier: Tier.Safe,

  label: (target) => (target.kind === 'stash' ? `Apply ${target.name}` : 'Apply stash'),

  appliesTo: (target) => target.kind === 'stash',

  unavailable: (_target, state) => blockedByOperation(state),

  async run(context) {
    const stale = await verifyStash(context);

    if (stale !== null) {
      return { message: stale, ran: false };
    }

    const { git, repo, target, ui } = context;

    if (target.kind !== 'stash') {
      return { message: '', ran: false };
    }

    await ui.progress(`Applying ${target.name}`, () =>
      git.runWrite(repo.root, ['stash', 'apply', target.sha]),
    );

    return { message: `Applied ${target.name}, which is still in the stash list`, ran: true };
  },
};

const stashPop: Action = {
  id: 'braid.stashPop',
  group: 'stash',
  tier: Tier.Safe,

  label: (target) => (target.kind === 'stash' ? `Pop ${target.name}` : 'Pop stash'),

  appliesTo: (target) => target.kind === 'stash',

  unavailable: (_target, state) => blockedByOperation(state),

  async run(context) {
    const stale = await verifyStash(context);

    if (stale !== null) {
      return { message: stale, ran: false };
    }

    const { git, repo, target, ui } = context;

    if (target.kind !== 'stash') {
      return { message: '', ran: false };
    }

    // Popping by name rather than SHA, because `stash pop` only drops the entry it names, and the
    // SHA form leaves the list entry behind. The name was just verified to still hold this SHA.
    // git leaves the stash in place if applying it conflicts, so nothing is lost on failure.
    await ui.progress(`Popping ${target.name}`, () =>
      git.runWrite(repo.root, ['stash', 'pop', target.name]),
    );

    return { message: `Popped ${target.name}`, ran: true };
  },
};

const stashDrop: Action = {
  id: 'braid.stashDrop',
  group: 'danger',
  tier: Tier.Destructive,

  label: (target) => (target.kind === 'stash' ? `Drop ${target.name}` : 'Drop stash'),

  appliesTo: (target) => target.kind === 'stash',

  unavailable: (_target, state) => blockedByOperation(state),

  async confirmDetail({ target }) {
    if (target.kind !== 'stash') {
      return '';
    }

    // The commit outlives the entry until git garbage-collects it, which is the whole difference
    // between "gone" and "recoverable" - so hand over the number needed to get it back.
    return (
      `${target.message}\n\n` +
      'The stash entry is removed. Its commit survives until git garbage-collects it, so it can ' +
      `still be recovered with:\n\n  git stash apply ${target.sha}`
    );
  },

  async run(context) {
    const stale = await verifyStash(context);

    if (stale !== null) {
      return { message: stale, ran: false };
    }

    const { git, repo, target, ui } = context;

    if (target.kind !== 'stash') {
      return { message: '', ran: false };
    }

    await ui.progress(`Dropping ${target.name}`, () =>
      git.runWrite(repo.root, ['stash', 'drop', target.name]),
    );

    return { message: `Dropped ${target.name} (was ${target.sha.slice(0, 8)})`, ran: true };
  },
};

export const STASH_ACTIONS: readonly Action[] = [stashPush, stashApply, stashPop, stashDrop];
