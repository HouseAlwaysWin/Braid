/**
 * Adding, renaming, repointing and removing remotes.
 *
 * One action rather than five. The five are each a single `git remote` subcommand, and splitting
 * them into five menu entries would put four things nobody does often into every context menu, all
 * of them needing you to have already decided which remote you meant. Picking the remote first is
 * the step they share, and it is also the step that shows where each one actually points - which is
 * the question people open this to answer far more often than they come to change anything.
 *
 * Nothing here is reached by way of the tier machinery. The entry point cannot lose anything, so it
 * is tier 1, and the one branch that can - removing - asks on its own, with the count in it.
 */

import type { Action, ActionContext, ActionResult } from './types.ts';
import { Tier } from './types.ts';
import type { Remote } from '../git/remotes.ts';
import { countTrackingRefs, nameProblem, readRemotes } from '../git/remotes.ts';

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

const ADD = 'Add a remote...';

/** `origin  https://github.com/x/y.git`, and the push URL too when it is somewhere else. */
function describe(remote: Remote): string {
  const push = remote.pushUrl === null ? '' : `  (pushes to ${remote.pushUrl})`;
  return `${remote.name}  ${remote.fetchUrl}${push}`;
}

/** Bring a new remote's branches in, so that adding one visibly does something. */
async function fetchNew(context: ActionContext, name: string): Promise<ActionResult> {
  const { git, repo, ui } = context;

  try {
    await ui.progress(
      `Fetching ${name}`,
      (signal) => git.runNetwork(repo.root, ['fetch', name, '--progress'], { signal }),
      true,
    );
  } catch {
    // The remote is added either way, and saying so matters more than the fetch succeeding: the
    // difference between "that failed" and "that failed, and it is still there" is whether the
    // user goes round and adds it a second time.
    return {
      message: `Added ${name}. Fetching it failed - it is configured, so Fetch will retry.`,
      ran: true,
    };
  }

  return { message: `Added ${name} and fetched it`, ran: true };
}

async function add(context: ActionContext, existing: readonly Remote[]): Promise<ActionResult> {
  const { git, repo, ui } = context;
  const taken = existing.map((remote) => remote.name);

  const name = await ui.input({
    title: 'Name for the new remote',
    placeholder: taken.includes('origin') ? 'upstream' : 'origin',
    validate: (value) => nameProblem(value.trim(), taken),
  });

  if (name === null) {
    return { message: '', ran: false };
  }

  const url = await ui.input({
    title: `Where does ${name.trim()} point?`,
    placeholder: 'https://github.com/owner/repo.git',
    // Anything git accepts: https, ssh, `git@host:path`, a path on this machine. Guessing at a
    // shape here would reject the local clone somebody is testing against.
    validate: (value) => (value.trim().length === 0 ? 'A remote needs a URL' : null),
  });

  if (url === null) {
    return { message: '', ran: false };
  }

  await git.runWrite(repo.root, ['remote', 'add', name.trim(), url.trim()]);

  return fetchNew(context, name.trim());
}

async function rename(
  context: ActionContext,
  remote: Remote,
  existing: readonly Remote[],
): Promise<ActionResult> {
  const { git, repo, ui } = context;
  const taken = existing.map((other) => other.name).filter((name) => name !== remote.name);

  const name = await ui.input({
    title: `Rename ${remote.name} to`,
    placeholder: remote.name,
    value: remote.name,
    validate: (value) => (value.trim() === remote.name ? null : nameProblem(value.trim(), taken)),
  });

  if (name === null || name.trim() === remote.name) {
    return { message: '', ran: false };
  }

  await git.runWrite(repo.root, ['remote', 'rename', remote.name, name.trim()]);

  // git rewrites the tracking refs and every `branch.*.remote` that named the old one, so this is
  // not only a label: branches that were tracking it still are.
  return {
    message: `Renamed ${remote.name} to ${name.trim()}, and moved everything tracking it`,
    ran: true,
  };
}

