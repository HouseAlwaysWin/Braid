/**
 * Turning git's stderr into something a person can act on.
 *
 * Raw git output is written for someone at a terminal who can read the next paragraph and type the
 * fix. In a UI it is a wall of text with the useful sentence buried in it, and the suggested
 * remedy - which git usually does give - lost entirely.
 *
 * This works because `gitEnv` pins `LC_ALL=C`: git's messages come back in English no matter what
 * locale the machine runs in, so matching on them is stable rather than a guess about the user's
 * system language.
 *
 * The rule for adding an entry: match on the shortest phrase git will not casually reword, and
 * always keep the original text - the mapped sentence is for the dialog, the original is for the
 * command log when the mapping turns out to be wrong.
 */

import { GitError } from './exec.ts';

/** Something Braid can offer to do about a failure, resolved by the caller. */
export const Remedy = {
  /** Stash the working tree and run the same action again. */
  StashAndRetry: 'stash-and-retry',
  /** Open VS Code's merge editor on the conflicted files. */
  ResolveConflicts: 'resolve-conflicts',
  /** Abort whatever operation is in progress. */
  AbortOperation: 'abort-operation',
  /** Show the git command log so the raw output is one click away. */
  ShowLog: 'show-log',
} as const;

export type Remedy = (typeof Remedy)[keyof typeof Remedy];

export interface MappedError {
  /** One sentence, written for a dialog. */
  readonly message: string;
  /** Paths git named, when it named any - so the dialog can list them. */
  readonly paths: string[];
  readonly remedies: Remedy[];
  /** Exactly what git said, for the log. */
  readonly raw: string;
}

interface Rule {
  readonly match: RegExp;
  readonly message: (raw: string) => string;
  readonly remedies: Remedy[];
  /** Whether the message is followed by an indented list of paths. */
  readonly listsPaths?: boolean;
}

/**
 * git prints file lists indented by a tab or spaces after the headline. Everything up to the next
 * unindented line belongs to the list.
 */
function pathsAfter(raw: string, headline: RegExp): string[] {
  const lines = raw.split('\n');
  const start = lines.findIndex((line) => headline.test(line));

  if (start < 0) {
    return [];
  }

  const paths: string[] = [];

  for (const line of lines.slice(start + 1)) {
    if (!/^[\t ]+\S/.test(line)) {
      break;
    }

    paths.push(line.trim());
  }

  return paths;
}

const RULES: Rule[] = [
  {
    match: /Your local changes to the following files would be overwritten by (\w+)/,
    message: (raw) => {
      const verb = /overwritten by (\w+)/.exec(raw)?.[1] ?? 'this';
      return `Uncommitted changes would be overwritten by the ${verb}.`;
    },
    remedies: [Remedy.StashAndRetry],
    listsPaths: true,
  },
  {
    match: /The following untracked working tree files would be overwritten/,
    message: () => 'Untracked files here would be overwritten.',
    remedies: [Remedy.StashAndRetry],
    listsPaths: true,
  },
  {
    match: /(You have unmerged paths|you have unmerged files|Automatic merge failed|CONFLICT)/,
    message: () => 'There are conflicts to resolve first.',
    remedies: [Remedy.ResolveConflicts, Remedy.AbortOperation],
  },
  {
    match: /refusing to merge unrelated histories/,
    message: () =>
      'These two histories have no common ancestor, so git will not merge them without being told to.',
    remedies: [],
  },
  {
    match: /A branch named '(.+?)' already exists/,
    message: (raw) => `A branch named ${/A branch named '(.+?)'/.exec(raw)?.[1] ?? ''} already exists.`,
    remedies: [],
  },
  {
    match: /The branch '(.+?)' is not fully merged/,
    message: (raw) =>
      `${/The branch '(.+?)'/.exec(raw)?.[1] ?? 'That branch'} has commits that are not on any other branch. Deleting it loses them.`,
    remedies: [],
  },
  {
    match: /detected dubious ownership/,
    message: () =>
      'git will not touch this repository because it is owned by another user. Add it to safe.directory to proceed.',
    remedies: [],
  },
  {
    match: /(not a valid object name|unknown revision or path not in the working tree|bad revision)/,
    message: () => 'git does not recognise that revision - it may have been deleted or rewritten.',
    remedies: [],
  },
  {
    match: /(cannot lock ref|Unable to create .*\.lock|File exists)/,
    message: () =>
      'Another git process is using this repository. Wait for it to finish and try again.',
    remedies: [],
  },
  {
    match: /(Authentication failed|could not read Username|Permission denied \(publickey\)|terminal prompts disabled)/,
    message: () =>
      'git could not authenticate with the remote. Braid uses your existing credential helper - try the same operation from the Source Control view or a terminal to sign in.',
    remedies: [],
  },
  {
    match: /(Updates were rejected|non-fast-forward)/,
    message: () =>
      'The remote has commits you do not have locally, so this push was rejected. Pull first.',
    remedies: [],
  },
  {
    match: /no upstream (branch|configured)/,
    message: () => 'This branch is not tracking anything on a remote yet.',
    remedies: [],
  },
];

/**
 * Map a failure to something worth showing. Anything unrecognised keeps git's own first line -
 * which is usually the useful one - rather than being replaced with a vaguer sentence of ours.
 */
export function mapGitError(error: unknown): MappedError {
  const raw = error instanceof GitError ? error.stderr : error instanceof Error ? error.message : String(error);
  const trimmed = raw.trim();

  for (const rule of RULES) {
    if (!rule.match.test(trimmed)) {
      continue;
    }

    return {
      message: rule.message(trimmed),
      paths: rule.listsPaths === true ? pathsAfter(trimmed, rule.match) : [],
      remedies: rule.remedies,
      raw: trimmed,
    };
  }

  const firstLine = trimmed
    .split('\n')
    .map((line) => line.replace(/^(fatal|error|warning):\s*/, '').trim())
    .find((line) => line.length > 0);

  return {
    message: firstLine ?? 'git failed without saying why.',
    paths: [],
    remedies: [Remedy.ShowLog],
    raw: trimmed,
  };
}
