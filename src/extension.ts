import * as vscode from 'vscode';
import { dirname } from 'node:path';

import { Git } from './git/exec.ts';
import type { RepoInfo } from './git/discovery.ts';
import { discover } from './git/discovery.ts';
import { WeftPanel, setCommitFiles, setPanelLogger } from './panel.ts';
import { RevisionContentProvider, SCHEME } from './contentProvider.ts';
import { RefsProvider } from './refsView.ts';
import { AuthorsProvider } from './authorsView.ts';
import { FilesProvider, openFileDiff } from './filesView.ts';
import { watchRepositories } from './git/vscodeGit.ts';

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

  /*
   * The folder holding the open file, not the file.
   *
   * `discover` runs git with this as its working directory, and a file is not a directory to run
   * anything in - Node reports that as `spawn git ENOENT`, indistinguishable at a glance from git
   * not being installed. It took the whole presence update down with it: the rejection was silent,
   * so the context key the Source Control sections are gated on was never set and all three
   * vanished - while the graph, opened later with no editor focused, worked perfectly.
   */
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === 'file') {
    folders.unshift(dirname(active.fsPath));
  }

  return [...new Set(folders)];
}

/**
 * The first candidate folder that turns out to be a repository, or null if none are.
 *
 * A candidate that cannot even be looked at is a candidate that is not a repository. Letting one
 * of them throw would abandon the folders behind it *and* whatever the caller was going to do with
 * the answer, which is a great deal of damage for a path that was only ever a guess.
 */
