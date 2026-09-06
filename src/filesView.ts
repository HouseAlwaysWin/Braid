/**
 * The Commit Files section: what the commit selected in the graph changed.
 *
 * This used to be the bottom half of the graph's details pane, drawn in the webview. It moved here
 * for two reasons, and neither is tidiness:
 *
 * - A tree view *is* the thing that list was imitating - folding directories, a status glyph in the
 *   icon slot, one click to open. All of it came for free the moment it stopped being a div.
 * - The details pane is wide and short; a file list is narrow and tall. Ten files in a 260px strip
 *   under a 20,000-row history is the wrong shape for both of them.
 *
 * The pane keeps what it is good at: the commit's identity and its message.
 */

import * as vscode from 'vscode';

import type { CommitDetails, Comparison, FileChange } from './git/details.ts';
import type { FileStatus } from './git/repoState.ts';
import { pathAtUri, revisionUri } from './contentProvider.ts';

/** git's letter spelled out, for the tooltip. The words the raw record already means. */
const STATUS_LABEL: Record<string, string> = {
  '?': 'untracked',
  A: 'added',
  C: 'copied',
  D: 'deleted',
  M: 'modified',
  R: 'renamed',
  T: 'type changed',
  U: 'unmerged',
  X: 'unknown',
};

/**
 * The status goes in the icon slot rather than into the text, in the colour VS Code's own git views
 * use for it - so a glance down the list reads as shape and colour before it reads as words.
 */
const STATUS_ICON: Record<string, { readonly icon: string; readonly color: string }> = {
  A: { icon: 'diff-added', color: 'gitDecoration.addedResourceForeground' },
  C: { icon: 'diff-added', color: 'gitDecoration.addedResourceForeground' },
  D: { icon: 'diff-removed', color: 'gitDecoration.deletedResourceForeground' },
  M: { icon: 'diff-modified', color: 'gitDecoration.modifiedResourceForeground' },
  R: { icon: 'diff-renamed', color: 'gitDecoration.renamedResourceForeground' },
  T: { icon: 'diff-modified', color: 'gitDecoration.modifiedResourceForeground' },
  U: { icon: 'diff-ignored', color: 'gitDecoration.conflictingResourceForeground' },
  X: { icon: 'diff-ignored', color: 'gitDecoration.ignoredResourceForeground' },
  // Not a diff status: `git status` spells an untracked file `??`, and it earns its own colour.
  '?': { icon: 'diff-added', color: 'gitDecoration.untrackedResourceForeground' },
};

const TREE_KEY = 'weft.filesAsTree';

interface Folder {
  readonly kind: 'folder';
  /** Display name. A compacted chain keeps its slashes, e.g. `GitFlick/ViewModels`. */
  readonly name: string;
  readonly path: string;
  readonly dirs: Map<string, Folder>;
  readonly files: Entry[];
}

interface Entry {
  readonly kind: 'file';
  readonly file: FileChange;
}

type Node = Folder | Entry;

function newFolder(name: string, path: string): Folder {
  return { kind: 'folder', name, path, dirs: new Map(), files: [] };
}

/**
 * Fold a flat path list into directories, then collapse any chain of folders that holds nothing but
 * one more folder - `GitFlick/ViewModels/x.cs` is three rows of almost no information otherwise.
 * VS Code's own explorer does the same thing and calls it compact folders.
 */
function buildTree(files: readonly FileChange[]): Folder {
  const root = newFolder('', '');

  for (const file of files) {
    const parts = file.path.split('/');
    parts.pop();

    let node = root;
    let acc = '';

    for (const part of parts) {
      acc = acc.length === 0 ? part : `${acc}/${part}`;
      let next = node.dirs.get(part);

      if (next === undefined) {
        next = newFolder(part, acc);
        node.dirs.set(part, next);
      }

      node = next;
    }

    node.files.push({ kind: 'file', file });
  }

  compact(root);
  return root;
}

function compact(node: Folder): void {
  for (const [key, child] of [...node.dirs]) {
    let merged = child;

    while (merged.dirs.size === 1 && merged.files.length === 0) {
      const only = [...merged.dirs.values()][0] as Folder;
      merged = {
        kind: 'folder',
        name: `${merged.name}/${only.name}`,
        path: only.path,
        dirs: only.dirs,
        files: only.files,
      };
    }

    compact(merged);
    node.dirs.set(key, merged);
  }
}

