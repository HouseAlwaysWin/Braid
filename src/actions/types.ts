/**
 * The vocabulary actions are written in.
 *
 * Separate from `registry.ts` so the dependency runs one way: the registry knows about the action
 * modules, and the action modules know about these types. When they shared a file, an action module
 * importing `Tier` from the registry - which imports the action module - produced a cycle that
 * TypeScript is happy with and ESM is not: `Tier` was still in its temporal dead zone when the
 * action module ran.
 *
 * Nothing here imports `vscode`, which is what lets every action be driven from a test against a
 * real repository with no editor in the room.
 */

import type { Git } from '../git/exec.ts';
import type { RepoInfo } from '../git/discovery.ts';
import type { RepoState } from '../git/repoState.ts';
import { describeOperation } from '../git/repoState.ts';

/**
 * How much trouble an action can cause, which decides how much ceremony it gets.
 *
 * The split is by what git can undo, not by how alarming the command sounds. The line between 1
 * and 2 is whether commits stop being reachable: cherry-pick, revert and merge all move a branch,
 * but only forwards, so nothing goes missing.
 *
 * 1 - adds to history, or git refuses when it would lose something. No confirmation.
 * 2 - makes commits unreachable, though the reflog still holds them. Confirm.
 * 3 - can destroy uncommitted work, which nothing recovers. Confirm, and name what is lost.
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
    }
  | {
      readonly kind: 'stash';
      /** `stash@{0}` - a position, which is why actions re-verify it against the SHA. */
      readonly name: string;
      readonly sha: string;
      readonly message: string;
    }
  /** The repository itself, for actions with nothing in the graph to aim at. */
  | { readonly kind: 'repo' };

export interface ConfirmRequest {
  readonly title: string;
  /** The consequence, spelled out. Shown as the dialog's body. */
  readonly detail: string;
  readonly confirmLabel: string;
  readonly destructive: boolean;
}

export interface InputRequest {
  readonly title: string;
  readonly placeholder: string;
  readonly value?: string;
  /** Return a message to reject the value, or null to accept it. */
  validate?(value: string): string | null;
}

/** Everything an action needs from the outside world. */
export interface ActionUi {
  confirm(request: ConfirmRequest): Promise<boolean>;
  /** null when the user dismissed the prompt. An empty string is a deliberate empty answer. */
  input(request: InputRequest): Promise<string | null>;
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
  /** False when the user backed out - not an error, just nothing happened. */
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
  /**
   * What the confirmation should say this will cost.
   *
   * Actions differ in what they endanger: a hard reset threatens uncommitted files, deleting an
   * unmerged branch threatens commits. The generic fallback can only talk about files, so anything
   * risking something else has to say so itself.
   */
  confirmDetail?(context: ActionContext): Promise<string>;
  run(context: ActionContext): Promise<ActionResult>;
}

/** One menu entry as the webview needs it. */
export interface MenuItem {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly destructive: boolean;
  /** null when clickable; otherwise why not. */
  readonly disabledReason: string | null;
}

/**
 * Nothing may run while git is halfway through something else. Written once here rather than
 * remembered separately by every action.
 */
export function blockedByOperation(state: RepoState): string | null {
  const operation = describeOperation(state.operation);
  return operation === null ? null : `Finish ${operation} first`;
}

/** What a target points at, in a form git accepts as a revision. */
export function revisionOf(target: Target): string {
  switch (target.kind) {
    case 'commit':
      return target.sha;
    case 'ref':
      return target.refName;
    case 'stash':
      // By SHA, never by position: stash@{0} means something different after a drop.
      return target.sha;
    default:
      return 'HEAD';
  }
}

/** How a target reads in a menu label or a message. */
export function shortLabel(target: Target): string {
  switch (target.kind) {
    case 'commit':
      return target.sha.slice(0, 8);
    case 'ref':
      return target.label;
    case 'stash':
      return target.name;
    default:
      return 'the repository';
  }
}
