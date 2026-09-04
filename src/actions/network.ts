/**
 * Fetch, pull and push.
 *
 * These were left until last on purpose. The operations are one git command each; the work is
 * everything around them - a remote that does not answer, a branch with nothing to track, a push
 * the server refuses, two histories that have drifted apart. That long tail is why `errors.ts`
 * exists, and most of this milestone's weight landed there rather than here.
 *
 * Two boundaries are held firmly:
 *
 * **Credentials are not Braid's business.** Whatever credential helper is already configured -
 * Git Credential Manager, an ssh agent, a `.netrc` - is what authenticates. Braid never implements
 * an askpass, never stores a token, never touches OAuth. An authentication failure is a clear
 * message pointing at where the user already signs in, not the beginning of a login flow.
 *
 * **`--force` is not offered.** Only `--force-with-lease`, and only after fetching, because a lease
 * checked against a remote-tracking ref nobody has updated in a week is not a safety check - it is
 * the appearance of one.
 */

import type { Action, ActionContext, ActionResult } from './types.ts';
import { Tier, blockedByOperation } from './types.ts';
import type { Git } from '../git/exec.ts';
import type { RepoInfo } from '../git/discovery.ts';
import type { RepoState } from '../git/repoState.ts';
import { readRepoState } from '../git/repoState.ts';

/**
 * `--progress` is not cosmetic here: without a terminal git stays silent during a transfer, and
 * the idle timeout in `runNetwork` would then fire on a healthy download. Progress output is what
 * makes "said nothing for a minute" mean "hung" rather than "busy".
 */
const PROGRESS = '--progress';

/** The remote a ref name like `origin/feature/x` belongs to. Remote names cannot contain a slash. */
function remoteOf(ref: string, remotes: readonly string[]): string | null {
  const slash = ref.indexOf('/');

  if (slash < 0) {
    // `branch.<name>.remote = .` makes a local branch the upstream. Nothing to push over a network.
    return null;
  }

  const name = ref.slice(0, slash);
  return remotes.includes(name) ? name : null;
}

/** Where a push with no upstream should go: origin if it exists, otherwise the only remote. */
function defaultRemote(state: RepoState): string | null {
  if (state.upstream !== null) {
    const tracked = remoteOf(state.upstream.ref, state.remotes);

    if (tracked !== null) {
      return tracked;
    }
  }

  return state.remotes.includes('origin') ? 'origin' : (state.remotes[0] ?? null);
}

