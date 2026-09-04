/**
 * What you can do to a thing in the graph.
 *
 * Every action is one entry here, and the context menu is rendered from what this returns - so
 * adding an action never means touching the webview. That matters more than it sounds: the menu
 * has to know whether an action is *available* right now, and availability depends on repository
 * state the webview does not have.
 *
 * This file deliberately does not import `vscode`. Dialogs and progress arrive through `ActionUi`,
 * which means every action can be driven from a test against a real repository with no editor in
 * the room.
 */

import type { Git } from '../git/exec.ts';
import type { RepoInfo } from '../git/discovery.ts';
import type { RepoState } from '../git/repoState.ts';
import { describeOperation, workAtRisk } from '../git/repoState.ts';

/**
 * How much trouble an action can cause, which decides how much ceremony it gets.
 *
 * The split is by what git can undo, not by how scary the command sounds:
 * 1 - reversible, or git refuses when it would not be. No confirmation.
 * 2 - changes committed history but leaves it in the reflog. Confirm.
 * 3 - can destroy uncommitted work, which nothing recovers. Confirm, and name the files.
 */
export const Tier = { Safe: 1, Confirm: 2, Destructive: 3 } as const;
export type Tier = (typeof Tier)[keyof typeof Tier];

export type Target =
  | { readonly kind: 'commit'; readonly sha: string; readonly subject: string }
  | {
      readonly kind: 'ref';
      readonly refName: string;
      readonly label: string;
      readonly refKind: 'local' | 'remote' | 'tag';
    };

export interface ConfirmRequest {
  readonly title: string;
  /** The consequence, spelled out. Shown as the dialog's body. */
  readonly detail: string;
  readonly confirmLabel: string;
  readonly destructive: boolean;
}

/** Everything an action needs from the outside world, so the registry itself stays testable. */
export interface ActionUi {
  confirm(request: ConfirmRequest): Promise<boolean>;
  progress<T>(title: string, work: () => Promise<T>): Promise<T>;
  notify(message: string): void;
}

export interface ActionContext {
  readonly git: Git;
  readonly repo: RepoInfo;
  /** Read fresh under the lock, immediately before the action runs. */
  readonly state: RepoState;
  readonly target: Target;
  readonly ui: ActionUi;
}

export interface ActionResult {
  /** What to tell the user afterwards, including how to get back. */
  readonly message: string;
  /** False when the user backed out of a confirmation - not an error, just nothing happened. */
  readonly ran: boolean;
}

export interface Action {
  readonly id: string;
  readonly group: string;
  readonly tier: Tier;
  label(target: Target): string;
  appliesTo(target: Target): boolean;
  /** null when available; otherwise the reason it is greyed out, shown in the menu. */
  unavailable(target: Target, state: RepoState): string | null;
  run(context: ActionContext): Promise<ActionResult>;
}

/**
 * Nothing may run while git is halfway through something else. Checked once, here, rather than
 * remembered separately by every action.
 */
function blockedByOperation(state: RepoState): string | null {
  const operation = describeOperation(state.operation);
  return operation === null ? null : `Finish ${operation} first`;
}

const checkoutBranch: Action = {
  id: 'braid.checkoutBranch',
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

  async run({ git, repo, target, ui }): Promise<ActionResult> {
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

export const ACTIONS: readonly Action[] = [checkoutBranch];

/** One menu entry as the webview needs it. */
export interface MenuItem {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly destructive: boolean;
  /** null when clickable; otherwise why not. */
  readonly disabledReason: string | null;
}

export function buildMenu(target: Target, state: RepoState): MenuItem[] {
  return ACTIONS.filter((action) => action.appliesTo(target)).map((action) => ({
    id: action.id,
    label: action.label(target),
    group: action.group,
    destructive: action.tier === Tier.Destructive,
    disabledReason: action.unavailable(target, state),
  }));
}

export function findAction(id: string): Action | undefined {
  return ACTIONS.find((action) => action.id === id);
}

/**
 * Ask before anything that cannot be taken back, and say what would be lost rather than asking the
 * user to imagine it. A tier-3 action lists the files at risk by name: "are you sure?" with nothing
 * behind it is not a warning, it is a shrug.
 */
export async function confirmIfNeeded(action: Action, context: ActionContext): Promise<boolean> {
  if (action.tier === Tier.Safe) {
    return true;
  }

  const atRisk = action.tier === Tier.Destructive ? workAtRisk(context.state) : [];

  const detail =
    atRisk.length === 0
      ? 'This rewrites where the branch points. The previous position stays in the reflog.'
      : `These uncommitted changes will be lost permanently:\n\n${atRisk
          .map((file) => `  ${file.path}`)
          .join('\n')}`;

  return context.ui.confirm({
    title: action.label(context.target),
    detail,
    confirmLabel: action.label(context.target),
    destructive: action.tier === Tier.Destructive,
  });
}