/** Folders first and alphabetical, then the files in the order the raw diff listed them. */
function childrenOf(node: Folder): Node[] {
  const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  return [...dirs, ...node.files];
}

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

function dirname(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? '' : path.slice(0, cut);
}

/**
 * `git status`'s two-letter code as a single status letter.
 *
 * The worktree side wins where both say something: a file staged and then edited again reads as
 * modified, because modified is what is in front of you.
 */
function statusOf(file: FileStatus): string {
  if (file.untracked) {
    return '?';
  }

  if (file.conflicted) {
    return 'U';
  }

  const x = file.code.charAt(0);
  const y = file.code.charAt(1);

  return (y !== ' ' ? y : x).toUpperCase();
}

/** The working tree's changes, in the shape the section already knows how to draw. */
export function workingChanges(files: readonly FileStatus[]): FileChange[] {
  return files.map((file) => ({
    status: statusOf(file) as FileChange['status'],
    path: file.path,
    oldPath: null,
    oldBlob: null,
    newBlob: null,
    similarity: null,
  }));
}

/**
 * Open one file's diff in VS Code's own diff editor.
 *
 * For a commit, both sides are addressed by blob OID rather than by `<commit>:<path>`, which is what
 * makes a rename diff correctly: the two sides have different paths, and the raw record already
 * worked out which pairs with which.
 *
 * For the working tree there is neither a commit nor an OID to hand - the right side is the file as
 * it is on disk right now, which is the whole reason for looking at it.
 */
/** What the section is showing: one commit, the working tree, or the gap between two commits. */
export type Subject =
  | { readonly kind: 'commit'; readonly sha: string }
  | { readonly kind: 'working' }
  | { readonly kind: 'range'; readonly from: string; readonly to: string };

export async function openFileDiff(
  repo: string,
  subject: Subject,
  file: FileChange,
): Promise<void> {
  if (subject.kind === 'range') {
    // Both sides carry a blob OID, exactly as they do for one commit, so a rename across the range
    // still diffs as one file rather than as an add beside a delete.
    const short = (sha: string): string => sha.slice(0, 8);

    await vscode.commands.executeCommand(
      'vscode.diff',
      revisionUri(repo, file.oldPath ?? file.path, file.oldBlob, short(subject.from)),
      revisionUri(repo, file.path, file.newBlob, short(subject.to)),
      `${basename(file.path)} (${short(subject.from)} → ${short(subject.to)})`,
      { preview: true },
    );

    return;
  }

  const sha = subject.kind === 'commit' ? subject.sha : null;

  if (sha === null) {
    // An untracked file has no left side and a deleted one has no right side; the rest is HEAD
    // against the file itself.
    const left =
      file.status === '?'
        ? revisionUri(repo, file.path, null, 'untracked')
        : pathAtUri(repo, file.path, 'HEAD', 'HEAD');

    const right =
      file.status === 'D'
        ? revisionUri(repo, file.path, null, 'deleted')
        : vscode.Uri.joinPath(vscode.Uri.file(repo), file.path);

    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      right,
      `${basename(file.path)} (working tree)`,
      { preview: true },
    );

    return;
  }

  const short = sha.slice(0, 8);
  const left = revisionUri(repo, file.oldPath ?? file.path, file.oldBlob, `${short}^`);
  const right = revisionUri(repo, file.path, file.newBlob, short);

  await vscode.commands.executeCommand(
    'vscode.diff',
    left,
    right,
    `${basename(file.path)} (${short})`,
    { preview: true },
  );
}

