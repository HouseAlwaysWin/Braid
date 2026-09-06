/**
 * The built-in git extension, used only for the things it notices before Weft could.
 *
 * Weft runs the git CLI itself and does not want an intermediary, but VS Code's own git extension
 * is already polling: it knows when a repository is opened and when the working tree changes, and
 * both are events Weft has no way to generate for itself. `RepoWatcher` watches `.git`, which is
 * exactly right for refs and exactly wrong for a file being saved.
 *
 * Nothing here is load-bearing. The API is exported but effectively unversioned, so every path
 * through this module ends in "then there is one fewer trigger", never in an error.
 */

import * as vscode from 'vscode';

interface Repository {
  readonly rootUri: vscode.Uri;
  readonly state: { readonly onDidChange: vscode.Event<unknown> };
}

interface GitApi {
  readonly repositories: readonly Repository[];
  readonly onDidOpenRepository: vscode.Event<Repository>;
  readonly onDidCloseRepository: vscode.Event<Repository>;
}

/** The git extension's API, activating it if VS Code has not got round to it yet. */
async function api(): Promise<GitApi | null> {
  try {
    const extension = vscode.extensions.getExtension<{ getAPI(version: number): GitApi }>('vscode.git');

    if (extension === undefined) {
      return null;
    }

    return (extension.isActive ? extension.exports : await extension.activate()).getAPI(1);
  } catch {
    // Disabled, or the shape moved. Either way there is nothing to subscribe to.
    return null;
  }
}

/** Collects subscriptions that may not exist yet, and disposes whatever arrived by the time it is. */
function pending(work: (add: (subscription: vscode.Disposable) => void) => Promise<void>): {
  dispose(): void;
} {
  const subscriptions: vscode.Disposable[] = [];
  let disposed = false;

  void work((subscription) => {
    if (disposed) {
      subscription.dispose();
    } else {
      subscriptions.push(subscription);
    }
  });

  return {
    dispose() {
      disposed = true;

      for (const subscription of subscriptions) {
        subscription.dispose();
      }
    },
  };
}

/**
 * Call `onChange` when a repository is opened or closed.
 *
 * Weft's own discovery is a filesystem walk with nothing to subscribe to, so a repository that
 * appears after startup - a `git init`, or a clone into a folder that is already open - would
 * otherwise stay invisible until the window is reloaded, and the Source Control sections with it.
 */
export function watchRepositories(onChange: () => void): { dispose(): void } {
  return pending(async (add) => {
    const git = await api();

    if (git === null) {
      return;
    }

    add(git.onDidOpenRepository(onChange));
    add(git.onDidCloseRepository(onChange));
  });
}

/**
 * Call `onChange` when the working tree of `root` changes.
 *
 * This is the one thing `RepoWatcher` cannot see. It watches `.git`, because that is where a ref
 * moving shows up and watching a whole worktree would mean an event per keystroke of an editor's
 * autosave - but it means saving a file moves nothing it is looking at, and the row that stands for
 * the working tree would sit there stale until something else happened to cause a reload.
 *
 * The git extension is already running `git status` on its own debounce. Listening costs nothing
 * and inherits the debounce.
 */
export function watchWorkingTree(root: string, onChange: () => void): { dispose(): void } {
  return pending(async (add) => {
    const git = await api();

    if (git === null) {
      return;
    }

    const wanted = root.replace(/\\/g, '/').toLowerCase();
    const matches = (repository: Repository): boolean =>
      repository.rootUri.fsPath.replace(/\\/g, '/').toLowerCase() === wanted;

    for (const repository of git.repositories) {
      if (matches(repository)) {
        add(repository.state.onDidChange(onChange));
      }
    }

    // The repository may not be open yet - Weft finds repositories the git extension has not been
    // asked about, and a bare one it will never open at all.
    add(
      git.onDidOpenRepository((repository) => {
        if (matches(repository)) {
          add(repository.state.onDidChange(onChange));
        }
      }),
    );
  });
}
