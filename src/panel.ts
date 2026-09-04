/**
 * The graph webview panel: one per repository.
 *
 * A `WebviewPanel` rather than a `CustomEditorProvider`, because a custom editor binds a webview to
 * a file on disk and "the history of a repository" is not a file.
 */

import * as vscode from 'vscode';

import type { Git } from './git/exec.ts';
import type { RepoInfo } from './git/discovery.ts';
import { HistoryLoader } from './git/history.ts';
import type { CommitDetails } from './git/details.ts';
import { loadCommitDetails } from './git/details.ts';
import { revisionUri } from './contentProvider.ts';
import { RepoWatcher, refSignature } from './git/watcher.ts';
import type { Search } from './git/search.ts';
import { searchArgs } from './git/search.ts';
import type { HostMessage, Row, WebviewMessage } from './protocol.ts';
import { BODY_MARKUP } from './webview/markup.ts';

/**
 * Everything outside the panel that narrows what the graph walks. One object rather than a growing
 * list of callbacks, and read fresh on every reload so the panel never holds a stale copy.
 */
export interface FilterSource {
  refs(): string[] | null;
  authorArgs(): string[];
}
import { RepoLock } from './git/lock.ts';
import { describeOperation, readRepoState } from './git/repoState.ts';
import { listStashes } from './git/stash.ts';
import { mapGitError } from './git/errors.ts';
import type { ActionContext, ActionUi, Target } from './actions/registry.ts';
import { buildMenu, confirmIfNeeded, findAction } from './actions/registry.ts';

/** Set by the extension so panels can write to the same output channel. */
let output: { warn(message: string): void } | undefined;

export function setPanelLogger(logger: { warn(message: string): void }): void {
  output = logger;
}

export const VIEW_TYPE = 'braid.graph';

function describe(repo: RepoInfo): string | null {
  if (repo.isBare) {
    return 'bare';
  }

  if (repo.isLinkedWorktree) {
    return 'linked worktree';
  }

  if (repo.superproject !== null) {
    return 'submodule';
  }

  return null;
}

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return out;
}

export class BraidPanel {
  private static readonly open = new Map<string, BraidPanel>();
  private static current: BraidPanel | null = null;
  /** Shared across panels: two graphs on the same repository must not write at once. */
  private static readonly lock = new RepoLock();