async function findRepository(git: Git): Promise<RepoInfo | null> {
  for (const folder of candidateFolders()) {
    try {
      const repo = await discover(git, folder);

      if (repo !== null) {
        return repo;
      }
    } catch (err) {
      output?.debug(`not a usable folder: ${folder} (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  return null;
}

/** Put something on the clipboard and say so, briefly - a copy with no feedback reads as a no-op. */
async function copy(text: string): Promise<void> {
  await vscode.env.clipboard.writeText(text);
  void vscode.window.setStatusBarMessage(`Weft: copied ${text}`, 2000);
}

/** Run an action that targets the repository, which needs a graph to run against. */
function repoAction(id: string): void {
  const panel = WeftPanel.active();

  if (panel === null) {
    void vscode.window.showInformationMessage('Weft: open the graph first.');
    return;
  }

  panel.runRepoAction(id);
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Weft', { log: true });
  setPanelLogger(output);
  context.subscriptions.push(output);

  try {
    start(context);
  } catch (err) {
    /*
     * Activation is all or nothing, and its failure is silent by default.
     *
     * Everything Weft contributes hangs off the end of `start`: the commands are registered there,
     * and the three Source Control sections are gated on a context key it sets. An exception
     * anywhere in it therefore does not lose one feature, it loses all of them - and VS Code says
     * nothing beyond a line in a log nobody has open.
     *
     * The way this is reached in development is a window whose manifest is older than its code:
     * `createTreeView` throws for a view the running window has never heard of, which is what
     * happens after a new view is added and the Extension Development Host is not restarted.
     */
    const message = err instanceof Error ? err.message : String(err);

    output.error(`Weft failed to activate: ${message}`);

    void vscode.window
      .showErrorMessage(`Weft failed to activate: ${message}`, 'Show Log')
      .then((choice) => {
        if (choice === 'Show Log') {
          output?.show();
        }
      });
  }
}

function start(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration('weft');

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
  const refsView = vscode.window.createTreeView('weft.refs', {
    treeDataProvider: refs,
    showCollapseAll: true,

    /*
     * Weft owns the checkboxes, because VS Code and Weft disagree about what a group's tick
     * means. Weft says "some of these are shown"; VS Code reads a ticked parent as "every child is
     * ticked" and drives them all back on - so unticking one branch put the tick straight back,
     * because the group it lives in still had others showing.
     */
    manageCheckboxStateManually: true,
  });

  const authors = new AuthorsProvider(git);
  const authorsView = vscode.window.createTreeView('weft.authors', { treeDataProvider: authors });

  /*
   * The selected commit's files. `globalState` rather than the workspace's, because tree-or-flat is
   * how someone likes to read a file list, not something about this repository.
   */
  const files = new FilesProvider(context.globalState);
  const filesView = vscode.window.createTreeView('weft.files', { treeDataProvider: files });

  files.attach(filesView);
  setCommitFiles({
    show: (repo, details) => files.setCommit(repo, details),
    working: (repo, changes) => files.setWorking(repo, changes),
    compared: (repo, comparison) => files.setComparison(repo, comparison),
    clear: () => files.setCommit(null, null),
  });

  // Read fresh on every reload, so neither view has to push anything at the panel.
  const filters = {
    refs: () => refs.visibleRefs(),
    authorArgs: () => authors.filterArgs(),
    listRefs: () => refs.listForMenu(),
    refsMoved: () => void refs.reload(),
    setRefsVisible: (refNames: readonly string[], visible: boolean) =>
      refs.setVisible(refNames, visible),
    // `reset` rather than `showAll`: neither view asks for a reload, because the panel is about to.
    clear: () => {
      refs.reset();
      authors.reset();
    },
  };

  context.subscriptions.push(
    refsView,
    authorsView,
    filesView,
    refs.attach(refsView),
    authors.attach(authorsView),

    // Either filter narrows the walk, so the graph is rebuilt rather than merely repainted.
    /*
     * Every open graph, not the focused one. Ticking a box in Source Control is itself the act of
     * unfocusing the graph, so `active()` here was reliably null and the filter reliably did
     * nothing - the one place where "the graph the user is looking at" is the wrong graph.
     */
    refs.onDidChangeFilter(() => WeftPanel.refreshAll()),
    authors.onDidChangeFilter(() => WeftPanel.refreshAll()),

    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new RevisionContentProvider(git)),

    vscode.commands.registerCommand('weft.openGraph', async () => {
      if (candidateFolders().length === 0) {
        void vscode.window.showInformationMessage('Weft: open a folder containing a git repository first.');
        return;
      }

      const repo = await findRepository(git);

      if (repo === null) {
        void vscode.window.showWarningMessage('Weft: no git repository found in this workspace.');
        return;
      }

      await refs.setRepository(repo);
      authors.setRepository(repo);

      WeftPanel.show(
        context.extensionUri,
        git,
        repo,
        vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One,
        filters,
      );
    }),

    vscode.commands.registerCommand('weft.showAllRefs', () => refs.showAll()),

    vscode.commands.registerCommand('weft.showOnlyListedRefs', () => refs.showOnlyListed()),

    /*
     * Copying, in the two trees. The graph's own menu answers its copies itself - it has the text
     * already and nothing about them is the host's business - but a tree view's menu is contributed
     * through the manifest, so these need commands to point at.
     */
    vscode.commands.registerCommand('weft.copyRefName', async (node: unknown) => {
      const target = refs.targetOf(node);

      if (target !== null) {
        await copy(target.label);
      }
    }),

    vscode.commands.registerCommand('weft.copyFullRefName', async (node: unknown) => {
      const target = refs.targetOf(node);

      if (target !== null) {
        await copy(target.refName);
      }
    }),

    vscode.commands.registerCommand('weft.copyFilePath', async (node: unknown) => {
      const target = files.target(node);

      if (target !== null) {
        await copy(target.file.path);
      }
    }),

    vscode.commands.registerCommand('weft.copyAbsoluteFilePath', async (node: unknown) => {
      const target = files.target(node);

      if (target !== null) {
        // The path on this machine, separators and all, because that is what it is for: pasting
        // into something that is not git.
        await copy(vscode.Uri.joinPath(vscode.Uri.file(target.repo), target.file.path).fsPath);
      }
    }),

    /*
     * The sidebar's own actions. They take the node the tree hands them rather than a name typed
     * somewhere, so the full ref name travels with the target and `main` the branch can never be
     * confused with `main` the tag.
     */
    vscode.commands.registerCommand('weft.showOnlyRef', (node: unknown) => {
      const target = refs.targetOf(node);

      if (target !== null) {
        refs.showOnly(target.refName);
      }
    }),

    vscode.commands.registerCommand('weft.checkoutRef', (node: unknown) => {
      const target = refs.targetOf(node);

      if (target === null) {
        return;
      }

      const panel = WeftPanel.any();

      if (panel === null) {
        void vscode.window.showInformationMessage('Weft: open the graph first.');
        return;
      }

      panel.runTargetAction(
        target.refKind === 'remote' ? 'weft.checkoutRemoteBranch' : 'weft.checkoutBranch',
        { kind: 'ref', ...target },
      );
    }),

    /*
     * Delete, from the tree rather than from a badge in the graph.
     *
     * Which action that means depends on what was right-clicked, and the two are not
     * interchangeable: deleting a branch can strand commits and says so, deleting a tag cannot.
     * The manifest keeps this off remote branches entirely - removing one of those is a push to a
     * server, not a change to this clone, and it does not belong on the same menu as the two that
     * only touch what is here.
     */
    vscode.commands.registerCommand('weft.deleteRef', (node: unknown) => {
      const target = refs.targetOf(node);

      if (target === null || target.refKind === 'remote') {
        return;
      }

      const panel = WeftPanel.any();

      if (panel === null) {
        void vscode.window.showInformationMessage('Weft: open the graph first.');
        return;
      }

      panel.runTargetAction(target.refKind === 'tag' ? 'weft.deleteTag' : 'weft.deleteBranch', {
        kind: 'ref',
        ...target,
      });
    }),

    vscode.commands.registerCommand('weft.showAllAuthors', () => authors.showAll()),

    /*
     * One gesture for every filter there is, wherever it was set - the two sidebar views and the
     * graph's own search and date range. With no graph open there is nothing to reload, so the two
     * views clear themselves the ordinary way.
     */
    vscode.commands.registerCommand('weft.clearFilters', () => {
      const panel = WeftPanel.active();

      if (panel === null) {
        refs.showAll();
        authors.showAll();
        return;
      }

      return panel.clearFilters();
    }),

    vscode.commands.registerCommand('weft.filesAsTree', () => files.setAsTree(true)),
    vscode.commands.registerCommand('weft.filesAsList', () => files.setAsTree(false)),

    /*
     * Clicking a file opens its diff. The node arrives from the tree item rather than an index into
     * a list, so there is no way for the two to drift out of step with each other.
     */
    /*
     * One file's history. The path comes from the node the tree hands over rather than from
     * anything typed, which matters more than usual: `--follow` will not take a case-insensitive
     * pathspec, so the spelling has to be git's own.
     */
    vscode.commands.registerCommand('weft.showFileHistory', (node: unknown) => {
      const target = files.target(node);
      const panel = WeftPanel.any();

      if (target === null) {
        return;
      }

      if (panel === null) {
        void vscode.window.showInformationMessage('Weft: open the graph first.');
        return;
      }

      panel.showFileHistory(target.file.path);
    }),

    vscode.commands.registerCommand('weft.openCommitFile', async (node: unknown) => {
      const target = files.target(node);

      if (target !== null) {
        await openFileDiff(target.repo, target.subject, target.file);
      }
    }),

    /*
     * A tree view cannot host a text field, so the query is typed into one of VS Code's own inputs.
     * A quick pick rather than an input box, for two reasons: it offers the ref names as you type
     * instead of asking you to remember them, and it can react to every keystroke - so the list in
     * the sidebar narrows live behind it rather than only once you press Enter.
     */
    vscode.commands.registerCommand('weft.filterRefs', () => {
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

    vscode.commands.registerCommand('weft.stash', () => repoAction('weft.stashPush')),

    /*
     * Fetch, pull and push, whose command ids are their action ids. Force push is deliberately not
     * among the title-bar buttons: it is the one action here that can destroy work living only on
     * someone else's clone, and a button for it one pixel from Push is an accident waiting to
     * happen. The command palette is far enough away to be a decision.
     */
    ...['weft.fetch', 'weft.pull', 'weft.push', 'weft.pushForce', 'weft.manageRemotes'].map((id) =>
      vscode.commands.registerCommand(id, () => repoAction(id)),
    ),

    vscode.commands.registerCommand('weft.refresh', () => {
      const panel = WeftPanel.active();

      if (panel === null) {
        void vscode.window.showInformationMessage('Weft: no graph is open.');
        return;
      }

      panel.refresh();
    }),

    vscode.commands.registerCommand('weft.showGitLog', () => output?.show()),
  );

  /*
   * One click to the graph itself. Weft's two views sit in Source Control, and a view container
   * opens views rather than running commands, so the status bar is what gets you straight to the
   * thing you came for.
   *
   * It is hidden in workspaces with no repository, because an entry point to something that cannot
   * open is worse than no entry point.
   */
  const statusBar = vscode.window.createStatusBarItem(
    'weft.open',
    vscode.StatusBarAlignment.Left,
    100,
  );

  statusBar.name = 'Weft';
  statusBar.text = '$(git-branch) Weft';
  statusBar.tooltip = 'Open the Weft commit graph';
  statusBar.command = 'weft.openGraph';
  context.subscriptions.push(statusBar);

  /*
   * Does this workspace have a repository at all?
   *
   * Two things hang off the answer: the status bar entry, and whether Weft's two views appear in
   * Source Control. A workspace with nothing to graph should not carry two collapsed sections under
   * someone else's changes list - Weft is a guest in that container now, not the owner of its own.
   */
  const updatePresence = async (): Promise<void> => {
    const repo = await findRepository(git);

    await vscode.commands.executeCommand('setContext', 'weft.hasRepository', repo !== null);

    const enabled = vscode.workspace
      .getConfiguration('weft')
      .get<boolean>('statusBar.enabled', true);

    if (repo === null || !enabled) {
      statusBar.hide();
    } else {
      statusBar.show();
    }

    /*
     * Populate the views here rather than waiting for the graph, so a section that has only just
     * appeared - after a `git init`, say - is not an empty room when it is first expanded.
     *
     * A graph that is already open owns them: the panel draws itself through their filters, so
     * re-pointing them at another repository underneath it would filter a history by refs it has
     * never heard of.
     */
    if (WeftPanel.active() === null) {
      authors.setRepository(repo);
      await refs.setRepository(repo);
    }
  };

  /*
   * The git extension announces repositories one at a time, so a window opened on four of them
   * would otherwise pay for four discovery passes in a row to arrive at the same answer.
   */
  let pending: NodeJS.Timeout | null = null;

  const schedulePresenceUpdate = (): void => {
    if (pending !== null) {
      clearTimeout(pending);
    }

    pending = setTimeout(() => {
      pending = null;
      void updatePresence();
    }, 200);
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(schedulePresenceUpdate),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('weft.statusBar.enabled')) {
        schedulePresenceUpdate();
      }
    }),
    watchRepositories(schedulePresenceUpdate),
    {
      dispose() {
        if (pending !== null) {
          clearTimeout(pending);
          pending = null;
        }
      },
    },
  );

  void updatePresence();

  output?.info('Weft activated');
}

export function deactivate(): void {
  output = undefined;
}
