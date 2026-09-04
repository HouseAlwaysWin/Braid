import * as vscode from 'vscode';

import { Git } from './git/exec.ts';
import type { RepoInfo } from './git/discovery.ts';
import { discover } from './git/discovery.ts';
import { BraidPanel, setPanelLogger } from './panel.ts';
import { RevisionContentProvider, SCHEME } from './contentProvider.ts';
import { RefsProvider } from './refsView.ts';

let output: vscode.LogOutputChannel | undefined;

/**
 * Every repository folder VS Code knows about, most specific first.
 *
 * The built-in git extension is asked first because it has already done the work and knows about
 * repositories the user opened manually. It is never load-bearing though: the API is exported but
 * effectively unversioned, so a missing or changed shape falls back to the workspace folders.
 */
function candidateFolders(): string[] {
  const folders: string[] = [];

  try {
    const gitExtension = vscode.extensions.getExtension<{
      getAPI(version: number): { repositories: { rootUri: vscode.Uri }[] };
    }>('vscode.git');

    const api = gitExtension?.isActive === true ? gitExtension.exports.getAPI(1) : undefined;

    for (const repo of api?.repositories ?? []) {
      folders.push(repo.rootUri.fsPath);
    }
  } catch {
    // The built-in git extension is disabled or its API moved. Workspace folders still work.
  }

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme === 'file') {
      folders.push(folder.uri.fsPath);
    }
  }

  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === 'file') {
    folders.unshift(active.fsPath);
  }

  return [...new Set(folders)];
}

/** The first candidate folder that turns out to be a repository, or null if none are. */
async function findRepository(git: Git): Promise<RepoInfo | null> {
  for (const folder of candidateFolders()) {
    const repo = await discover(git, folder);

    if (repo !== null) {
      return repo;
    }
  }

  return null;
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Braid', { log: true });
  setPanelLogger(output);
  context.subscriptions.push(output);

  const config = vscode.workspace.getConfiguration('braid');

  const git = new Git({
    maxConcurrent: config.get<number>('maxConcurrentGitProcesses', 4),
    onCommand: (entry) => {
      const line = `git ${entry.args.join(' ')} (${entry.durationMs}ms)`;
      if (entry.failed) {
        output?.warn(`${line} -> exit ${entry.exitCode}`);
      } else {
        output?.debug(line);
      }
    },
  });

  const refs = new RefsProvider(git);
  const refsView = vscode.window.createTreeView('braid.refs', {
    treeDataProvider: refs,
    showCollapseAll: true,
  });

  context.subscriptions.push(
    refsView,
    refs.attach(refsView),

    // Unticking a ref narrows the walk, so the graph has to be rebuilt rather than merely repainted.
    refs.onDidChangeFilter(() => BraidPanel.active()?.refresh()),

    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new RevisionContentProvider(git)),

    vscode.commands.registerCommand('braid.openGraph', async () => {
      if (candidateFolders().length === 0) {
        void vscode.window.showInformationMessage('Braid: open a folder containing a git repository first.');
        return;
      }

      const repo = await findRepository(git);

      if (repo === null) {
        void vscode.window.showWarningMessage('Braid: no git repository found in this workspace.');
        return;
      }

      await refs.setRepository(repo);

      BraidPanel.show(
        context.extensionUri,
        git,
        repo,
        vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One,
        () => refs.visibleRefs(),
      );
    }),

    vscode.commands.registerCommand('braid.showAllRefs', () => refs.showAll()),

    vscode.commands.registerCommand('braid.refresh', () => {
      const panel = BraidPanel.active();

      if (panel === null) {
        void vscode.window.showInformationMessage('Braid: no graph is open.');
        return;
      }

      panel.refresh();
    }),

    vscode.commands.registerCommand('braid.showGitLog', () => output?.show()),
  );

  /*
   * One click to the graph itself. The Activity Bar icon opens the refs sidebar rather than the
   * graph - VS Code puts view containers there, not commands - so the status bar is what gets you
   * straight to the thing you came for.
   *
   * It is hidden in workspaces with no repository, because an entry point to something that cannot
   * open is worse than no entry point.
   */
  const statusBar = vscode.window.createStatusBarItem(
    'braid.open',
    vscode.StatusBarAlignment.Left,
    100,
  );

  statusBar.name = 'Braid';
  statusBar.text = '$(git-branch) Braid';
  statusBar.tooltip = 'Open the Braid commit graph';
  statusBar.command = 'braid.openGraph';
  context.subscriptions.push(statusBar);

  const updateStatusBar = async (): Promise<void> => {
    const enabled = vscode.workspace
      .getConfiguration('braid')
      .get<boolean>('statusBar.enabled', true);

    if (!enabled || (await findRepository(git)) === null) {
      statusBar.hide();
      return;
    }

    statusBar.show();
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => void updateStatusBar()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('braid.statusBar.enabled')) {
        void updateStatusBar();
      }
    }),
  );

  void updateStatusBar();

  // Populate the sidebar before the graph is ever opened, so clicking the Activity Bar icon does
  // not land on an empty room.
  void findRepository(git).then((repo) => refs.setRepository(repo));

  output.info('Braid activated');
}

export function deactivate(): void {
  output = undefined;
}