  /** The graph the user is looking at, for commands that act on "this graph". */
  static active(): BraidPanel | null {
    return BraidPanel.current;
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly git: Git;
  private readonly repo: RepoInfo;
  private readonly extensionUri: vscode.Uri;
  private readonly disposables: vscode.Disposable[] = [];
  private loading: AbortController | null = null;
  private detailsLoading: AbortController | null = null;
  /** The last commit whose details were loaded, so opening a diff needs no second `git show`. */
  private details: CommitDetails | null = null;
  private readonly watcher: RepoWatcher;
  /** Fingerprint of the refs the last load was built from, to tell a real change from churn. */
  private signature: string | null = null;
  private signaturePromise: Promise<string | null> | null = null;
  private search: Search | null = null;
  private readonly filters: FilterSource;

  private readonly ui: ActionUi = {
    confirm: async (request) => {
      const choice = await vscode.window.showWarningMessage(
        request.title,
        { modal: true, detail: request.detail },
        request.confirmLabel,
      );

      return choice === request.confirmLabel;
    },

    input: async (request) => {
      const value = await vscode.window.showInputBox({
        title: request.title,
        prompt: request.placeholder,
        ...(request.value === undefined ? {} : { value: request.value }),
        validateInput: (entered) => request.validate?.(entered) ?? null,
      });

      // Dismissing the box is a cancel; an empty string is a deliberate empty answer, which some
      // actions treat as meaningful (a tag with no message is a lightweight tag).
      return value ?? null;
    },
    // withProgress hands back a Thenable; the registry deals in Promises so it can stay free of
    // any vscode types and remain runnable from a test.
    progress: async (title, work) =>
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Braid: ${title}` },
        work,
      ),
    notify: (message) => void vscode.window.setStatusBarMessage(`Braid: ${message}`, 4000),
  };

  static show(
    extensionUri: vscode.Uri,
    git: Git,
    repo: RepoInfo,
    column: vscode.ViewColumn,
    filters: FilterSource,
  ): BraidPanel {
    const existing = BraidPanel.open.get(repo.root);
    if (existing !== undefined) {
      existing.panel.reveal(column);
      return existing;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      `Braid: ${repo.root.split('/').pop() ?? 'Graph'}`,
      column,
      {
        enableScripts: true,
        // Deliberately off: retaining the context for a 100k-row graph keeps all of it resident
        // while the tab is hidden. The graph reloads in under a second, so it is not worth the RAM.
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
      },
    );

    const braid = new BraidPanel(panel, extensionUri, git, repo, filters);
    BraidPanel.open.set(repo.root, braid);
    return braid;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    git: Git,
    repo: RepoInfo,
    filters: FilterSource,
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.git = git;
    this.repo = repo;
    this.filters = filters;

    panel.webview.html = this.html(panel.webview);

    panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => void this.onMessage(message),
      null,
      this.disposables,
    );

    panel.onDidChangeViewState(() => this.setActive(panel.active), null, this.disposables);
    panel.onDidDispose(() => this.dispose(), null, this.disposables);

    const debounce = vscode.workspace
      .getConfiguration('braid')
      .get<number>('refreshDebounceMs', 600);

    this.watcher = new RepoWatcher(repo, () => void this.onRepositoryChanged(), debounce);
    this.setActive(true);
  }

  /**
   * A filesystem event fired. Confirm something the graph actually draws from moved before paying
   * for a reload - an editor saving a file inside .git, or git touching a lock, must not cost a
   * full re-walk of the history.
   */
  private async onRepositoryChanged(): Promise<void> {
    // A write in flight touches refs constantly. Its own reload comes at the end; reacting here as
    // well would reload the graph from the middle of a half-finished operation.
    if (BraidPanel.lock.isBusy(this.repo.root)) {
      return;
    }

    // The baseline is captured alongside the walk rather than before it, so it may still be in
    // flight. Comparing against a half-set baseline would either miss a change or invent one.
    await this.signaturePromise;

    let signature: string;

    try {
      signature = await refSignature(this.git, this.repo);
    } catch {
      return;
    }

    if (signature === this.signature) {
      return;
    }

    const first = this.signature === null;
    this.signature = signature;

    if (!first) {
      this.post({ type: 'reloading', reason: 'repository changed' });
      await this.reload();
    }
  }

  /**
   * Track which graph is in front, and mirror it into a context key so `Braid: Refresh` only
   * offers itself in the command palette when there is actually a graph to refresh.
   */
  private setActive(active: boolean): void {
    if (active) {
      BraidPanel.current = this;
    } else if (BraidPanel.current === this) {
      BraidPanel.current = null;
    }

    void vscode.commands.executeCommand(
      'setContext',
      'braid.graphVisible',
      BraidPanel.current !== null,
    );
  }

  /** Throw away whatever is on screen and walk the history again. */
  refresh(): void {
    void this.reload();
  }

  /** Run an action that targets the repository rather than anything in the graph. */
  runRepoAction(id: string): void {
    void this.runAction(id, { kind: 'repo' });
  }

  private async onMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.reload();
        break;
      case 'refresh':
        await this.reload();
        break;
      case 'search':
        this.search = message.search;
        await this.reload();
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(message.text);
        void vscode.window.setStatusBarMessage('Braid: copied', 2000);
        break;
      case 'selectCommit':
        await this.showDetails(message.sha);
        break;
      case 'openDiff':
        await this.openDiff(message.sha, message.index);
        break;
      case 'requestMenu':
        await this.showMenu(message.target, message.x, message.y);
        break;
      case 'runAction':
        await this.runAction(message.id, message.target);
        break;
      case 'openConflict':
        await this.openConflict(message.path);
        break;
      default:
        break;
    }
  }

  /**
   * Whether an action is available depends on repository state - mid-rebase, already checked out,
   * a dirty tree - which the webview does not have. So the menu is built here, on demand, and the
   * click position rides along so it can open where the pointer is.
   */
  private async showMenu(target: Target, x: number, y: number): Promise<void> {
    try {
      const state = await readRepoState(this.git, this.repo);
      this.post({ type: 'menu', target, items: buildMenu(target, state), x, y });
    } catch (err) {
      this.reportError(err);
    }
  }

  /**
   * Run one action, holding the repository lock across read-decide-act.
   *
   * The lock covers the whole sequence rather than just the git call: the state an action checked
   * has to still be true when it acts, and the watcher must not reload the graph from underneath a
   * half-finished operation.
   */
  private async runAction(id: string, target: Target): Promise<void> {
    const action = findAction(id);

    if (action === undefined) {
      return;
    }

    try {
      const result = await BraidPanel.lock.run(this.repo.root, async () => {
        const state = await readRepoState(this.git, this.repo);
        const unavailable = action.unavailable(target, state);

        if (unavailable !== null) {
          this.post({ type: 'error', message: `${action.label(target)}: ${unavailable.toLowerCase()}` });
          return null;
        }

        const context: ActionContext = { git: this.git, repo: this.repo, state, target, ui: this.ui };

        if (!(await confirmIfNeeded(action, context))) {
          return null;
        }

        // Where we were, so the follow-up message can say how to get back. git keeps this in the
        // reflog too, but only someone who already knows that would go looking.
        const before = state.head;
        const outcome = await action.run(context);
        return { outcome, before };
      });

      if (result === null) {
        return;
      }

      await this.reload();

      const back = result.before === null ? '' : `  (was ${result.before.slice(0, 8)})`;
      void vscode.window.setStatusBarMessage(`Braid: ${result.outcome.message}${back}`, 5000);
    } catch (err) {
      this.reportError(err);
    }
  }

  private reportError(err: unknown): void {
    const mapped = mapGitError(err);
    const detail = mapped.paths.length === 0 ? '' : `\n\n${mapped.paths.map((p) => `  ${p}`).join('\n')}`;

    output?.warn(`${mapped.message}\n${mapped.raw}`);
    void vscode.window.showWarningMessage(mapped.message + detail, { modal: mapped.paths.length > 0 });
    this.post({ type: 'error', message: mapped.message });
  }

  /**
   * Load one commit's message and file list. Selection follows the arrow keys, so a held-down key
   * would otherwise queue a `git show` per row - each new request cancels the one before it.
   */
  private async showDetails(sha: string): Promise<void> {
    this.detailsLoading?.abort();
    const controller = new AbortController();
    this.detailsLoading = controller;

    try {
      const details = await loadCommitDetails(this.git, this.repo, sha, controller.signal);

      if (!controller.signal.aborted) {
        this.details = details;
        this.post({ type: 'details', details });
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        this.post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      if (this.detailsLoading === controller) {
        this.detailsLoading = null;
      }
    }
  }

  private async openDiff(sha: string, index: number): Promise<void> {
    const details =
      this.details?.sha === sha
        ? this.details
        : await loadCommitDetails(this.git, this.repo, sha);

    const file = details.files[index];
    if (file === undefined) {
      return;
    }

    const short = sha.slice(0, 8);
    const name = file.path.split('/').pop() ?? file.path;

    // Both sides are addressed by blob OID, so a rename diffs correctly even though the two sides
    // have different paths.
    const left = revisionUri(this.repo.root, file.oldPath ?? file.path, file.oldBlob, `${short}^`);
    const right = revisionUri(this.repo.root, file.path, file.newBlob, short);

    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      right,
      `${name} (${short})`,
      { preview: true },
    );
  }

  /**
   * Hand a conflicted file to VS Code. Its merge editor opens by itself for a file with conflict
   * markers, and it is better at resolving them than anything that would fit in the graph.
   */
  private async openConflict(path: string): Promise<void> {
    const uri = vscode.Uri.joinPath(vscode.Uri.file(this.repo.root), path);
    await vscode.commands.executeCommand('vscode.open', uri);
  }

  /**
   * Tell the view what git is halfway through. Sent on every reload rather than only when it
   * changes, because the view is rebuilt from scratch each time the tab is shown.
   */
  private postOperation(state: Awaited<ReturnType<typeof readRepoState>>): void {
    this.post({
      type: 'operation',
      operation: state.operation,
      description: describeOperation(state.operation) ?? '',
      conflicted: state.files.filter((file) => file.conflicted).map((file) => file.path),
      controls: buildMenu({ kind: 'repo' }, state).filter((item) => item.group !== 'stash'),
    });
  }

  private post(message: HostMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private async reload(): Promise<void> {
    // A refresh landing mid-walk must stop the old one, or two loaders race to append rows.
    this.loading?.abort();
    const controller = new AbortController();
    this.loading = controller;

    const config = vscode.workspace.getConfiguration('braid');

    this.post({ type: 'reset' });
    this.post({
      type: 'init',
      repoName: this.repo.root.split('/').pop() ?? this.repo.root,
      repoRoot: this.repo.root,
      rowHeight: config.get<number>('rowHeight', 24),
      kind: describe(this.repo),
    });

    const loader = new HistoryLoader(this.git, this.repo);
    const started = Date.now();

    // Only the newest stash is a ref, so the rest have to be named by SHA or the walk never sees
    // them. Cheap enough to re-read on every reload; a repository has a handful, not thousands.
    const stashList = await listStashes(this.git, this.repo).catch(() => []);
    const stashes = new Map(stashList.map((stash) => [stash.sha, stash.name]));

    // Before the history, not after: if git is mid-rebase the user should be told that while the
    // walk is still running, not once it finishes.
    await readRepoState(this.git, this.repo)
      .then((state) => this.postOperation(state))
      .catch(() => undefined);

    /*
     * Fingerprint the refs alongside the walk, not before it. Awaiting here put two more process
     * spawns on the critical path between the user's click and the first row on screen, which on
     * Windows - where spawning git costs tens of milliseconds before it does any work, more with a
     * virus scanner in the way - is latency nobody is getting anything for.
     *
     * Starting it first and resolving it later still gives the watcher a baseline from before the
     * walk finished: if a ref moves mid-walk the fingerprint is already stale, so the next event
     * reloads, which is the safe direction to be wrong in.
     */
    this.signaturePromise = refSignature(this.git, this.repo).catch(() => null);
    void this.signaturePromise.then((value) => {
      this.signature = value;
    });

    try {
      await loader.load(
        (page) => {
          if (controller.signal.aborted) {
            return;
          }

          const rows: Row[] = page.commits.map((c) => {
            const stash = stashes.get(c.sha);

            return {
              sha: c.sha,
              subject: c.subject,
              author: c.author,
              date: c.authorDate,
              refs: c.refs,
              isHead: c.isHead,
              ...(stash === undefined ? {} : { stash }),
            };
          });

          this.post({ type: 'page', rows, delta: page.delta });
        },
        {
          batchSize: 500,
          maxCommits: config.get<number>('maxCommits', 250_000),
          filters: [...searchArgs(this.search), ...this.filters.authorArgs()],
          refs: this.filters.refs(),
          stashes,
        },
        controller.signal,
      );

      if (!controller.signal.aborted) {
        this.post({ type: 'done', total: loader.rowCount, elapsedMs: Date.now() - started });
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        this.post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      if (this.loading === controller) {
        this.loading = null;
      }
    }
  }

  private html(webview: vscode.Webview): string {
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'main.js'),
    );
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'style.css'));
    const n = nonce();

    // connect-src 'none' is worth stating outright: Braid never makes a network request, and the
    // policy should be able to prove that rather than asking to be trusted on it.
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${n}'; connect-src 'none';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${style.toString()}" rel="stylesheet">
<title>Braid</title>
</head>
<body>
${BODY_MARKUP}
<script nonce="${n}" src="${script.toString()}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    this.loading?.abort();
    this.detailsLoading?.abort();
    this.watcher.dispose();
    BraidPanel.open.delete(this.repo.root);
    this.setActive(false);

    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
