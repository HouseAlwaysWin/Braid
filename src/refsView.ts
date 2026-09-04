/**
 * The Branches & Tags sidebar: which refs the graph should draw.
 *
 * This is the reason Braid has an Activity Bar icon at all. VS Code puts *view containers* there,
 * not commands, so an icon needs a sidebar behind it - and a filter is the one piece of Braid that
 * genuinely wants to stay on screen while you work, rather than living in a dropdown above the
 * graph that has to be reopened every time.
 *
 * Unchecking refs narrows `git log` to the ones left, which is a real filter rather than a display
 * trick: a repository with two hundred `origin/dependabot/*` branches stops *walking* them.
 */

import * as vscode from 'vscode';

import type { Git } from './git/exec.ts';
import type { RepoInfo } from './git/discovery.ts';

interface Group {
  readonly kind: 'group';
  readonly id: string;
  readonly label: string;
  readonly prefix: string;
}

interface Ref {
  readonly kind: 'ref';
  readonly group: Group;
  /** Full ref name, e.g. `refs/remotes/origin/main` - what git is given. */
  readonly refName: string;
  /** What the user reads, e.g. `origin/main`. */
  readonly label: string;
  readonly isHead: boolean;
}

type Node = Group | Ref;

const GROUPS: Group[] = [
  { kind: 'group', id: 'heads', label: 'Local Branches', prefix: 'refs/heads/' },
  { kind: 'group', id: 'remotes', label: 'Remote Branches', prefix: 'refs/remotes/' },
  { kind: 'group', id: 'tags', label: 'Tags', prefix: 'refs/tags/' },
];

export class RefsProvider implements vscode.TreeDataProvider<Node> {
  private readonly git: Git;
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  private readonly filterChanged = new vscode.EventEmitter<void>();

  private repo: RepoInfo | null = null;
  private refs: Ref[] = [];
  private view: vscode.TreeView<Node> | null = null;

  /**
   * Refs the user has switched off. Storing the *hidden* set rather than the visible one means a
   * branch created after the last refresh shows up by default, which is the behaviour that does not
   * surprise anyone.
   */
  private readonly hidden = new Set<string>();

  readonly onDidChangeTreeData = this.changed.event;
  readonly onDidChangeFilter = this.filterChanged.event;

  constructor(git: Git) {
    this.git = git;
  }

  /** Point the view at a repository and reload its refs. */
  async setRepository(repo: RepoInfo | null): Promise<void> {
    if (repo?.root === this.repo?.root) {
      await this.reload();
      return;
    }

    this.repo = repo;
    // A hidden ref in one repository means nothing in another.
    this.hidden.clear();
    await this.reload();
  }

  /**
   * The refs the graph should walk, or null for "everything" - which lets the caller use `--all`
   * and skip listing hundreds of refs on the command line.
   */
  visibleRefs(): string[] | null {
    if (this.hidden.size === 0) {
      return null;
    }

    return this.refs.filter((ref) => !this.hidden.has(ref.refName)).map((ref) => ref.refName);
  }

  async reload(): Promise<void> {
    const repo = this.repo;

    if (repo === null) {
      this.refs = [];
      this.changed.fire(undefined);
      return;
    }

    try {
      const out = await this.git.run(repo.root, [
        'for-each-ref',
        '--format=%(refname)%00%(HEAD)',
        'refs/heads',
        'refs/remotes',
        'refs/tags',
      ]);

      this.refs = out
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .flatMap((line) => {
          const [refName = '', head = ''] = line.split('\x00');
          const group = GROUPS.find((g) => refName.startsWith(g.prefix));

          if (group === undefined) {
            return [];
          }

          const label = refName.slice(group.prefix.length);

          // origin/HEAD is a symbolic alias, not something you can meaningfully filter on.
          if (group.id === 'remotes' && label.endsWith('/HEAD')) {
            return [];
          }

          return [{ kind: 'ref', group, refName, label, isHead: head === '*' } satisfies Ref];
        });
    } catch {
      this.refs = [];
    }

    this.changed.fire(undefined);
    this.updateMessage();
  }

  getChildren(node?: Node): Node[] {
    if (node === undefined) {
      return GROUPS.filter((group) => this.refs.some((ref) => ref.group.id === group.id));
    }

    if (node.kind === 'group') {
      return this.refs.filter((ref) => ref.group.id === node.id);
    }

    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'group') {
      const children = this.refs.filter((ref) => ref.group.id === node.id);
      const shown = children.filter((ref) => !this.hidden.has(ref.refName)).length;

      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `group:${node.id}`;
      item.description = shown === children.length ? `${children.length}` : `${shown}/${children.length}`;
      item.checkboxState = shown > 0 ? Checked : Unchecked;
      item.contextValue = 'braidRefGroup';
      item.tooltip = `Untick to keep every one of these out of the graph`;
      return item;
    }

    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.id = `ref:${node.refName}`;
    item.checkboxState = this.hidden.has(node.refName) ? Unchecked : Checked;
    item.contextValue = 'braidRef';
    item.tooltip = `${node.refName}\nUntick to keep it out of the graph`;

    item.iconPath = new vscode.ThemeIcon(
      node.group.id === 'tags' ? 'tag' : node.group.id === 'remotes' ? 'cloud' : 'git-branch',
    );

    if (node.isHead) {
      item.description = 'HEAD';
    }

    return item;
  }

  /**
   * Wire the tree's checkboxes up.
   *
   * A group's checkbox applies to everything under it, which is the case this whole view exists
   * for: hiding two hundred remote branches one tick at a time would be worse than not having the
   * filter.
   */
  attach(view: vscode.TreeView<Node>): vscode.Disposable {
    this.view = view;
    this.updateMessage();

    return view.onDidChangeCheckboxState((event) => {
      for (const [node, state] of event.items) {
        const targets =
          node.kind === 'group' ? this.refs.filter((ref) => ref.group.id === node.id) : [node];

        for (const ref of targets) {
          if (state === Checked) {
            this.hidden.delete(ref.refName);
          } else {
            this.hidden.add(ref.refName);
          }
        }
      }

      this.changed.fire(undefined);
      this.updateMessage();
      this.filterChanged.fire();
    });
  }

  /**
   * The line above the tree.
   *
   * A checkbox next to a branch name does not say what ticking it does, and the groups are folded
   * shut by default so there is nothing else to infer it from. While nothing is filtered the line
   * explains the gesture; once something is, it stops teaching and starts reporting - an
   * instruction that never goes away is just furniture.
   */
  private updateMessage(): void {
    if (this.view === null) {
      return;
    }

    // Empty rather than undefined: `exactOptionalPropertyTypes` rejects assigning undefined to an
    // optional property, and an empty message hides the line just the same.
    if (this.refs.length === 0) {
      this.view.message = '';
      return;
    }

    this.view.message =
      this.hidden.size === 0
        ? 'Untick a branch or tag to keep it out of the graph.'
        : `${this.hidden.size} hidden — the graph shows the rest.`;
  }

  /** Turn every ref back on. */
  showAll(): void {
    if (this.hidden.size === 0) {
      return;
    }

    this.hidden.clear();
    this.changed.fire(undefined);
    this.updateMessage();
    this.filterChanged.fire();
  }
}

const Checked = vscode.TreeItemCheckboxState.Checked;
const Unchecked = vscode.TreeItemCheckboxState.Unchecked;
