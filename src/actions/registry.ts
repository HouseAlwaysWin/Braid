/**
 * What you can do to a thing in the graph.
 *
 * Every action is one entry in one of the action modules, and the context menu is rendered from
 * what this returns - so adding an action never means touching the webview. That matters more than
 * it sounds: the menu has to know whether an action is *available* right now, and availability
 * depends on repository state the webview does not have.
 *
 * The vocabulary lives in `types.ts` rather than here, so the dependency runs one way: this module
 * knows about the action modules, and they know about the types. Sharing a file made a cycle that
 * TypeScript accepted and ESM did not.
 */

import type { Action, ActionContext, MenuItem, Target } from './types.ts';
import { Tier } from './types.ts';
import type { RepoState } from '../git/repoState.ts';
import { workAtRisk } from '../git/repoState.ts';
import { BRANCH_ACTIONS } from './branches.ts';
import { COMMIT_ACTIONS } from './commit.ts';
import { MERGE_ACTIONS } from './merge.ts';
import { STASH_ACTIONS } from './stash.ts';

export type {
  Action,
  ActionContext,
  ActionResult,
  ActionUi,
  ConfirmRequest,
  InputRequest,
  MenuItem,
  Target,
} from './types.ts';
export { Tier } from './types.ts';

/** Menu order follows this list, so destructive things stay at the bottom. */
export const ACTIONS: readonly Action[] = [
  ...BRANCH_ACTIONS,
  ...COMMIT_ACTIONS,
  ...MERGE_ACTIONS,
  ...STASH_ACTIONS,
];

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
 * The fallback consequence, for actions that do not describe their own. It can only talk about
 * files, which is why anything endangering something else supplies `confirmDetail`.
 */
function defaultDetail(action: Action, context: ActionContext): string {
  const atRisk = action.tier === Tier.Destructive ? workAtRisk(context.state) : [];

  if (atRisk.length === 0) {
    return 'This moves where a ref points. The previous position stays in the reflog.';
  }

  return `These uncommitted changes will be lost permanently:\n\n${atRisk
    .map((file) => `  ${file.path}`)
    .join('\n')}`;
}

/**
 * Ask before anything that cannot be taken back, and say what would be lost rather than asking the
 * user to imagine it. "Are you sure?" with nothing behind it is not a warning, it is a shrug.
 */
export async function confirmIfNeeded(action: Action, context: ActionContext): Promise<boolean> {
  if (action.tier === Tier.Safe) {
    return true;
  }

  const detail = await (action.confirmDetail?.(context) ??
    Promise.resolve(defaultDetail(action, context)));

  return context.ui.confirm({
    title: action.label(context.target),
    detail,
    confirmLabel: action.label(context.target),
    destructive: action.tier === Tier.Destructive,
  });
}
