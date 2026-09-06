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
  private selected = new Set<string>();

  /** Ticked authors per repository, for the same two reasons the ref view keeps its own. */
  private readonly selectedByRepo = new Map<string, Set<string>>();

  /**
   * Text narrowing the *listing*, which is a different job from the ticks.
   *
   * The ticks decide whose commits the graph walks. This decides who is on screen to tick. On a
   * repository with two hundred contributors the second is what stands between you and the first.
   */
  private query = '';

  readonly onDidChangeTreeData = this.changed.event;
  readonly onDidChangeFilter = this.filterChanged.event;

  constructor(git: Git) {
    this.git = git;
  }

  setRepository(repo: RepoInfo | null): void {
    if (repo?.root === this.repo?.root) {
      return;
    }

    if (this.repo !== null) {
      this.selectedByRepo.set(this.repo.root, this.selected);
    }

    this.repo = repo;
    this.authors = [];
    this.loaded = false;
    this.selected = this.selectedByRepo.get(repo?.root ?? '') ?? new Set<string>();
    // A name typed to find someone in one repository means nothing in another.
    this.query = '';
    this.publishFiltering();
    this.changed.fire(undefined);
  }

  /**
   * `git log` arguments for the current selection; empty when nobody is filtered out.
   *
   * Answered for one repository only - the one this view is showing. Every open graph reloads when
   * a tick moves, and a name that authored nothing in the other one filters it down to nothing.
   */
  filterArgs(root: string): string[] {
    if (this.repo === null || this.repo.root !== root || this.selected.size === 0) {
      return [];
    }

    return authorArgs([...this.selected]);
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

    return this.visible();
  }

  /** Authors left after the text filter. Matches the email too - names collide, addresses do not. */
  private visible(): Author[] {
    if (this.query.length === 0) {
      return this.authors;
    }

    const needle = this.query.toLowerCase();
    return this.authors.filter(
      (author) =>
        author.name.toLowerCase().includes(needle) || author.email.toLowerCase().includes(needle),
    );
  }

  /** Narrow the listing. An empty string clears it. */
  setQuery(query: string): void {
    this.query = query.trim();
    this.changed.fire(undefined);
    this.updateMessage();
    this.publishFiltering();
  }

  get filterText(): string {
    return this.query;
  }

  /** Every author, for a picker to offer as completions. */
  listAuthors(): { name: string; email: string; commits: number }[] {
    return this.authors.map((author) => ({
      name: author.name,
      email: author.email,
      commits: author.commits,
    }));
  }

  /**
   * Tick everyone the list is currently showing.
   *
   * The gesture the text filter exists to enable: narrow to a team, a surname, a company's domain,
   * then show the graph exactly those people. Doing it a tick at a time is the thing that made a
   * long list unusable in the first place.
   */
  showOnlyListed(): void {
    const listed = this.visible();

    if (listed.length === 0) {
      return;
    }

    const before = this.selected.size;

    this.selected.clear();

    for (const author of listed) {
      this.selected.add(author.name);
    }

    // Nothing moved, so nothing is announced: re-applying the same set would cost a full walk of
    // the history to arrive at the same graph.
    if (before === this.selected.size && before === listed.length) {
      this.changed.fire(undefined);
      this.updateMessage();
      return;
    }

    this.changed.fire(undefined);
    this.updateMessage();
    this.filterChanged.fire();
  }

  private publishFiltering(): void {
    void vscode.commands.executeCommand(
      'setContext',
      'weft.authorsListFiltered',
      this.query.length > 0,
    );
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

  /** Clear the selection and repaint. Announcing it is the caller's, so a bulk clear reloads once. */
  reset(): boolean {
    const filtered = this.query.length > 0;

    if (this.selected.size === 0 && !filtered) {
      return false;
    }

    const wasSelecting = this.selected.size > 0;

    this.selected.clear();
    this.query = '';
    this.publishFiltering();
    this.changed.fire(undefined);
    this.updateMessage();

    // Clearing a listing filter changes nothing the graph walked, so it is not worth a reload. Only
    // the ticks were.
    return wasSelecting;
  }

  showAll(): void {
    if (this.reset()) {
      this.filterChanged.fire();
    }
  }

  private updateMessage(): void {
    if (this.view === null) {
      return;
    }

    if (!this.loaded) {
      this.view.message = '';
      return;
    }

    const listed = this.visible().length;
    const total = this.authors.length;

    /*
     * The message has to carry the half that is not on screen.
     *
     * Narrowing the list leaves everyone who fell out of it exactly as they were - the graph is
     * unchanged by typing a name. A line naming only what is listed invites the reader to conclude
     * they are looking at the filter itself, which is the same trap the ref list had.
     */
    if (this.query.length > 0) {
      const ticked =
        this.selected.size === 0
          ? 'Nothing is ticked, so the graph still shows everyone.'
          : `${this.selected.size} ticked, which is what the graph is showing.`;

      this.view.message = `Listing ${listed} of ${total} authors matching \u201C${this.query}\u201D. ${ticked}`;
      return;
    }

    this.view.message =
      this.selected.size === 0
        ? 'Tick an author to show only their commits.'
        : `Showing ${this.selected.size} of ${total} authors.`;
  }
}