function noRemotes(state: RepoState): string | null {
  return state.remotes.length === 0 ? 'No remotes configured' : null;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** How far `to` is ahead of `from`, or 0 if either revision is unknown. */
async function distance(git: Git, repo: RepoInfo, from: string, to: string): Promise<number> {
  const out = await git.runRead(repo.root, ['rev-list', '--count', `${from}..${to}`]).catch(() => '0');
  return Number(out.trim()) || 0;
}

async function shaOf(git: Git, repo: RepoInfo, revision: string): Promise<string | null> {
  const out = await git.runRead(repo.root, ['rev-parse', '--verify', '-q', revision]).catch(() => '');
  const sha = out.trim();
  return sha.length > 0 ? sha : null;
}

const fetch: Action = {
  id: 'braid.fetch',
  group: 'remote',
  // Fetch writes only remote-tracking refs. It cannot touch the working tree, a local branch, or
  // HEAD, which is also why it is the one action not blocked by an operation in progress: knowing
  // what the remote has is useful *while* you are working out how to finish a rebase.
  tier: Tier.Safe,

  label: () => 'Fetch from all remotes',

  appliesTo: (target) => target.kind === 'repo',

  unavailable: (_target, state) => noRemotes(state),

  async run({ git, repo, state, ui }): Promise<ActionResult> {
    const tracked = state.upstream?.ref ?? null;
    const before = tracked === null ? null : await shaOf(git, repo, tracked);

    await ui.progress(
      'Fetching',
      (signal) => git.runNetwork(repo.root, ['fetch', '--all', '--prune', PROGRESS], { signal }),
      true,
    );

    // --prune deletes remote-tracking refs for branches that are gone from the remote. Worth
    // saying, because a branch vanishing from the graph otherwise looks like Braid lost it.
    if (tracked === null) {
      return { message: 'Fetched', ran: true };
    }

    const after = await shaOf(git, repo, tracked);

    if (after === null) {
      return { message: `Fetched. ${tracked} is gone from the remote.`, ran: true };
    }

    if (after === before) {
      return { message: `Fetched. ${tracked} has nothing new.`, ran: true };
    }

    const gained = before === null ? 0 : await distance(git, repo, before, after);
    return {
      message: gained === 0 ? 'Fetched' : `Fetched ${plural(gained, 'commit')} onto ${tracked}`,
      ran: true,
    };
  },
};

/**
 * Pull, as fetch and then a decision, rather than as `git pull`.
 *
 * `git pull` on histories that have both moved refuses outright since git 2.34 - "you need to
 * specify how to reconcile divergent branches" - and it refuses for a good reason: merge and
 * rebase produce genuinely different history and git will not choose for you. Passing `--no-rebase`
 * to silence it would be making exactly the choice git declined to make.
 *
 * Doing the fetch separately means the question can be asked *before* anything happens, with the
 * real numbers in it, and that the two easy cases - nothing to do, and a plain fast-forward - never
 * ask anything at all.
 */
const pull: Action = {
  id: 'braid.pull',
  group: 'remote',
  tier: Tier.Safe,

  label: () => 'Pull',

  appliesTo: (target) => target.kind === 'repo',

  unavailable(_target, state) {
    const missing = noRemotes(state) ?? blockedByOperation(state);

    if (missing !== null) {
      return missing;
    }

    if (state.branch === null) {
      return 'Not on a branch';
    }

    if (state.upstream === null) {
      return 'This branch is not tracking a remote';
    }

    return null;
  },

  async run(context): Promise<ActionResult> {
    const { git, repo, state, ui } = context;
    const upstream = state.upstream;
    const remote = upstream === null ? null : remoteOf(upstream.ref, state.remotes);

    if (upstream === null || remote === null) {
      return { message: '', ran: false };
    }

    // The whole remote, not just this branch. `git pull` fetches only what it is about to merge,
    // which leaves the rest of the graph stale on the same connection that could have refreshed it.
    await ui.progress(
      `Fetching ${remote}`,
      (signal) => git.runNetwork(repo.root, ['fetch', remote, '--prune', PROGRESS], { signal }),
      true,
    );

    // The counts from before the fetch are stale by definition, so ask again.
    const fresh = await readRepoState(git, repo);
    const now = fresh.upstream;

    if (now === null || now.gone) {
      return { message: `${upstream.ref} no longer exists on ${remote}.`, ran: true };
    }

    if (now.behind === 0) {
      return { message: `Already up to date with ${now.ref}`, ran: true };
    }

    if (now.ahead === 0) {
      await ui.progress(`Fast-forwarding to ${now.ref}`, () =>
        git.runWrite(repo.root, ['merge', '--ff-only', now.ref]),
      );

      return { message: `Fast-forwarded ${plural(now.behind, 'commit')} from ${now.ref}`, ran: true };
    }

    const branch = fresh.branch ?? 'HEAD';
    const choice = await ui.choose({
      title: `${branch} and ${now.ref} have both moved`,
      detail:
        `${branch} has ${plural(now.ahead, 'commit')} that ${now.ref} does not, and ${now.ref} has ` +
        `${plural(now.behind, 'commit')} that ${branch} does not.\n\n` +
        `Merge keeps both histories and adds a merge commit.\n` +
        `Rebase replays your ${plural(now.ahead, 'commit')} on top of ${now.ref}; they get new ` +
        `hashes, and anyone who already has the old ones will have to reconcile.`,
      options: ['Merge', 'Rebase'],
    });

    if (choice === null) {
      return { message: '', ran: false };
    }

    if (choice === 'Rebase') {
      await ui.progress(`Rebasing onto ${now.ref}`, () =>
        git.runWrite(repo.root, ['rebase', now.ref]),
      );

      return { message: `Rebased ${plural(now.ahead, 'commit')} onto ${now.ref}`, ran: true };
    }

    await ui.progress(`Merging ${now.ref}`, () =>
      git.runWrite(repo.root, ['merge', '--no-edit', now.ref]),
    );

    return { message: `Merged ${plural(now.behind, 'commit')} from ${now.ref}`, ran: true };
  },
};

/** Which remote to publish a branch to, asking only when the answer is not obvious. */
async function chooseRemote(context: ActionContext, branch: string): Promise<string | null> {
  const { state, ui } = context;

  if (state.remotes.length <= 1) {
    return defaultRemote(state);
  }

  return ui.choose({
    title: `Push ${branch} to which remote?`,
    detail: `${branch} is not tracking anything yet, so this also sets its upstream.`,
    options: state.remotes,
  });
}

const push: Action = {
  id: 'braid.push',
  group: 'remote',
  // Pushing adds to the remote or git refuses. The refusal is the safety, and it is why this is
  // tier 1 while the forced version is tier 3 - they are not one action with a flag.
  tier: Tier.Safe,

  label: () => 'Push',

  appliesTo: (target) => target.kind === 'repo',

  unavailable(_target, state) {
    // Pushing mid-merge would publish the branch as it stood before the merge, which is legal and
    // baffling. Fetch is the one network action that stays available, because it cannot mislead.
    const missing = noRemotes(state) ?? blockedByOperation(state);

    if (missing !== null) {
      return missing;
    }

    if (state.branch === null) {
      return 'Not on a branch';
    }

    return null;
  },

  async run(context): Promise<ActionResult> {
    const { git, repo, state, ui } = context;
    const branch = state.branch;

    if (branch === null) {
      return { message: '', ran: false };
    }

    if (state.upstream === null) {
      const remote = await chooseRemote(context, branch);

      if (remote === null) {
        return { message: '', ran: false };
      }

      await ui.progress(
        `Pushing ${branch} to ${remote}`,
        (signal) =>
          git.runNetwork(repo.root, ['push', '--set-upstream', remote, branch, PROGRESS], { signal }),
        true,
      );

      return { message: `Pushed ${branch} and set it to track ${remote}/${branch}`, ran: true };
    }

    const upstream = state.upstream;

    if (upstream.ahead === 0 && !upstream.gone) {
      return { message: `${upstream.ref} already has everything on ${branch}`, ran: true };
    }

    // No refspec: with an upstream configured this is what the user's own `push.default` says to
    // do. Spelling out `<remote> <branch>` here would push to a same-named branch instead, which is
    // a different destination whenever the upstream was set to something else.
    await ui.progress(
      `Pushing ${branch}`,
      (signal) => git.runNetwork(repo.root, ['push', PROGRESS], { signal }),
      true,
    );

    return { message: `Pushed ${plural(upstream.ahead, 'commit')} to ${upstream.ref}`, ran: true };
  },
};

const pushForce: Action = {
  id: 'braid.pushForce',
  // 'remote' rather than 'danger': the group decides which menus this can appear in, and the tier
  // is what makes it render as destructive. Grouping it with Abort put it in the operation banner.
  group: 'remote',
  // Tier 3, and the only action here that earns it: this is the one way Braid can destroy work
  // that exists nowhere on this machine. The reflog does not help - the commits being dropped are
  // on someone else's clone.
  tier: Tier.Destructive,

  label: () => 'Force Push (with lease)',

  appliesTo: (target) => target.kind === 'repo',

  unavailable(_target, state) {
    const missing = noRemotes(state) ?? blockedByOperation(state);

    if (missing !== null) {
      return missing;
    }

    if (state.branch === null) {
      return 'Not on a branch';
    }

    if (state.upstream === null) {
      return 'Nothing to overwrite - this branch has no upstream';
    }

    return null;
  },

  /**
   * This fetches before it describes, which is unusual for a describe function and deliberate.
   *
   * `--force-with-lease` compares against the remote-tracking ref, so both the lease and any count
   * quoted here are only as current as the last fetch. Describing a stale picture as if it were the
   * remote would be worse than not describing it at all.
   */
  async confirmDetail(context): Promise<string> {
    const { git, repo, state, ui } = context;
    const remote = state.upstream === null ? null : remoteOf(state.upstream.ref, state.remotes);

    if (state.upstream === null || remote === null) {
      return '';
    }

    const checked = await ui
      .progress(
        `Checking ${remote}`,
        (signal) => git.runNetwork(repo.root, ['fetch', remote, PROGRESS], { signal }),
        true,
      )
      .then(() => true)
      .catch(() => false);

    // Quoting a count from a remote-tracking ref that could not be refreshed would be describing
    // last week's remote as if it were this one. Say that instead of inventing a number.
    if (!checked) {
      return (
        `Braid could not reach ${remote} just now, so it cannot say what is there.\n\n` +
        'The lease will be checked against whatever was last fetched, and git will refuse the push ' +
        'if that turns out to be out of date - but nothing here can tell you what you would be ' +
        'replacing.'
      );
    }

    const dropped = await distance(git, repo, 'HEAD', state.upstream.ref);
    const added = await distance(git, repo, state.upstream.ref, 'HEAD');

    if (dropped === 0) {
      return (
        `${state.upstream.ref} has nothing that this branch does not, so nothing is overwritten. ` +
        `${plural(added, 'commit')} will be pushed.`
      );
    }

    return (
      `${plural(dropped, 'commit')} on ${state.upstream.ref} will stop being reachable there. ` +
      'They are not in your reflog - they exist on whoever pushed them.\n\n' +
      'The lease means git will refuse if the remote has moved since the fetch just done, so a ' +
      'push someone else made in the last few seconds cannot be lost silently.'
    );
  },

  async run({ git, repo, state, ui }): Promise<ActionResult> {
    const branch = state.branch;

    if (branch === null || state.upstream === null) {
      return { message: '', ran: false };
    }

    const overwritten = await shaOf(git, repo, state.upstream.ref);

    // --force-with-lease, never --force. The difference is whether a push someone else made while
    // this dialog was open is silently discarded.
    await ui.progress(
      `Force pushing ${branch}`,
      (signal) => git.runNetwork(repo.root, ['push', '--force-with-lease', PROGRESS], { signal }),
      true,
    );

    const was = overwritten === null ? '' : `  (${state.upstream.ref} was ${overwritten.slice(0, 8)})`;
    return { message: `Force pushed ${branch} to ${state.upstream.ref}${was}`, ran: true };
  },
};

export const NETWORK_ACTIONS: readonly Action[] = [fetch, pull, push, pushForce];