async function setUrl(context: ActionContext, remote: Remote): Promise<ActionResult> {
  const { git, repo, ui } = context;

  const url = await ui.input({
    title: `Where should ${remote.name} point?`,
    placeholder: remote.fetchUrl,
    value: remote.fetchUrl,
    validate: (value) => (value.trim().length === 0 ? 'A remote needs a URL' : null),
  });

  if (url === null || url.trim() === remote.fetchUrl) {
    return { message: '', ran: false };
  }

  await git.runWrite(repo.root, ['remote', 'set-url', remote.name, url.trim()]);

  // Deliberately not fetching. What is already under this remote came from the old URL, and whether
  // any of it still means anything is a question only the person who moved it can answer.
  return {
    message: `${remote.name} now points at ${url.trim()}. Fetch to see what is there.`,
    ran: true,
  };
}

async function remove(context: ActionContext, remote: Remote): Promise<ActionResult> {
  const { git, repo, ui } = context;
  const tracking = await countTrackingRefs(git, repo, remote.name);

  const detail =
    tracking === 0
      ? `${remote.name} has no remote-tracking branches, so this only removes the configuration.`
      : `${plural(tracking, 'remote-tracking branch')} under ${remote.name}/ will be deleted from ` +
        `this clone, and any local branch tracking one will stop tracking anything.\n\n` +
        `Nothing on the server changes. Adding ${remote.name} back and fetching restores them.`;

  const confirmed = await ui.confirm({
    title: `Remove ${remote.name}?`,
    detail,
    confirmLabel: 'Remove',
    destructive: true,
  });

  if (!confirmed) {
    return { message: '', ran: false };
  }

  await git.runWrite(repo.root, ['remote', 'remove', remote.name]);

  return {
    message:
      tracking === 0
        ? `Removed ${remote.name}`
        : `Removed ${remote.name} and ${plural(tracking, 'tracking branch')}`,
    ran: true,
  };
}

async function fetchOne(context: ActionContext, remote: Remote): Promise<ActionResult> {
  const { git, repo, ui } = context;

  await ui.progress(
    `Fetching ${remote.name}`,
    (signal) => git.runNetwork(repo.root, ['fetch', remote.name, '--prune', '--progress'], { signal }),
    true,
  );

  return { message: `Fetched ${remote.name}`, ran: true };
}

const manageRemotes: Action = {
  id: 'weft.manageRemotes',
  group: 'remote',
  // Opening a list is not an operation. Each branch below decides for itself what it owes the user,
  // and only one of them owes a confirmation.
  tier: Tier.Safe,

  label: () => 'Manage Remotes...',

  appliesTo: (target) => target.kind === 'repo',

  // Available with no remotes at all: adding the first one is when this is most needed, and every
  // other network action is greyed out saying "No remotes configured" with nowhere to go from there.
  unavailable: () => null,

  async run(context): Promise<ActionResult> {
    const { git, repo, ui } = context;
    const remotes = await readRemotes(git, repo);

    const picked = await ui.choose({
      title: remotes.length === 0 ? 'No remotes configured' : 'Remotes',
      detail:
        remotes.length === 0
          ? 'This repository has nowhere to fetch from or push to.'
          : 'Pick one to fetch, rename, repoint or remove it.',
      options: [...remotes.map(describe), ADD],
    });

    if (picked === null) {
      return { message: '', ran: false };
    }

    if (picked === ADD) {
      return add(context, remotes);
    }

    const remote = remotes.find((candidate) => describe(candidate) === picked);

    if (remote === undefined) {
      return { message: '', ran: false };
    }

    const FETCH = `Fetch ${remote.name}`;
    const URL = 'Change URL';
    const RENAME = 'Rename';
    const REMOVE = `Remove ${remote.name}`;

    const what = await ui.choose({
      title: remote.name,
      detail: remote.fetchUrl,
      options: [FETCH, URL, RENAME, REMOVE],
    });

    if (what === FETCH) {
      return fetchOne(context, remote);
    }

    if (what === URL) {
      return setUrl(context, remote);
    }

    if (what === RENAME) {
      return rename(context, remote, remotes);
    }

    if (what === REMOVE) {
      return remove(context, remote);
    }

    return { message: '', ran: false };
  },
};

export const REMOTE_ACTIONS: readonly Action[] = [manageRemotes];
