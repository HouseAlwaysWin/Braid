/**
 * The Authors sidebar: whose commits the graph should draw.
 *
 * The search box has had an `author` mode all along, but typing a name from memory is a poor way
 * to use a filter - you have to already know who is in the history and how they spell themselves.
 * A list you tick is the same filter without the recall problem.
 *
 * Like the ref filter, this narrows what `git log` walks rather than hiding rows after the fact.
 */

import * as vscode from 'vscode';

import type { Git } from './git/exec.ts';
import type { RepoInfo } from './git/discovery.ts';
import type { Author } from './git/authors.ts';
import { authorArgs, listAuthors } from './git/authors.ts';

export class AuthorsProvider implements vscode.TreeDataProvider<Author> {
  private readonly git: Git;
  private readonly changed = new vscode.EventEmitter<Author | undefined>();
  private readonly filterChanged = new vscode.EventEmitter<void>();

  private repo: RepoInfo | null = null;
  private authors: Author[] = [];
  private loaded = false;
  private view: vscode.TreeView<Author> | null = null;

  /** Selected authors, by name. Empty means everyone, which is not the same as nobody. */
  private readonly selected = new Set<string>();

  readonly onDidChangeTreeData = this.changed.event;
  readonly onDidChangeFilter = this.filterChanged.event;

  constructor(git: Git) {
    this.git = git;
  }

  setRepository(repo: RepoInfo | null): void {
    if (repo?.root === this.repo?.root) {
      return;
    }

    this.repo = repo;
    this.authors = [];
    this.loaded = false;
    this.selected.clear();
    this.changed.fire(undefined);
  }

  /** `git log` arguments for the current selection; empty when nobody is filtered out. */
  filterArgs(): string[] {
    return this.selected.size === 0 ? [] : authorArgs([...this.selected]);
  }

  /**
   * Loaded when the section is first expanded, not when the panel opens.
   *
   * `shortlog` walks the entire history; on a large repository that is seconds of work for a list
   * nobody has asked to see yet.
   */
  async getChildren(node?: Author): Promise<Author[]> {
    if (node !== undefined || this.repo === null) {
      return [];
    }

    if (!this.loaded) {
      this.authors = await listAuthors(this.git, this.repo);
      this.loaded = true;
      this.updateMessage();
    }

    return this.authors;
  }

  getTreeItem(author: Author): vscode.TreeItem {
    const item = new vscode.TreeItem(author.name, vscode.TreeItemCollapsibleState.None);

    item.id = `author:${author.name}`;
    item.description = `${author.commits}`;
    item.tooltip = `${author.name} <${author.email}>\n${author.commits} commits\nTick to show only these`;
    // Ticked means "only these", the opposite polarity to the ref filter. With nobody ticked
    // everyone is shown and no box is ticked - starting all-ticked would suggest that unticking one
    // hides that person, which is not what happens.
    item.checkboxState = this.selected.has(author.name)
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;

    item.iconPath = new vscode.ThemeIcon('account');
    return item;
  }

  attach(view: vscode.TreeView<Author>): vscode.Disposable {
    this.view = view;
    this.updateMessage();

    return view.onDidChangeCheckboxState((event) => {
      for (const [author, state] of event.items) {
        if (state === vscode.TreeItemCheckboxState.Checked) {
          this.selected.add(author.name);
        } else {
          this.selected.delete(author.name);
        }
      }

      this.changed.fire(undefined);
      this.updateMessage();
      this.filterChanged.fire();
    });
  }

  showAll(): void {
    if (this.selected.size === 0) {
      return;
    }

    this.selected.clear();
    this.changed.fire(undefined);
    this.updateMessage();
    this.filterChanged.fire();
  }

  private updateMessage(): void {
    if (this.view === null) {
      return;
    }

    if (!this.loaded) {
      this.view.message = '';
      return;
    }

    this.view.message =
      this.selected.size === 0
        ? 'Tick an author to show only their commits.'
        : `Showing ${this.selected.size} of ${this.authors.length} authors.`;
  }
}
