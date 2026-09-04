import * as vscode from 'vscode';

import { Git } from './git/exec.ts';
import type { RepoInfo } from './git/discovery.ts';
import { discover } from './git/discovery.ts';
import { BraidPanel, setPanelLogger } from './panel.ts';
import { RevisionContentProvider, SCHEME } from './contentProvider.ts';
import { RefsProvider } from './refsView.ts';
import { AuthorsProvider } from './authorsView.ts';

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

/** Run an action that targets the repository, which needs a graph to run against. */
function repoAction(id: string): void {
  const panel = BraidPanel.active();

  if (panel === null) {
    void vscode.window.showInformationMessage('Braid: open the graph first.');
    return;
  }

  panel.runRepoAction(id);
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Braid', { log: true });
  setPanelLogger(output);
  context.subscriptions.push(output);

  const config = vscode.workspace.getConfiguration('braid');

  const git = new Git({
    maxConcurrent: config.get<number>('maxConcurrentGitProcesses', 4),
    networkIdleTimeoutMs: config.get<number>('networkIdleTimeoutSeconds', 60) * 1000,
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

  const authors = new AuthorsProvider(git);
  const authorsView = vscode.window.createTreeView('braid.authors', { treeDataProvider: authors });

  // Read fresh on every reload, so neither view has to push anything at the panel.
  const filters = {
    refs: () => refs.visibleRefs(),
    authorArgs: () => authors.filterArgs(),
  };

  context.subscriptions.push(
    refsView,
    authorsView,
    refs.attach(refsView),
    authors.attach(authorsView),

    // Either filter narrows the walk, so the graph is rebuilt rather than merely repainted.
    refs.onDidChangeFilter(() => BraidPanel.active()?.refresh()),
    authors.onDidChangeFilter(() => BraidPanel.active()?.refresh()),

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
      authors.setRepository(repo);

      BraidPanel.show(
        context.extensionUri,
        git,
        repo,
        vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One,
        filters,
      );
    }),

    vscode.commands.registerCommand('braid.showAllRefs', () => refs.showAll()),

    vscode.commands.registerCommand('braid.showAllAuthors', () => authors.showAll()),

    /*
     * A tree view cannot host a text field, so the query is typed into one of VS Code's own inputs.
     * A quick pick rather than an input box, for two reasons: it offers the ref names as you type
     * instead of asking you to remember them, and it can react to every keystroke - so the list in
     * the sidebar narrows live behind it rather than only once you press Enter.
     */
    vscode.commands.registerCommand('braid.filterRefs', () => {
      const picker = vscode.window.createQuickPick<vscode.QuickPickItem & { ref?: string }>();
      const before = refs.filterText;

      picker.title = 'Filter branches and tags';
      picker.placeholder = 'Type to narrow the list, or pick one';
      picker.value = before;
      picker.matchOnDescription = true;
      picker.matchOnDetail = true;
      picker.items = refs.listRefs().map((ref) => ({
        label: ref.label,
        description: ref.group,
        detail: ref.refName,
        ref: ref.label,
      }));

      let accepted = false;

      picker.onDidChangeValue((value) => refs.setQuery(value));

      picker.onDidAccept(() => {
        accepted = true;
        // Picking an entry filters to exactly it; accepting with nothing highlighted keeps whatever
        // was typed, which is how you filter to a group of refs rather than one.
        refs.setQuery(picker.selectedItems[0]?.ref ?? picker.value);
        picker.hide();
      });

      picker.onDidHide(() => {
        // Escape undoes the live filtering. Leaving it applied would make cancelling do something.
        if (!accepted) {
          refs.setQuery(before);
        }

        picker.dispose();
      });

      picker.show();
    }),

    vscode.commands.registerCommand('braid.stash', () => repoAction('braid.stashPush')),

    /*
     * Fetch, pull and push, whose command ids are their action ids. Force push is deliberately not
     * among the title-bar buttons: it is the one action here that can destroy work living only on
     * someone else's clone, and a button for it one pixel from Push is an accident waiting to
     * happen. The command palette is far enough away to be a decision.
     */
    ...['braid.fetch', 'braid.pull', 'braid.push', 'braid.pushForce'].map((id) =>
      vscode.commands.registerCommand(id, () => repoAction(id)),
    ),

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
  void findRepository(git).then((repo) => {
    authors.setRepository(repo);
    return refs.setRepository(repo);
  });

  output.info('Braid activated');
}

export function deactivate(): void {
  output = undefined;
}