export class FilesProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly memento: vscode.Memento;

  private view: vscode.TreeView<Node> | null = null;
  private repo: string | null = null;
  /** The commit on show, or null when what is on show is the working tree. */
  private subject: Subject | null = null;
  private files: FileChange[] | null = null;
  private root: Folder = newFolder('', '');
  private asTree: boolean;

  readonly onDidChangeTreeData = this.changed.event;

  constructor(memento: vscode.Memento) {
    this.memento = memento;
    this.asTree = memento.get<boolean>(TREE_KEY, true);
    this.publishMode();
  }

  attach(view: vscode.TreeView<Node>): void {
    this.view = view;
    this.updateHeading();
  }

  /** Point the section at a commit, or at nothing once the last graph closes. */
  setCommit(repo: string | null, details: CommitDetails | null): void {
    this.show(
      repo,
      details === null ? null : { kind: 'commit', sha: details.sha },
      details?.files ?? null,
    );
  }

  /** Point it at the working tree instead: changes that belong to no commit yet. */
  setWorking(repo: string, files: readonly FileStatus[]): void {
    this.show(repo, { kind: 'working' }, workingChanges(files));
  }

  /** Point it at the gap between two commits. */
  setComparison(repo: string, comparison: Comparison): void {
    this.show(repo, { kind: 'range', from: comparison.from, to: comparison.to }, comparison.files);
  }

  private show(repo: string | null, subject: Subject | null, files: FileChange[] | null): void {
    this.repo = repo;
    this.subject = subject;
    this.files = files;
    this.root = files === null ? newFolder('', '') : buildTree(files);

    this.changed.fire();
    this.updateHeading();
  }

  /** Tree or flat. The choice is the user's, not the commit's, so it outlives the selection. */
  setAsTree(asTree: boolean): void {
    if (asTree === this.asTree) {
      return;
    }

    this.asTree = asTree;
    void this.memento.update(TREE_KEY, asTree);
    this.publishMode();
    this.changed.fire();
  }

  getChildren(node?: Node): Node[] {
    if (node === undefined) {
      if (this.files === null) {
        return [];
      }

      return this.asTree
        ? childrenOf(this.root)
        : this.files.map((file) => ({ kind: 'file', file }) as const);
    }

    return node.kind === 'folder' ? childrenOf(node) : [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'folder') {
      // Expanded by default: one commit's tree is small, and folding it shut would hide the only
      // thing the section exists to show.
      const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = vscode.ThemeIcon.Folder;
      return item;
    }

    const { file } = node;
    const status = STATUS_ICON[file.status] ?? STATUS_ICON['X'];
    const label = STATUS_LABEL[file.status] ?? file.status;

    const item = new vscode.TreeItem(basename(file.path));

    // A file node is the only thing the history command can act on, so it is the only thing that
    // offers it.
    item.contextValue = 'weftFile';

    if (status !== undefined) {
      item.iconPath = new vscode.ThemeIcon(status.icon, new vscode.ThemeColor(status.color));
    }

    /*
     * Flat, the directory is the only thing telling two `index.ts` apart, so it belongs on the row.
     * In the tree it is already on the row above, and repeating it is noise.
     */
    const where = this.asTree ? '' : dirname(file.path);
    const from = file.oldPath === null ? '' : `← ${file.oldPath}`;
    const description = [where, from].filter((part) => part.length > 0).join('  ');

    if (description.length > 0) {
      item.description = description;
    }

    item.tooltip =
      file.oldPath === null
        ? `${label}: ${file.path}`
        : `${label}: ${file.oldPath} → ${file.path}`;

    item.command = { command: 'weft.openCommitFile', title: 'Open Changes', arguments: [node] };

    return item;
  }

  /** The repository and file a clicked node stands for, for the command that opens it. */
  target(node: unknown): { repo: string; subject: Subject; file: FileChange } | null {
    const entry = node as Node | undefined;

    if (entry?.kind !== 'file' || this.repo === null || this.subject === null) {
      return null;
    }

    return { repo: this.repo, subject: this.subject, file: entry.file };
  }

  /**
   * The section heading. The count sits beside the title rather than in a row of its own: a message
   * costs a line of the list, and a list this short feels it.
   */
  private updateHeading(): void {
    if (this.view === null) {
      return;
    }

    if (this.files === null) {
      this.view.description = '';
      this.view.message = 'Select a commit in the graph to see the files it changed.';
      return;
    }

    const count = this.files.length;
    const files = count === 1 ? '1 file' : `${count} files`;
    const subject = this.subject;

    const what =
      subject === null
        ? ''
        : subject.kind === 'working'
          ? 'working tree'
          : subject.kind === 'range'
            ? `${subject.from.slice(0, 8)} → ${subject.to.slice(0, 8)}`
            : subject.sha.slice(0, 8);

    this.view.description = `${what} · ${files}`;
    this.view.message =
      count > 0
        ? ''
        : subject?.kind === 'range'
          ? 'These two commits have the same content.'
          : 'This commit changed no files.';
  }

  /** Which of the two title-bar buttons to offer: the one for the mode you are not already in. */
  private publishMode(): void {
    void vscode.commands.executeCommand('setContext', 'weft.filesAsTree', this.asTree);
  }
}
