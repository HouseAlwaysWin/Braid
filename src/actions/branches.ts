/**
 * Branch and tag actions.
 *
 * The interesting decisions are all about deletion. `git branch -d` refuses to remove a branch
 * whose commits are nowhere else, and `-D` overrides that refusal - so the two are not one action
 * with a flag, they are a tier-2 action and a tier-3 action, and the tier-3 one has to say how many
 * commits it is about to strand.
 */

import type { Action } from './types.ts';
import { Tier, blockedByOperation, revisionOf, shortLabel } from './types.ts';
import type { Git } from '../git/exec.ts';
import type { RepoInfo } from '../git/discovery.ts';

/** git's own rules, applied before the user gets as far as an error. */
function validateRefName(name: string, taken: readonly string[]): string | null {
  const trimmed = name.trim();

  if (trimmed.length === 0) {
    return 'A name is required';
  }

  if (taken.includes(trimmed)) {
    return `${trimmed} already exists`;
  }

  // The subset of git check-ref-format worth catching before spawning a process.
  if (/[ ~^:?*[\\]/.test(trimmed) || trimmed.includes('..') || trimmed.includes('@{')) {
    return 'Not allowed: spaces or any of ~ ^ : ? * [ \\ .. @{';
  }

  if (trimmed.startsWith('-') || trimmed.startsWith('/') || trimmed.endsWith('/') || trimmed.endsWith('.lock')) {
    return 'Cannot start with -, or start/end with /, or end with .lock';
  }

  // Refs are paths on disk, so a name cannot be both a ref and a folder of refs. git's own words
  // for this are 'cannot lock ref ... exists; cannot create', which explains nothing.
  const clash = taken.find(
    (existing) => existing.startsWith(`${trimmed}/`) || trimmed.startsWith(`${existing}/`),
  );

  if (clash !== undefined) {
    return `Conflicts with ${clash}: a name cannot also be a folder of other names`;
  }

  return null;
}

const checkoutBranch: Action = {
  id: 'weft.checkoutBranch',
  group: 'branch',
  tier: Tier.Safe,

  label: (target) => (target.kind === 'ref' ? `Checkout ${target.label}` : 'Checkout'),

  appliesTo: (target) => target.kind === 'ref' && target.refKind === 'local',

  unavailable(target, state) {
    const blocked = blockedByOperation(state);

    if (blocked !== null) {
      return blocked;
    }

    if (target.kind === 'ref' && state.branch === target.label) {
      return 'Already checked out';
    }

    return null;
  },

  async run({ git, repo, target, ui }) {
    if (target.kind !== 'ref') {
      return { message: '', ran: false };
    }

    // No --force, ever. git refuses a checkout that would overwrite uncommitted changes, and that
    // refusal is the safety here - the error map turns it into an offer to stash and retry.
    await ui.progress(`Checking out ${target.label}`, () =>
      git.runWrite(repo.root, ['checkout', target.label]),
    );

    return { message: `Checked out ${target.label}`, ran: true };
  },
};

const checkoutRemoteBranch: Action = {
  id: 'weft.checkoutRemoteBranch',
  group: 'branch',
  tier: Tier.Safe,

  label: (target) => (target.kind === 'ref' ? `Checkout ${localNameOf(target.label)}` : 'Checkout'),

  appliesTo: (target) => target.kind === 'ref' && target.refKind === 'remote',

  unavailable(target, state) {
    const blocked = blockedByOperation(state);

    if (blocked !== null) {
      return blocked;
    }

    if (target.kind !== 'ref') {
      return 'Not a branch';
    }

    // With a local branch of that name already present, "checkout origin/x" is ambiguous: the user
    // means the local one, and that is a different action.
    if (state.branches.includes(localNameOf(target.label))) {
      return 'Local branch already exists';
    }

    return null;
  },

  async run({ git, repo, target, ui }) {
    if (target.kind !== 'ref') {
      return { message: '', ran: false };
    }

    const local = localNameOf(target.label);

    await ui.progress(`Checking out ${local}`, () =>
      git.runWrite(repo.root, ['checkout', '--track', target.refName]),
    );

    return { message: `Checked out ${local}, tracking ${target.label}`, ran: true };
  },
};

/** `origin/feature/x` -> `feature/x`: everything after the remote name. */
function localNameOf(remoteLabel: string): string {
  const slash = remoteLabel.indexOf('/');
  return slash < 0 ? remoteLabel : remoteLabel.slice(slash + 1);
}

const checkoutCommit: Action = {
  id: 'weft.checkoutCommit',
  group: 'branch',
  tier: Tier.Safe,

  label: (target) => `Checkout ${shortLabel(target)} (detached)`,

  appliesTo: (target) => target.kind === 'commit' || (target.kind === 'ref' && target.refKind === 'tag'),

  unavailable: (_target, state) => blockedByOperation(state),

  async run({ git, repo, state, target, ui }) {
    const revision = revisionOf(target);
    const from = state.branch;

    await ui.progress(`Checking out ${shortLabel(target)}`, () =>
      git.runWrite(repo.root, ['checkout', '--detach', revision]),
    );

    // Detached HEAD surprises people, so the message says both what happened and the way back.
    const back = from === null ? '' : `  Return with: git checkout ${from}`;
    return { message: `HEAD is detached at ${shortLabel(target)}.${back}`, ran: true };
  },
};

const createBranch: Action = {
  id: 'weft.createBranch',
  group: 'create',
  tier: Tier.Safe,

  label: (target) => `Create branch from ${shortLabel(target)}…`,

  appliesTo: () => true,

  unavailable: (_target, state) => blockedByOperation(state),

  async run({ git, repo, state, target, ui }) {
    const name = await ui.input({
      title: `Create a branch at ${shortLabel(target)}`,
      placeholder: 'Branch name',
      validate: (value) => validateRefName(value, state.branches),
    });

    if (name === null) {
      return { message: '', ran: false };
    }

    const branch = name.trim();

    // Created and checked out in one step: creating a branch you then have to switch to separately
    // is a chore nobody wants.
    await ui.progress(`Creating ${branch}`, () =>
      git.runWrite(repo.root, ['checkout', '-b', branch, revisionOf(target)]),
    );

    return { message: `Created and checked out ${branch}`, ran: true };
  },
};

const renameBranch: Action = {
  id: 'weft.renameBranch',
  group: 'branch',
  tier: Tier.Safe,

  label: (target) => (target.kind === 'ref' ? `Rename ${target.label}…` : 'Rename…'),

  appliesTo: (target) => target.kind === 'ref' && target.refKind === 'local',

  unavailable: (_target, state) => blockedByOperation(state),

  async run({ git, repo, state, target, ui }) {
    if (target.kind !== 'ref') {
      return { message: '', ran: false };
    }

    const name = await ui.input({
      title: `Rename ${target.label}`,
      placeholder: 'New name',
      value: target.label,
      validate: (value) =>
        value.trim() === target.label ? null : validateRefName(value, state.branches),
    });

    if (name === null || name.trim() === target.label) {
      return { message: '', ran: false };
    }

    const renamed = name.trim();

    await ui.progress(`Renaming to ${renamed}`, () =>
      git.runWrite(repo.root, ['branch', '-m', target.label, renamed]),
    );

    return { message: `Renamed ${target.label} to ${renamed}`, ran: true };
  },
};

/** How many commits live only on this branch - the ones a forced delete would strand. */
async function orphanCount(git: Git, repo: RepoInfo, branch: string): Promise<number> {
  try {
    const out = await git.runRead(repo.root, [
      'rev-list',
      '--count',
      branch,
      '--not',
      // Two traps here, both found by testing rather than reasoning. --exclude scopes the
      // ref-listing option that *follows* it, so it has to precede --branches. And paired with
      // --branches the pattern matches the name after refs/heads/ - passing the full ref name
      // matches nothing, the branch stays inside its own exclusion set, and every branch then
      // looks fully merged.
      `--exclude=${branch}`,
      '--branches',
      '--tags',
      '--remotes',
    ]);

    return Number(out.trim()) || 0;
  } catch {
    return 0;
  }
}

const deleteBranch: Action = {
  id: 'weft.deleteBranch',
  group: 'danger',
  tier: Tier.Confirm,

  label: (target) => (target.kind === 'ref' ? `Delete ${target.label}` : 'Delete branch'),

  appliesTo: (target) => target.kind === 'ref' && target.refKind === 'local',

  unavailable(target, state) {
    const blocked = blockedByOperation(state);

    if (blocked !== null) {
      return blocked;
    }

    // git will not delete the branch you are standing on, and neither should the menu offer to.
    if (target.kind === 'ref' && state.branch === target.label) {
      return 'Currently checked out';
    }

    return null;
  },

  async confirmDetail(context) {
    if (context.target.kind !== 'ref') {
      return '';
    }

    const orphans = await orphanCount(context.git, context.repo, context.target.label);

    if (orphans === 0) {
      return 'Its commits are reachable from somewhere else, so nothing is lost.';
    }

    return (
      `${orphans} ${orphans === 1 ? 'commit is' : 'commits are'} on this branch and nowhere else. ` +
      'Deleting it makes them unreachable - recoverable from the reflog for a while, then garbage collected.'
    );
  },

  async run({ git, repo, target, ui }) {
    if (target.kind !== 'ref') {
      return { message: '', ran: false };
    }

    const orphans = await orphanCount(git, repo, target.label);

    // -d refuses to delete unmerged work; -D overrides that refusal. Reaching for -D is only
    // acceptable because confirmDetail has already said, with a number, what it overrides.
    const flag = orphans > 0 ? '-D' : '-d';
    const sha = (await git.runRead(repo.root, ['rev-parse', target.refName])).trim();

    await ui.progress(`Deleting ${target.label}`, () =>
      git.runWrite(repo.root, ['branch', flag, target.label]),
    );

    return { message: `Deleted ${target.label} (was ${sha.slice(0, 8)})`, ran: true };
  },
};

const createTag: Action = {
  id: 'weft.createTag',
  group: 'create',
  tier: Tier.Safe,

  label: (target) => `Create tag at ${shortLabel(target)}…`,

  appliesTo: (target) => target.kind === 'commit' || (target.kind === 'ref' && target.refKind !== 'tag'),

  unavailable: () => null,

  async run({ git, repo, state, target, ui }) {
    const name = await ui.input({
      title: `Create a tag at ${shortLabel(target)}`,
      placeholder: 'Tag name',
      validate: (value) => validateRefName(value, state.tags),
    });

    if (name === null) {
      return { message: '', ran: false };
    }

    const tag = name.trim();
    const message = await ui.input({
      title: `Message for ${tag}`,
      placeholder: 'Leave empty for a lightweight tag',
    });

    // An empty message means a lightweight tag; anything else is annotated. Dismissing the prompt
    // entirely is a cancel, not an empty message.
    if (message === null) {
      return { message: '', ran: false };
    }

    const args =
      message.trim().length === 0
        ? ['tag', tag, revisionOf(target)]
        : ['tag', '-a', tag, '-m', message.trim(), revisionOf(target)];

    await ui.progress(`Creating tag ${tag}`, () => git.runWrite(repo.root, args));

    return { message: `Created tag ${tag}`, ran: true };
  },
};

const deleteTag: Action = {
  id: 'weft.deleteTag',
  group: 'danger',
  tier: Tier.Confirm,

  label: (target) => (target.kind === 'ref' ? `Delete tag ${target.label}` : 'Delete tag'),

  appliesTo: (target) => target.kind === 'ref' && target.refKind === 'tag',

  unavailable: () => null,

  async confirmDetail({ target }) {
    return target.kind === 'ref'
      ? `The tag is removed locally only. If it has been pushed, it stays on the remote until deleted there too.`
      : '';
  },

  async run({ git, repo, target, ui }) {
    if (target.kind !== 'ref') {
      return { message: '', ran: false };
    }

    const sha = (await git.runRead(repo.root, ['rev-parse', target.refName])).trim();

    await ui.progress(`Deleting tag ${target.label}`, () =>
      git.runWrite(repo.root, ['tag', '-d', target.label]),
    );

    return { message: `Deleted tag ${target.label} (was ${sha.slice(0, 8)})`, ran: true };
  },
};

export const BRANCH_ACTIONS: readonly Action[] = [
  checkoutBranch,
  checkoutRemoteBranch,
  checkoutCommit,
  createBranch,
  renameBranch,
  createTag,
  deleteBranch,
  deleteTag,
];
