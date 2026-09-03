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
import type { HostMessage, Row, WebviewMessage } from './protocol.ts';
import { BODY_MARKUP } from './webview/markup.ts';

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

  private readonly panel: vscode.WebviewPanel;
  private readonly git: Git;
  private readonly repo: RepoInfo;
  private readonly extensionUri: vscode.Uri;
  private readonly disposables: vscode.Disposable[] = [];
  private loading: AbortController | null = null;

  static show(
    extensionUri: vscode.Uri,
    git: Git,
    repo: RepoInfo,
    column: vscode.ViewColumn,
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

    const braid = new BraidPanel(panel, extensionUri, git, repo);
    BraidPanel.open.set(repo.root, braid);
    return braid;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    git: Git,
    repo: RepoInfo,
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.git = git;
    this.repo = repo;

    panel.webview.html = this.html(panel.webview);

    panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => void this.onMessage(message),
      null,
      this.disposables,
    );

    panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  /** Throw away whatever is on screen and walk the history again. */
  refresh(): void {
    void this.reload();
  }

  private async onMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.reload();
        break;
      case 'refresh':
        await this.reload();
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(message.text);
        void vscode.window.setStatusBarMessage('Braid: copied', 2000);
        break;
      case 'selectCommit':
        break;
      default:
        break;
    }
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

    try {
      await loader.load(
        (page) => {
          if (controller.signal.aborted) {
            return;
          }

          const rows: Row[] = page.commits.map((c) => ({
            sha: c.sha,
            subject: c.subject,
            author: c.author,
            date: c.authorDate,
            refs: c.refs,
            isHead: c.isHead,
          }));

          this.post({ type: 'page', rows, delta: page.delta });
        },
        { batchSize: 500, maxCommits: config.get<number>('maxCommits', 250_000) },
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
    BraidPanel.open.delete(this.repo.root);

    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
