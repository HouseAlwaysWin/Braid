/**
 * Loads the built extension with a stubbed `vscode` module and drives it end to end.
 *
 * This is the check that "it fails to load" and "the command is dead" cannot survive. It exercises
 * the real CommonJS bundle VS Code will require, calls `activate`, invokes `weft.openGraph`, and
 * replays the webview handshake - so everything except VS Code's own chrome is covered before
 * anyone presses F5.
 *
 *   node scripts/load-check.mjs [repo]
 */
import { createRequire } from 'node:module';
import Module from 'node:module';
import { resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const watchTest = process.argv.includes('--watch');
const given = process.argv.slice(2).find((a) => !a.startsWith('--'));

/** A throwaway repository, so the watcher test can commit into it without touching anything real. */
function makeTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'weft-watch-')).split('\\').join('/');
  runGit(dir, 'init', '-q', '-b', 'main');
  runGit(dir, 'config', 'user.name', 'Weft Test');
  runGit(dir, 'config', 'user.email', 'test@example.invalid');
  runGit(dir, 'config', 'commit.gpgsign', 'false');
  runGit(dir, 'config', 'core.autocrlf', 'false');

  for (const n of [1, 2, 3]) {
    commitInto(dir, n);
  }

  // A second author, so filtering by one of them has something to remove.
  runGit(dir, 'config', 'user.name', 'Someone Else');
  runGit(dir, 'config', 'user.email', 'else@example.invalid');
  commitInto(dir, 4);
  runGit(dir, 'config', 'user.name', 'Weft Test');
  runGit(dir, 'config', 'user.email', 'test@example.invalid');

  // A side branch with a commit of its own, so the ref filter has something to remove.
  runGit(dir, 'checkout', '-q', '-b', 'side');
  commitInto(dir, 9);
  runGit(dir, 'checkout', '-q', 'main');

  // A tag, so the Branches & Tags section has all three kinds of ref in it. Without one, anything
  // asking what a tag looks like gets the group node above it and quietly checks the wrong thing.
  runGit(dir, 'tag', 'v1.0');

  return dir;
}

function runGit(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

function commitInto(dir, n) {
  writeFileSync(join(dir, 'f' + n + '.txt'), 'content ' + n + '\n');
  runGit(dir, 'add', '-A');
  runGit(dir, 'commit', '-q', '-m', 'commit ' + n);
}

const repoPath = given ?? makeTempRepo();

/** `--break-view=<id>`: make one view id unknown, the way a stale manifest does. */
const breakView = process.argv.find((a) => a.startsWith('--break-view='))?.slice('--break-view='.length) ?? null;

const commands = new Map();
const posted = [];
const outputLines = [];
let messageHandler = null;
let panelCreated = null;
const problems = [];
const contentProviders = new Map();
const diffsOpened = [];
const contextKeys = new Map();
const copied = [];
const confirmations = [];
const progressTitles = [];
const statusMessages = [];

/** Whether the stub says yes to a confirmation. A run needs both answers to prove a refusal. */
let confirmed = true;

/*
 * Settings, so that a default is not the only value any of them can have. Every `get` used to
 * return the fallback it was handed, which meant the branches behind a non-default - a hidden
 * status bar, a timer that is switched on - could not be reached at all.
 */
const settings = new Map();

/*
 * Intervals, recorded rather than scheduled. The one interval Braid sets is the auto-fetch, whose
 * shortest period is a minute; a test cannot wait for it, but it can insist that asking for five
 * minutes schedules five minutes and asking for none schedules nothing.
 */
const intervals = [];
const realSetInterval = globalThis.setInterval;

globalThis.setInterval = (fn, ms, ...rest) => {
  intervals.push({ ms, fn });
  return { stub: true, ms };
};

globalThis.clearInterval = (handle) => {
  if (handle?.stub !== true) {
    return realSetInterval === undefined ? undefined : clearTimeout(handle);
  }

  return undefined;
};

let statusBarItem = null;
let viewStateHandler = null;
let disposeHandler = null;
let panelObject = null;
let quickPick = null;

/**
 * What VS Code does to checkboxes when the extension has not claimed them.
 *
 * Unless `manageCheckboxStateManually` is set, the tree view owns checkbox state and reads a ticked
 * parent as "every child is ticked", driving them all back on at the next render. A stub that never
 * did this is a stub in a state real VS Code is never in - and it is how a provider that reports a
 * group as ticked whenever *any* of its refs are showing passed here while putting the tick
 * straight back on screen.
 */
function propagateCheckboxes(id) {
  const provider = treeProviders.get(id);
  const handler = checkboxHandlers.get(id);

  if (provider === undefined || handler === undefined || treeViewOptions.get(id)?.manageCheckboxStateManually === true) {
    return;
  }

  for (const parent of provider.getChildren()) {
    const children = provider.getChildren(parent);

    if (children.length > 0) {
      const state = provider.getTreeItem(parent).checkboxState;
      handler({ items: children.map((child) => [child, state]) });
    }
  }
}

/** Drive the ref filter picker the way a user would: type, then accept. */
async function typeIntoRefFilter(text) {
  await commands.get('weft.filterRefs')();
  quickPick.picker.value = text;
  quickPick.handlers.change?.(text);
  quickPick.handlers.accept?.();
}
const treeProviders = new Map();
const treeViewOptions = new Map();
const checkboxHandlers = new Map();
const treeViews = new Map();

class StubEmitter {
  constructor() { this.listeners = []; }
  get event() { return (fn) => { this.listeners.push(fn); return { dispose() {} }; }; }
  fire(v) { for (const l of [...this.listeners]) l(v); }
  dispose() {}
}

/** The built-in git extension, which is where Weft learns about things it cannot watch itself. */
const repositoryState = new StubEmitter();
const repositoryOpened = new StubEmitter();
const repositoryClosed = new StubEmitter();

/** Settings changing, which nothing here could make happen before. */
const configurationChanged = {
  listeners: [],
  fire(changed) {
    for (const fn of [...this.listeners]) {
      fn({ affectsConfiguration: (key) => changed.some((c) => c === key || key.startsWith(c)) });
    }
  },
};

const uri = (p) => ({
  fsPath: p,
  scheme: 'file',
  path: p,
  toString: () => `file://${p}`,
});

const vscodeStub = {
  Uri: {
    file: uri,
    joinPath: (base, ...parts) => uri([base.fsPath, ...parts].join('/')),
    from: (parts) => ({ ...parts, fsPath: parts.path, toString: () => `${parts.scheme}:${parts.path}?${parts.query ?? ''}` }),
  },
  ViewColumn: { Active: -1, One: 1 },
  commands: {
    registerCommand: (id, fn) => {
      if (commands.has(id)) {
        problems.push(`command registered twice: ${id}`);
      }

      commands.set(id, fn);
      return { dispose() {} };
    },
    executeCommand: async (id, ...args) => {
      if (id === 'vscode.diff') {
        diffsOpened.push({ left: args[0], right: args[1], title: args[2] });
      }
      if (id === 'setContext') {
        contextKeys.set(args[0], args[1]);
      }
      return undefined;
    },
  },
  window: {
    /*
     * A window with a file open, which is the ordinary one. Its path was being handed to git as a
     * working directory - a file is not a directory, Node calls that `spawn git ENOENT`, and the
     * rejection took `weft.hasRepository` with it. Every section in Source Control disappeared,
     * while the graph itself kept working, because opening that has no editor focused.
     */
    activeTextEditor: { document: { uri: uri(repoPath.replace(/\\/g, '/') + '/f1.txt') } },
    createOutputChannel: () => ({
      info: (m) => outputLines.push(`info  ${m}`),
      warn: (m) => outputLines.push(`warn  ${m}`),
      error: (m) => outputLines.push(`error ${m}`),
      debug: (m) => outputLines.push(`debug ${m}`),
      show() {},
      dispose() {},
    }),
    showInformationMessage: (m) => problems.push(`unexpected info message: ${m}`),
    /*
     * A warning with buttons is a confirmation, and this answers it with the first one - which is
     * how a user gets past `ui.confirm`. Until this existed every confirmation returned undefined,
     * every tier-2 action read that as "cancelled", and nothing that asks before it acts had ever
     * run to completion here.
     *
     * A warning with no buttons is still nobody's plan, and still a failure.
     */
    showWarningMessage: async (m, options, ...choices) => {
      if (choices.length === 0) {
        problems.push(`unexpected warning: ${m}`);
        return undefined;
      }

      confirmations.push({ message: m, detail: options?.detail ?? '', answered: choices[0] });
      return confirmed ? choices[0] : undefined;
    },
    // Activation reports its own failure through this one, so it has to exist here - and anything
    // arriving on it is a failure by definition.
    showErrorMessage: async (m) => {
      problems.push(`unexpected error message: ${m}`);
      return undefined;
    },
    setStatusBarMessage: (message) => {
      statusMessages.push(message);
      return { dispose() {} };
    },

    /*
     * Runs the work, which is the whole of what a progress notification does that matters here. The
     * token never cancels: nothing in this run is cancelled, and a token that fires would be
     * inventing a user who pressed something.
     */
    withProgress: (options, task) => {
      progressTitles.push(options.title);
      return task({ report() {} }, {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose() {} }),
      });
    },
    createQuickPick: () => {
      const handlers = {};
      const picker = {
        title: '', placeholder: '', value: '', items: [], selectedItems: [],
        matchOnDescription: false, matchOnDetail: false,
        onDidChangeValue: (fn) => { handlers.change = fn; return { dispose() {} }; },
        onDidAccept: (fn) => { handlers.accept = fn; return { dispose() {} }; },
        onDidHide: (fn) => { handlers.hide = fn; return { dispose() {} }; },
        show() { quickPick = { picker, handlers }; },
        hide() { handlers.hide?.(); },
        dispose() {},
      };
      return picker;
    },
    createTreeView: (id, options) => {
      // A stale manifest, on demand: see the self-test below for what this is proving.
      if (breakView === id) throw new Error(`No view is registered with id: ${id}`);
      treeProviders.set(id, options.treeDataProvider);
      treeViewOptions.set(id, options);
      const view = {
        message: undefined,
        onDidChangeCheckboxState: (fn) => { checkboxHandlers.set(id, fn); return { dispose() {} }; },
        dispose() {},
      };
      treeViews.set(id, view);
      return view;
    },
    createStatusBarItem: (id, alignment, priority) => {
      statusBarItem = { id, alignment, priority, visible: false };
      return {
        set name(v) { statusBarItem.name = v; },
        set text(v) { statusBarItem.text = v; },
        set tooltip(v) { statusBarItem.tooltip = v; },
        set command(v) { statusBarItem.command = v; },
        show() { statusBarItem.visible = true; },
        hide() { statusBarItem.visible = false; },
        dispose() {},
      };
    },
    createWebviewPanel: (viewType, title) => {
      panelCreated = { viewType, title };
      return (panelObject = {
        active: true,
        webview: {
          cspSource: 'vscode-webview://stub',
          set html(value) {
            this._html = value;
          },
          get html() {
            return this._html;
          },
          asWebviewUri: (u) => u,
          postMessage: (m) => {
            posted.push(m);
            return Promise.resolve(true);
          },
          onDidReceiveMessage: (fn) => {
            messageHandler = fn;
            return { dispose() {} };
          },
        },
        onDidChangeViewState: (fn) => { viewStateHandler = fn; return { dispose() {} }; },
        onDidDispose: (fn) => { disposeHandler = fn; return { dispose() {} }; },
        reveal() {},
        dispose() {},
      });
    },
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  // Real values, because `ui.progress` reads one of them. Without these every action that reports
  // progress - which is every action that touches the repository - threw before it started.
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  EventEmitter: StubEmitter,
  ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
  ThemeColor: class { constructor(id) { this.id = id; } },
  TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
  workspace: {
    workspaceFolders: [{ uri: uri(repoPath) }],
    getConfiguration: (section) => ({
      get: (key, fallback) => {
        const full = section === undefined ? key : `${section}.${key}`;
        return settings.has(full) ? settings.get(full) : fallback;
      },
    }),
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    onDidChangeConfiguration: (fn) => {
      configurationChanged.listeners.push(fn);
      return { dispose() {} };
    },
    registerTextDocumentContentProvider: (scheme, provider) => {
      contentProviders.set(scheme, provider);
      return { dispose() {} };
    },
  },
  extensions: {
    /*
     * Present and active, which is the ordinary state of a VS Code window. Returning undefined
     * meant `vscodeGit.ts` never got past its first null check - so neither the repository events
     * that make the Source Control sections appear after a `git init`, nor the working-tree events
     * the uncommitted row keeps up with, had ever run a line here.
     */
    getExtension: (id) =>
      id === 'vscode.git'
        ? {
            isActive: true,
            exports: {
              getAPI: () => ({
                repositories: [
                  {
                    rootUri: uri(repoPath.replace(/\\/g, '/')),
                    state: { onDidChange: repositoryState.event },
                  },
                ],
                onDidOpenRepository: repositoryOpened.event,
                onDidCloseRepository: repositoryClosed.event,
              }),
            },
          }
        : undefined,
  },
  env: { clipboard: { writeText: async (text) => void copied.push(text) } },
};

// The bundle does `require('vscode')`, which only exists inside the extension host.
const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeStub;
  }

  return originalLoad.call(this, request, parent, isMain);
};

/*
 * This runs the built bundle, not the sources, so a stale dist/ silently checks the wrong code -
 * which has already cost one round of "but I fixed that". `npm test` builds first; a direct run
 * might not have.
 */
{
  const bundle = statSync(resolve('dist/extension.js'), { throwIfNoEntry: false });

  if (bundle === undefined) {
    console.error('dist/extension.js is missing - run `npm run build` first.');
    process.exit(1);
  }

  const newest = readdirSync(resolve('src'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => statSync(join(entry.parentPath, entry.name)).mtimeMs)
    .reduce((a, b) => Math.max(a, b), 0);

  if (newest > bundle.mtimeMs) {
    console.error('dist/extension.js is older than src/ - run `npm run build` first.');
    process.exit(1);
  }
}

const require_ = createRequire(import.meta.url);
const extension = require_(resolve('dist/extension.js'));

console.log('exports        :', Object.keys(extension).join(', '));

const memory = new Map();
const context = {
  subscriptions: [],
  extensionUri: uri(resolve('.').replace(/\\/g, '/')),
  globalState: {
    get: (key, fallback) => memory.get(key) ?? fallback,
    update: async (key, value) => void memory.set(key, value),
  },
};
extension.activate(context);

await new Promise((r) => setTimeout(r, 800));

/*
 * Activation is all or nothing: everything below is meaningless if `activate` threw on the way
 * through, and it used to fail without saying so.
 */
if (!outputLines.some((line) => line.includes('Weft activated'))) {
  problems.push('activate() did not run to completion');
}

/*
 * A self-test of the guard around activation, run as its own process with `--break-view=<id>`.
 *
 * It reproduces a window whose manifest is older than its code - `createTreeView` throwing for a
 * view that window has never heard of - which is how adding a view and not restarting the
 * Extension Development Host used to look: no commands, no `weft.hasRepository`, all three
 * Source Control sections gone, and not a word about any of it.
 */
if (breakView !== null) {
  const logged = outputLines.some((line) => line.includes('Weft failed to activate'));
  const shown = problems.some((p) => p.includes('unexpected error message'));

  console.log('broken view    :', breakView, '|', logged ? 'logged' : 'NOT LOGGED', '|', shown ? 'shown to the user' : 'NOT SHOWN');

  if (!logged || !shown) {
    console.error('\nFAILED: a failed activation said nothing.');
    process.exit(1);
  }

  console.log('\nOK - a failed activation reports itself.');
  process.exit(0);
}

console.log('commands       :', [...commands.keys()].join(', '));
console.log('status bar     :', statusBarItem === null ? 'NOT CREATED' : JSON.stringify({ text: statusBarItem.text, command: statusBarItem.command, visible: statusBarItem.visible }));

if (statusBarItem === null) {
  problems.push('no status bar item was created');
} else {
  if (statusBarItem.command !== 'weft.openGraph') problems.push('status bar item runs the wrong command: ' + statusBarItem.command);
  if (!statusBarItem.visible) problems.push('status bar item stayed hidden in a real repository');
}

/*
 * The two Source Control sections are contributed with `when: weft.hasRepository`, so this key is
 * the whole of their visibility. A key that never arrives is an extension with no sidebar at all,
 * and nothing else in this run would notice.
 */
console.log('context keys   :', JSON.stringify(Object.fromEntries(contextKeys)));

if (contextKeys.get('weft.hasRepository') !== true) {
  problems.push('weft.hasRepository was not set in a real repository (is a file being used as a working directory?)');
}

/*
 * And it found it on the first try. Surviving a bad candidate is the safety net; not producing one
 * is the fix - the open file's *folder* is what git can be run in, and the file itself is not.
 */
const unusable = outputLines.filter((line) => line.includes('not a usable folder'));

if (unusable.length > 0) {
  problems.push(`discovery was handed something it could not use: ${unusable[0]}`);
}

console.log('subscriptions  :', context.subscriptions.length);

/*
 * Every contributed command must actually be registered. Read from package.json rather than a list
 * kept here, because the failure this catches is exactly a list going stale: `weft.refresh` once
 * shipped in the manifest with nothing behind it, and a hand-maintained expectation would have to
 * be updated by the same person who forgot the registration.
 */
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const contributed = manifest.contributes.commands.map((entry) => entry.command);

console.log('contributed    :', contributed.length, 'commands');

for (const expected of contributed) {
  if (!commands.has(expected)) {
    problems.push(`contributed but never registered: ${expected}`);
  }
}

/*
 * The same staleness the other way round. A tree view created in code but contributed to no
 * container has nowhere to appear, and since Weft gave up its own Activity Bar container there is
 * no second home to fall back to - it would simply never be seen, silently.
 */
const scmViews = (manifest.contributes.views?.scm ?? []).map((view) => view.id);

console.log('scm views      :', scmViews.join(', ') || 'NONE');

for (const id of treeViews.keys()) {
  if (!scmViews.includes(id)) {
    problems.push(`tree view is not contributed to Source Control: ${id}`);
  }
}

await commands.get('weft.openGraph')();

if (panelCreated === null) {
  problems.push('weft.openGraph did not create a webview panel');
} else {
  console.log('panel          :', panelCreated.viewType, '/', panelCreated.title);
}

// The webview announces itself once its script loads; that is what starts the history walk.
if (messageHandler === null) {
  problems.push('panel never subscribed to webview messages');
} else {
  messageHandler({ type: 'ready', search: null, dates: null, firstParent: false });

  // The panel deliberately does not await its own message handler - VS Code's event emitter has
  // nowhere to put the promise - so poll for the terminal message rather than awaiting the call.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !posted.some((m) => m.type === 'done' || m.type === 'error')) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

// Selecting a commit is the other half of the product: details, file list, and a diff to open.
const firstPage = posted.find((m) => m.type === 'page');
const sampleSha = firstPage?.rows?.[0]?.sha;

if (sampleSha === undefined) {
  problems.push('no commit available to select');
} else {
  messageHandler({ type: 'selectCommit', sha: sampleSha });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !posted.some((m) => m.type === 'details')) {
    await new Promise((r) => setTimeout(r, 25));
  }

  const details = posted.find((m) => m.type === 'details')?.details;

  if (details === undefined) {
    problems.push('selecting a commit produced no details');
  } else {
    console.log('details        :', details.sha.slice(0, 8));
    console.log('  message      :', JSON.stringify(details.body.split('\n')[0]?.slice(0, 60)));

    if (details.body.length === 0) {
      problems.push('commit message came back empty');
    }

    // The files go to Source Control instead. Sending them here as well would be paying twice.
    if ('files' in details) {
      problems.push('the details message still carries the file list');
    }
  }
}

/*
 * The changed files reach the user through the Commit Files section now, so that is where they get
 * checked: its provider is the only thing standing between a `git show` and the sidebar.
 */
const filesProvider = treeProviders.get('weft.files');
const filesView = treeViews.get('weft.files');
const fileNodes = [];

if (filesProvider === undefined) {
  problems.push('no tree provider was registered for weft.files');
} else {
  const walk = (nodes) => {
    for (const node of nodes) {
      if (node.kind === 'file') {
        fileNodes.push(node);
      } else {
        walk(filesProvider.getChildren(node));
      }
    }
  };

  walk(filesProvider.getChildren());

  console.log('commit files   :', fileNodes.length, '|', filesView?.description ?? 'NO DESCRIPTION');

  for (const node of fileNodes.slice(0, 3)) {
    const item = filesProvider.getTreeItem(node);
    console.log(`  ${node.file.status} ${item.label}${item.description === undefined ? '' : ` (${item.description})`}`);
  }

  if (fileNodes.length === 0) {
    problems.push('the commit files section is empty for a commit that changed files');
  }

  if (fileNodes.some((n) => n.file.newBlob === null && n.file.status !== 'D')) {
    problems.push('a non-deleted file has no blob to diff against');
  }

  // Flat reaches the same files by another route; a mode that loses rows is a bug either way.
  await commands.get('weft.filesAsList')();
  const flat = filesProvider.getChildren();
  await commands.get('weft.filesAsTree')();

  if (flat.length !== fileNodes.length) {
    problems.push(`flat view shows ${flat.length} files, tree view ${fileNodes.length}`);
  }
}

// Opening a diff has to survive the whole chain: raw record -> blob OID -> URI -> content provider.
const firstFile = fileNodes[0];

if (firstFile !== undefined) {
  await commands.get('weft.openCommitFile')(firstFile);

  const opened = diffsOpened[0];

  if (opened === undefined) {
    problems.push('opening a file produced no diff');
  } else {
    const provider = contentProviders.get('weft-git');
    console.log('diff           :', opened.title);
    console.log('  right uri    :', opened.right.path);

    if (provider === undefined) {
      problems.push('no content provider was registered for weft-git');
    } else {
      const text = await provider.provideTextDocumentContent(opened.right);
      const left = await provider.provideTextDocumentContent(opened.left);
      console.log('  content      :', text.length, 'chars (was', left.length + ')');

      if (text.length === 0 && firstFile.file.newBlob !== null) {
        problems.push('the diff resolved to empty content for a file that exists');
      }
    }

    if (!/\.[A-Za-z0-9]+$/.test(opened.right.path)) {
      problems.push(`diff URI has no file extension, so VS Code cannot pick a language: ${opened.right.path}`);
    }
  }
}

const kinds = posted.reduce((acc, m) => ({ ...acc, [m.type]: (acc[m.type] ?? 0) + 1 }), {});
const done = posted.find((m) => m.type === 'done');
const rows = posted.filter((m) => m.type === 'page').reduce((n, m) => n + m.rows.length, 0);

console.log('posted         :', JSON.stringify(kinds));
console.log('rows delivered :', rows);
console.log('done           :', done ? `${done.total} commits in ${done.elapsedMs}ms` : 'MISSING');

for (const m of posted) {
  if (m.type === 'error') {
    problems.push(`extension reported an error: ${m.message}`);
  }
}

if (rows === 0) {
  problems.push('no rows were delivered to the webview');
}

if (done === undefined) {
  problems.push('the load never completed');
}

// Search has to actually narrow the result, and an impossible query has to come back empty rather
// than silently falling back to the full history.
{
  const baseline = done?.total ?? 0;

  const runSearch = async (search) => {
    const from = posted.filter((m) => m.type === 'done').length;
    messageHandler({ type: 'search', search });

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const dones = posted.filter((m) => m.type === 'done');
      if (dones.length > from) {
        return dones[dones.length - 1].total;
      }

      await new Promise((r) => setTimeout(r, 25));
    }

    return null;
  };

  const plain = { regex: false, caseSensitive: false, allTerms: false, invert: false, follow: false };
  const impossible = await runSearch({ query: 'zzz-no-such-commit-zzz', mode: 'message', ...plain });
  console.log('search (miss)  :', impossible, 'of', baseline);

  if (impossible !== 0) {
    problems.push(`a query matching nothing returned ${impossible} commits`);
  }

  const cleared = await runSearch(null);
  console.log('search cleared :', cleared, 'of', baseline);

  /*
   * The date filter, end to end. The fixture was committed a moment ago, so a window that ends
   * yesterday must be empty and one that starts today must hold everything - and the arguments in
   * between have to survive `--since-as-filter` on a new git and `--since` on an old one.
   */
  const runDates = async (range) => {
    const from = posted.filter((m) => m.type === 'done').length;
    messageHandler({ type: 'dates', range });

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const dones = posted.filter((m) => m.type === 'done');
      if (dones.length > from) {
        return dones[dones.length - 1].total;
      }

      await new Promise((r) => setTimeout(r, 25));
    }

    return null;
  };

  const dayOf = (offset) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const todayOnly = await runDates({ since: dayOf(0), until: null });
  const beforeToday = await runDates({ since: null, until: dayOf(-1) });
  const noRange = await runDates(null);

  console.log('dates today    :', todayOnly, '| ended yesterday:', beforeToday, '| cleared:', noRange, '| of', baseline);

  if (todayOnly !== baseline) {
    problems.push(`a range starting today lost ${baseline - todayOnly} of ${baseline} commits made today`);
  }

  if (beforeToday !== 0) {
    problems.push(`a range ending yesterday returned ${beforeToday} commits made today`);
  }

  if (noRange !== baseline) {
    problems.push(`clearing the date range left ${noRange} of ${baseline} commits`);
  }

  if (cleared !== baseline) {
    problems.push(`clearing the search gave ${cleared} commits, expected ${baseline}`);
  }
}

/*
 * Right-click. The menu is built by the host from repository state, so this exercises the round
 * trip and the availability rules, not merely that something appears.
 */
{
  const ask = async (label) => {
    const before = posted.filter((m) => m.type === 'menu').length;

    messageHandler({
      type: 'requestMenu',
      target: { kind: 'ref', refName: `refs/heads/${label}`, label, refKind: 'local' },
      x: 10,
      y: 10,
    });

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && posted.filter((m) => m.type === 'menu').length === before) {
      await new Promise((r) => setTimeout(r, 25));
    }

    const menus = posted.filter((m) => m.type === 'menu');
    return menus[menus.length - 1];
  };

  const onSide = await ask('side');
  const onCurrent = await ask('main');

  console.log('\nmenu (side)    :', JSON.stringify(onSide?.items));
  console.log('menu (current) :', JSON.stringify(onCurrent?.items?.map((i) => i.disabledReason)));

  if (onSide?.items?.[0]?.id !== 'weft.checkoutBranch') {
    problems.push('right-clicking a branch did not offer checkout');
  }

  if (onSide?.items?.[0]?.disabledReason !== null) {
    problems.push(`checkout was unavailable on another branch: ${onSide?.items?.[0]?.disabledReason}`);
  }

  if (onCurrent?.items?.[0]?.disabledReason !== 'Already checked out') {
    problems.push('checkout was offered for the branch that is already checked out');
  }
}

/*
 * Ref filtering has to be a real filter, not a display trick: unticking refs must narrow what
 * `git log` walks, so the commit count actually drops.
 */
const treeProvider = treeProviders.get('weft.refs');
const checkboxHandler = checkboxHandlers.get('weft.refs');
const treeView = treeViews.get('weft.refs');

if (treeProvider !== undefined && checkboxHandler !== undefined) {
  const groups = treeProvider.getChildren();
  const allRefs = groups.flatMap((g) => treeProvider.getChildren(g));

  console.log(
    '\nrefs sidebar   :',
    groups.map((g) => `${g.label} (${treeProvider.getChildren(g).length})`).join(', '),
  );
  console.log('  message      :', JSON.stringify(treeView?.message));
  console.log(
    '  collapsed    :',
    groups.every((g) => treeProvider.getTreeItem(g).collapsibleState === 1),
  );

  if (!groups.every((g) => treeProvider.getTreeItem(g).collapsibleState === 1)) {
    problems.push('ref groups are not collapsed by default');
  }

  if (typeof treeView?.message !== 'string' || treeView.message.length === 0) {
    problems.push('the refs view never explains what its checkboxes do');
  }

  const baseline = done?.total ?? 0;
  const keep = allRefs.find((r) => r.label === 'main' || r.label === 'master') ?? allRefs[0];

  if (keep === undefined) {
    problems.push('the refs sidebar listed nothing');
  } else {
    const before = posted.filter((m) => m.type === 'done').length;
    checkboxHandler({ items: allRefs.filter((r) => r !== keep).map((r) => [r, 0]) });

    const deadline = Date.now() + 20_000;
    let narrowed = null;

    while (Date.now() < deadline) {
      const dones = posted.filter((m) => m.type === 'done');
      if (dones.length > before) {
        narrowed = dones[dones.length - 1];
        break;
      }

      await new Promise((r) => setTimeout(r, 25));
    }

    if (narrowed === null) {
      problems.push('unticking refs did not reload the graph');
    } else {
      console.log(`kept only      : ${keep.label}`);
      console.log(`commits        : ${baseline} -> ${narrowed.total}`);
      console.log('  message now  :', JSON.stringify(treeView?.message));

      // Once the user has found the gesture, the line should report rather than keep instructing.
      if (treeView?.message?.includes('Untick') === true) {
        problems.push('the refs view still explains the gesture after it has been used');
      }

      if (narrowed.total >= baseline) {
        problems.push(`filtering to one ref did not narrow the walk (${narrowed.total} of ${baseline})`);
      }

      // And putting them back must restore the full history.
      const beforeRestore = posted.filter((m) => m.type === 'done').length;
      await commands.get('weft.showAllRefs')();

      const restoreDeadline = Date.now() + 20_000;
      let restored = null;

      while (Date.now() < restoreDeadline) {
        const dones = posted.filter((m) => m.type === 'done');
        if (dones.length > beforeRestore) {
          restored = dones[dones.length - 1];
          break;
        }

        await new Promise((r) => setTimeout(r, 25));
      }

      console.log(`show all       : ${restored === null ? 'NO RELOAD' : restored.total}`);

      if (restored === null || restored.total !== baseline) {
        problems.push('Show All Branches & Tags did not restore the full history');
      }
    }
  }
} else {
  problems.push('no refs tree view was registered');
}

/*
 * The two sidebar filters. They do different jobs and both are worth proving: the ref filter
 * narrows the *listing*, the author filter narrows what git *walks*.
 */
{
  const before = treeProvider.getChildren().flatMap((g) => treeProvider.getChildren(g)).length;

  await typeIntoRefFilter('side');
  const filtered = treeProvider.getChildren().flatMap((g) => treeProvider.getChildren(g));

  console.log(`\nref filter     : ${before} refs -> ${filtered.length} matching "side"`);
  console.log('  message      :', JSON.stringify(treeView?.message));

  if (filtered.length >= before || filtered.length === 0) {
    problems.push(`the ref filter did not narrow the listing (${before} -> ${filtered.length})`);
  }

  if (treeView?.message?.includes('side') !== true) {
    problems.push('the refs view does not say a filter is applied');
  }

  // A group with a match opens itself; matches behind a closed chevron help nobody.
  const groups = treeProvider.getChildren();
  if (!groups.every((g) => treeProvider.getTreeItem(g).collapsibleState === 2)) {
    problems.push('a filtered group did not expand to show its matches');
  }

  await typeIntoRefFilter('');

  if (treeProvider.getChildren().flatMap((g) => treeProvider.getChildren(g)).length !== before) {
    problems.push('clearing the ref filter did not restore the listing');
  }

  // The picker offers the ref names, which is the point of it being a picker.
  await commands.get('weft.filterRefs')();
  const offered = quickPick.picker.items.map((item) => item.label);
  console.log('  completions  :', offered.join(', '));

  if (offered.length !== before) {
    problems.push(`the picker offered ${offered.length} refs, expected ${before}`);
  }

  // Picking one filters to exactly it, rather than to whatever was typed.
  quickPick.picker.selectedItems = [quickPick.picker.items.find((i) => i.label === 'side')];
  quickPick.handlers.accept?.();

  if (treeProvider.getChildren().flatMap((g) => treeProvider.getChildren(g)).length !== 1) {
    problems.push('picking a ref did not filter to it');
  }

  // Escape has to undo the live filtering, or cancelling would still change something.
  await commands.get('weft.filterRefs')();
  quickPick.handlers.change?.('nothing-matches-this');
  quickPick.handlers.hide?.();

  const afterEscape = treeProvider.getChildren().flatMap((g) => treeProvider.getChildren(g)).length;
  console.log(`  escape       : back to filtering "side" (${afterEscape} ref)`);

  if (afterEscape !== 1) {
    problems.push(`escaping the picker left the filter changed (${afterEscape} refs listed)`);
  }

  /*
   * "Show all" has to clear the text filter too. It used to clear only the unticked refs, and to
   * return early when nothing was unticked - so with a text filter applied and nothing unticked,
   * which is the ordinary case, the button did nothing at all.
   */
  await typeIntoRefFilter('side');

  const reloadsBefore = posted.filter((m) => m.type === 'done').length;
  await commands.get('weft.showAllRefs')();

  const restored = treeProvider.getChildren().flatMap((g) => treeProvider.getChildren(g)).length;
  console.log(`  show all     : back to ${restored} refs`);

  if (restored !== before) {
    problems.push(`Show All left the text filter applied (${restored} of ${before} refs listed)`);
  }

  // And it should not have re-walked the history: no tick changed, so the graph is unaffected.
  await new Promise((r) => setTimeout(r, 400));

  if (posted.filter((m) => m.type === 'done').length !== reloadsBefore) {
    problems.push('clearing a text-only filter reloaded the graph for nothing');
  }
}

{
  const treeProvider = treeProviders.get('weft.refs');
  const checkboxHandler = checkboxHandlers.get('weft.refs');

  /*
   * A tick has to survive the render that follows it. Weft marks a group as ticked whenever any of
   * its refs are showing, which is not what VS Code means by a ticked parent - so with the
   * checkboxes left in VS Code's hands, unticking one branch was undone before it was seen.
   */
  {
    const groups = treeProvider.getChildren();
    const locals = treeProvider.getChildren(groups.find((g) => g.id === 'heads'));
    const victim = locals.find((ref) => ref.label !== 'main') ?? locals[0];

    checkboxHandler({ items: [[victim, 0]] });
    propagateCheckboxes('weft.refs');

    const stillOff = treeProvider.getTreeItem(victim).checkboxState === 0;

    console.log('  tick sticks  :', victim.label, stillOff ? 'stayed unticked' : 'WAS TICKED BACK ON');

    if (!stillOff) {
      problems.push(`unticking ${victim.label} did not stick: the group's own tick put it back`);
    }

    await commands.get('weft.showAllRefs')();
    await new Promise((r) => setTimeout(r, 500));
  }
}

{
  const treeView = treeViews.get('weft.refs');

  // Counted, not written down. These assertions were two hardcoded 2s until a tag was added to the
  // fixture, at which point they failed for saying nothing about the code.
  const total = treeProviders.get('weft.refs').listRefs().length;

  /*
   * The message has to carry the half that is not on screen. Filtering the list leaves every ref
   * that fell out of it still ticked and still walked - so a line naming only what is listed
   * invites the reader to conclude they are looking at the filter itself, which on a repository
   * with two dozen refs is exactly what happened.
   */
  /*
   * `main` rather than `side`: in this fixture `side` is ahead of `main` and reaches every commit,
   * so narrowing to it narrows nothing - a useless thing to assert a commit count against.
   */
  await typeIntoRefFilter('main');
  const narrowed = treeView?.message ?? '';

  console.log('  says         :', JSON.stringify(narrowed));

  if (!narrowed.includes(`of ${total} refs`)) {
    problems.push(`the message does not say how many refs it is listing: ${narrowed}`);
  }

  if (!narrowed.includes(`still walks all ${total}`)) {
    problems.push(`the message does not say the unlisted refs are still walked: ${narrowed}`);
  }

  // And the one click that makes the graph agree with the list.
  const applyFrom = posted.filter((m) => m.type === 'done').length;
  await commands.get('weft.showOnlyListedRefs')();

  const applyBy = Date.now() + 20_000;
  while (Date.now() < applyBy && posted.filter((m) => m.type === 'done').length === applyFrom) {
    await new Promise((r) => setTimeout(r, 25));
  }

  const applied = posted.filter((m) => m.type === 'done').pop()?.total ?? -1;
  const baseline = posted.filter((m) => m.type === 'done')[0]?.total ?? 0;

  console.log('  applied      :', applied, 'commits from the one ref that was listed');

  if (applied < 0) {
    problems.push('applying the list filter to the graph reloaded nothing');
  }

  if (applied >= baseline && baseline > 0) {
    problems.push(`applying the list filter left ${applied} of ${baseline} commits`);
  }

  await commands.get('weft.showAllRefs')();
  await new Promise((r) => setTimeout(r, 500));

}

{
  const authorsProvider = treeProviders.get('weft.authors');
  const authorsHandler = checkboxHandlers.get('weft.authors');

  if (authorsProvider === undefined || authorsHandler === undefined) {
    problems.push('no authors view was registered');
  } else {
    const authors = await authorsProvider.getChildren();
    console.log(
      '\nauthors        :',
      authors.map((a) => `${a.name} (${a.commits})`).join(', ') || '(none)',
    );

    if (authors.length === 0) {
      problems.push('the authors view listed nobody');
    } else {
      const baseline = posted.filter((m) => m.type === 'done').pop()?.total ?? 0;
      const from = posted.filter((m) => m.type === 'done').length;

      authorsHandler({ items: [[authors[0], 1]] });

      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && posted.filter((m) => m.type === 'done').length === from) {
        await new Promise((r) => setTimeout(r, 25));
      }

      const after = posted.filter((m) => m.type === 'done').pop()?.total ?? -1;
      console.log(`  filtered to  : ${authors[0].name} -> ${after} of ${baseline} commits`);

      if (after >= baseline || after !== authors[0].commits) {
        problems.push(
          `filtering to ${authors[0].name} gave ${after} commits, expected their ${authors[0].commits} of ${baseline}`,
        );
      }

      // Put it back. Leaving a filter on would silently change what every later section is
      // measuring - which is exactly what it did the first time this ran.
      await commands.get('weft.showAllAuthors')();

      const restoreDeadline = Date.now() + 20_000;
      while (
        Date.now() < restoreDeadline &&
        (posted.filter((m) => m.type === 'done').pop()?.total ?? 0) !== baseline
      ) {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
  }
}

/*
 * One gesture, four sources. The filters live in three different places - the graph's search box,
 * its date range, and two tree views in Source Control - and the whole point of the button is that
 * the reader does not have to remember which of them they used. So set all of them, then check that
 * one click puts every one back and the history is whole again.
 */
{
  const refsProvider = treeProviders.get('weft.refs');
  const refsHandler = checkboxHandlers.get('weft.refs');
  const authorsProvider = treeProviders.get('weft.authors');
  const authorsHandler = checkboxHandlers.get('weft.authors');
  const baseline = posted.filter((m) => m.type === 'done').pop()?.total ?? 0;

  const settle = async (from) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && posted.filter((m) => m.type === 'done').length <= from) {
      await new Promise((r) => setTimeout(r, 25));
    }
    return posted.filter((m) => m.type === 'done').pop()?.total ?? -1;
  };

  // A ref unticked, an author ticked, a search, and a date range that ends before the repository.
  const group = refsProvider.getChildren()[0];
  refsHandler({ items: [[refsProvider.getChildren(group)[0], 0]] });
  authorsHandler({ items: [[(await authorsProvider.getChildren())[0], 1]] });
  messageHandler({
    type: 'search',
    search: { query: 'commit', mode: 'message', regex: false, caseSensitive: false, allTerms: false, invert: false, follow: false },
  });
  await settle(posted.filter((m) => m.type === 'done').length - 1);

  const narrowed = await (async () => {
    const from = posted.filter((m) => m.type === 'done').length;
    messageHandler({ type: 'dates', range: { since: null, until: '2001-01-01' } });
    return settle(from);
  })();

  const flagged = posted.filter((m) => m.type === 'reset').pop()?.filtered;
  console.log('\nfilters set    :', narrowed, 'of', baseline, '| reset says filtered:', flagged);

  if (flagged !== true) {
    problems.push('the reset message did not report the graph as filtered');
  }

  const clearedFrom = posted.filter((m) => m.type === 'done').length;
  messageHandler({ type: 'clearFilters' });
  const restored = await settle(clearedFrom);

  const stillFlagged = posted.filter((m) => m.type === 'reset').pop()?.filtered;
  const hiddenRefs = refsProvider.getChildren(group).filter((r) => r.isHidden ?? false).length;

  console.log(
    'filters cleared:',
    restored,
    'of',
    baseline,
    '| view told:',
    posted.some((m) => m.type === 'filtersCleared'),
    '| reset says filtered:',
    stillFlagged,
  );

  if (restored !== baseline) {
    problems.push(`clearing every filter left ${restored} of ${baseline} commits`);
  }

  if (stillFlagged !== false) {
    problems.push('the graph still reports itself as filtered after everything was cleared');
  }

  if (!posted.some((m) => m.type === 'filtersCleared')) {
    problems.push('the view was never told to put its own boxes back');
  }

  if (hiddenRefs !== 0) {
    problems.push(`${hiddenRefs} refs were left unticked after clearing every filter`);
  }
}

/*
 * The auto-refresh check: commit from outside the extension, exactly as the user would from a
 * terminal, and the graph must reload itself without being asked. This is the failure mode the
 * whole watcher exists for.
 */
if (watchTest) {
  const before = posted.filter((m) => m.type === 'done').length;
  const beforeTotal = done?.total ?? 0;

  commitInto(repoPath, 99);
  console.log('\nexternal commit made; waiting for the graph to notice…');

  const started = Date.now();
  const deadline = started + 20_000;
  let reloaded = null;

  while (Date.now() < deadline) {
    const dones = posted.filter((m) => m.type === 'done');
    if (dones.length > before) {
      reloaded = dones[dones.length - 1];
      break;
    }

    await new Promise((r) => setTimeout(r, 50));
  }

  if (reloaded === null) {
    problems.push('an external commit did not trigger a reload');
  } else {
    console.log(`reloaded       : ${Date.now() - started}ms after the commit`);
    console.log(`commits        : ${beforeTotal} -> ${reloaded.total}`);
    console.log('reloading msg  :', posted.some((m) => m.type === 'reloading') ? 'sent' : 'MISSING');

    if (reloaded.total !== beforeTotal + 1) {
      problems.push(`expected ${beforeTotal + 1} commits after the reload, got ${reloaded.total}`);
    }
  }

  // And the opposite: churn that changes no ref must not cost a reload.
  const quietFrom = posted.filter((m) => m.type === 'done').length;
  writeFileSync(join(repoPath, 'untracked.txt'), 'not a commit\n');
  await new Promise((r) => setTimeout(r, 2500));

  if (posted.filter((m) => m.type === 'done').length > quietFrom) {
    problems.push('writing an untracked file triggered a needless reload');
  } else {
    console.log('quiet churn    : ignored, as it should be');
  }
}

/*
 * The sidebar drives the graph from outside it, which is the case the rest of this run cannot see:
 * everything here happens *because* the graph lost focus, and a stub panel that is focused forever
 * is the one state where the bug this covers does not appear.
 *
 * It reloaded `WeftPanel.active()` - the *focused* graph - so ticking a box in Source Control,
 * which is itself the act of unfocusing the graph, reloaded nothing at all.
 */
{
  const refsProvider = treeProviders.get('weft.refs');
  const refsHandler = checkboxHandlers.get('weft.refs');
  const baseline = posted.filter((m) => m.type === 'done').pop()?.total ?? 0;

  // The graph is no longer the focused editor, exactly as it is not when a sidebar is being used.
  if (panelObject !== null && viewStateHandler !== null) {
    panelObject.active = false;
    viewStateHandler();
  }

  const settle = async (from) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && posted.filter((m) => m.type === 'done').length <= from) {
      await new Promise((r) => setTimeout(r, 25));
    }
    return posted.filter((m) => m.type === 'done').pop()?.total ?? -1;
  };

  const groups = refsProvider.getChildren();
  const locals = refsProvider.getChildren(groups.find((g) => g.id === 'heads'));
  const side = locals.find((ref) => ref.label !== 'main') ?? locals[0];

  const from = posted.filter((m) => m.type === 'done').length;
  refsHandler({ items: [[side, 0]] });
  const unticked = await settle(from);

  console.log('\nunfocused graph:', unticked, 'of', baseline, 'after unticking', side.label);

  if (unticked === -1) {
    problems.push('unticking a ref while the graph was unfocused reloaded nothing');
  }

  if (unticked >= baseline) {
    problems.push(`unticking ${side.label} left ${unticked} of ${baseline} commits`);
  }

  await commands.get('weft.showAllRefs')();
  await settle(posted.filter((m) => m.type === 'done').length - 1);

  /*
   * And "show me only this branch", which unticking cannot express: what it narrows is the set of
   * tips git walks *from*, so hiding one branch changes nothing while its commits are still
   * reachable from another - which for a branch that has been merged is always.
   */
  /*
   * `main` rather than `side`: in this fixture `side` is ahead of `main` and reaches every commit,
   * so narrowing to it narrows nothing - which is the very thing that makes unticking the wrong
   * shape for this question, and a useless assertion to hang a test on.
   */
  const trunk = locals.find((ref) => ref.label === 'main') ?? side;
  const onlyFrom = posted.filter((m) => m.type === 'done').length;

  await commands.get('weft.showOnlyRef')(trunk);
  const only = await settle(onlyFrom);

  const shown = refsProvider
    .getChildren()
    .flatMap((g) => refsProvider.getChildren(g))
    .filter((ref) => refsProvider.getTreeItem(ref).checkboxState === 1);

  console.log(
    'show only      :',
    trunk.label,
    '->',
    only,
    'of',
    baseline,
    'commits |',
    shown.length,
    'ref ticked:',
    shown.map((r) => r.label).join(', '),
  );

  if (shown.length !== 1 || shown[0]?.refName !== trunk.refName) {
    problems.push(`Show Only This left ${shown.length} refs ticked, expected just ${trunk.label}`);
  }

  if (only >= baseline) {
    problems.push(`showing only ${trunk.label} left ${only} of ${baseline} commits`);
  }

  await commands.get('weft.showAllRefs')();
  await settle(posted.filter((m) => m.type === 'done').length - 1);

  // Put the focus back, so nothing after this is measuring a different window than it thinks.
  if (panelObject !== null && viewStateHandler !== null) {
    panelObject.active = true;
    viewStateHandler();
  }
}

/*
 * `--first-parent` is two halves - an argument to git and an option to the layout - and only one of
 * them is visible from here. The argument is: every command Weft runs is logged, so the walk can
 * be read back rather than inferred from a commit count that a linear fixture would not change.
 */
{
  const walks = () => outputLines.filter((line) => line.includes('git log'));
  const before = walks().length;

  messageHandler({ type: 'firstParent', on: true });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && walks().length === before) {
    await new Promise((r) => setTimeout(r, 25));
  }

  const mainline = walks().pop() ?? '';
  const flagged = posted.filter((m) => m.type === 'reset').pop()?.filtered;

  console.log('\nfirst parent   :', mainline.includes('--first-parent') ? 'in the walk' : 'MISSING', '| reset says filtered:', flagged);

  if (!mainline.includes('--first-parent')) {
    problems.push('first parent was turned on but the walk did not ask git for it');
  }

  if (flagged !== true) {
    problems.push('walking only the mainline was not counted as filtering');
  }

  const off = walks().length;
  messageHandler({ type: 'firstParent', on: false });

  const restore = Date.now() + 20_000;
  while (Date.now() < restore && walks().length === off) {
    await new Promise((r) => setTimeout(r, 25));
  }

  if ((walks().pop() ?? '').includes('--first-parent')) {
    problems.push('turning first parent off left it on the command line');
  }
}

/*
 * The header's branch menu, and the one piece of state it shares with the sidebar.
 *
 * The menu is a second way into the ticks in Branches & Tags, not a second copy of them. What that
 * has to mean is checked from both ends here: the list the host sends reports what the tree
 * believes, and a toggle arriving from the webview changes what the next walk is given.
 */
{
  const refsProvider = treeProviders.get('weft.refs');
  const sent = posted.filter((m) => m.type === 'refs').at(-1);

  console.log(
    '\nbranch menu    :',
    sent === undefined ? 'NOTHING SENT' : `${sent.refs.length} refs, on ${sent.branch}`,
  );

  if (sent === undefined) {
    problems.push('the header was never told what refs exist');
  } else {
    if (sent.branch !== 'main') {
      problems.push(`the branch menu was told HEAD is on ${sent.branch}`);
    }

    // Every ref, not only the drawn ones: a menu that drops what it is hiding gives you no way to
    // put it back.
    if (sent.refs.length !== refsProvider.listRefs().length) {
      problems.push(
        `the menu was sent ${sent.refs.length} refs and the tree has ${refsProvider.listRefs().length}`,
      );
    }

    const kinds = [...new Set(sent.refs.map((ref) => ref.kind))].sort();

    if (kinds.join(',') !== 'local,remote,tag' && kinds.join(',') !== 'local,tag') {
      problems.push(`the menu was sent refs of kinds ${kinds.join(', ')}`);
    }
  }

  // --- and the toggle, arriving the way the webview sends it ---------------------------------
  const victim = sent?.refs.find((ref) => ref.kind === 'local' && ref.label !== 'main');

  if (victim === undefined) {
    problems.push('no branch to hide from the header');
  } else {
    const walksBefore = posted.filter((m) => m.type === 'done').length;

    await messageHandler({ type: 'setRefsVisible', refNames: [victim.refName], visible: false });

    const by = Date.now() + 10_000;
    while (Date.now() < by && posted.filter((m) => m.type === 'done').length === walksBefore) {
      await new Promise((r) => setTimeout(r, 25));
    }

    const walked = refsProvider.visibleRefs();
    const hiddenNow = walked !== null && !walked.includes(victim.refName);
    const tickOff = refsProvider
      .getChildren(refsProvider.getChildren().find((g) => g.id === 'heads'))
      .some((node) => node.refName === victim.refName && refsProvider.getTreeItem(node).checkboxState === 0);

    console.log(
      'hid from header:',
      victim.label,
      '| out of the walk:',
      hiddenNow,
      '| tick cleared:',
      tickOff,
      '| reloaded:',
      posted.filter((m) => m.type === 'done').length > walksBefore,
    );

    if (!hiddenNow) {
      problems.push(`hiding ${victim.label} from the header did not take it out of the walk`);
    }

    // The same state, so the sidebar has to agree without being told separately.
    if (!tickOff) {
      problems.push(`hiding ${victim.label} from the header left its tick set in the sidebar`);
    }

    if (posted.filter((m) => m.type === 'done').length === walksBefore) {
      problems.push('hiding a branch from the header did not redraw the graph');
    }

    // --- and a whole group at once, which is what the heading's tick sends ------------------
    const many = sent.refs.filter((ref) => ref.kind === 'local').map((ref) => ref.refName);
    const walksBeforeGroup = posted.filter((m) => m.type === 'done').length;

    await messageHandler({ type: 'setRefsVisible', refNames: many, visible: false });
    await new Promise((r) => setTimeout(r, 1500));

    const walks = posted.filter((m) => m.type === 'done').length - walksBeforeGroup;
    console.log('group of', many.length, 'hidden:', walks, 'walk' + (walks === 1 ? '' : 's'));

    // One message, one walk. Sending these one at a time would redraw the history per branch,
    // which is the reason the message carries a list rather than a name.
    if (walks !== 1) {
      problems.push(`hiding ${many.length} branches at once cost ${walks} walks of the history`);
    }

    await commands.get('weft.showAllRefs')();
    await new Promise((r) => setTimeout(r, 500));
  }
}

/*
 * The manifest's menus against the context values the trees actually emit.
 *
 * A `when` clause naming a context value nothing produces is a menu entry that silently is not
 * there - no error, no warning, just a right-click missing an item. The same shape as a view id
 * going stale, and invisible in the same way.
 */
{
  const refsProvider = treeProviders.get('weft.refs');
  const groups = refsProvider.getChildren();

  const kindOf = (groupId) => {
    const node = refsProvider.getChildren(groups.find((g) => g.id === groupId))[0];
    return node === undefined ? null : refsProvider.getTreeItem(node).contextValue;
  };

  const emitted = { local: kindOf('heads'), tag: kindOf('tags') };
  console.log('\nref contexts   :', JSON.stringify(emitted));

  /** Enough of the `when` language for the forms this manifest uses. */
  const matches = (when, viewItem) => {
    const clauses = when.split('&&').map((c) => c.trim());

    return clauses.every((clause) => {
      if (clause.startsWith('view ==')) {
        return clause.includes('weft.refs');
      }

      const regex = /^viewItem\s*=~\s*\/(.+)\/$/.exec(clause);

      if (regex !== null) {
        return new RegExp(regex[1]).test(viewItem);
      }

      const equals = /^viewItem\s*==\s*(\S+)$/.exec(clause);
      return equals === null ? true : equals[1] === viewItem;
    });
  };

  const refMenus = manifest.contributes.menus['view/item/context'].filter(
    (entry) => (entry.when ?? '').includes('weft.refs'),
  );

  for (const entry of refMenus) {
    const hits = ['local', 'tag', 'remote']
      .filter((kind) => matches(entry.when, emitted[kind] ?? `weftRef${kind[0].toUpperCase()}${kind.slice(1)}`));

    if (hits.length === 0) {
      problems.push(`${entry.command} is in the manifest but its when clause matches no ref`);
    }
  }

  const deletable = ['local', 'tag', 'remote'].filter((kind) =>
    refMenus.some(
      (entry) =>
        entry.command === 'weft.deleteRef' &&
        matches(entry.when, emitted[kind] ?? `weftRef${kind[0].toUpperCase()}${kind.slice(1)}`),
    ),
  );

  console.log('delete offered :', deletable.join(', ') || '(nothing)');

  if (deletable.join(',') !== 'local,tag') {
    problems.push(`Delete is offered for ${deletable.join(', ') || 'nothing'}, expected local and tag`);
  }

  // And it refuses a remote branch even when called directly, rather than leaving a menu clause as
  // the only thing between a tree node and a push. Anything it did say would land on the stub's
  // message handlers, which count every unexpected one as a failure.
  const remoteNode = refsProvider.getChildren(groups.find((g) => g.id === 'remotes'))[0];

  if (remoteNode !== undefined) {
    await commands.get('weft.deleteRef')(remoteNode);
  }
}

/*
 * Copying, from both trees. Each command is handed the node the tree would hand it, so what is
 * being checked is the whole path from a row to the clipboard - not that a string was formatted.
 */
{
  const refsProvider = treeProviders.get('weft.refs');
  const filesProvider = treeProviders.get('weft.files');

  const groups = refsProvider.getChildren();
  const ref = refsProvider.getChildren(groups.find((g) => g.id === 'heads'))[0];

  copied.length = 0;
  await commands.get('weft.copyRefName')(ref);
  await commands.get('weft.copyFullRefName')(ref);

  console.log('\ncopy (ref)     :', copied.join('  |  '));

  if (copied[0] !== ref.label) {
    problems.push(`copying a branch name gave ${copied[0]}, expected ${ref.label}`);
  }

  // The full name is what git wants and the label is not: `main` reads, `refs/heads/main` resolves.
  if (copied[1] !== ref.refName || !String(copied[1]).startsWith('refs/')) {
    problems.push(`copying a full ref name gave ${copied[1]}, expected ${ref.refName}`);
  }

  const nodes = [];
  const walk = (list) => {
    for (const node of list) {
      if (node.kind === 'file') {
        nodes.push(node);
      } else {
        walk(filesProvider.getChildren(node));
      }
    }
  };

  walk(filesProvider.getChildren());

  if (nodes.length === 0) {
    problems.push('no file to copy a path from');
  } else {
    copied.length = 0;
    await commands.get('weft.copyFilePath')(nodes[0]);
    await commands.get('weft.copyAbsoluteFilePath')(nodes[0]);

    console.log('copy (file)    :', copied.join('  |  '));

    if (copied[0] !== nodes[0].file.path) {
      problems.push(`copying a path gave ${copied[0]}, expected ${nodes[0].file.path}`);
    }

    // Absolute means absolute: rooted at the repository, not the same string with a slash on it.
    if (!String(copied[1]).endsWith(nodes[0].file.path.replace(/\//g, sep)) || copied[1] === copied[0]) {
      problems.push(`copying an absolute path gave ${copied[1]}, which is not ${nodes[0].file.path} under the repository`);
    }
  }
}

/*
 * One file's history, end to end - and the half of it that only a real repository can answer:
 * whether `--follow` actually reaches back past a rename. The fixture renames a file and commits
 * on both sides of it, so a path search without following stops at the rename and one with it does
 * not. Asserting the flag reached the command line would only prove that it was typed.
 */
{
  const renamed = 'renamed.txt';

  writeFileSync(join(repoPath, 'before-rename.txt'), 'first\n');
  runGit(repoPath, 'add', '-A');
  runGit(repoPath, 'commit', '-q', '-m', 'add before-rename.txt');
  runGit(repoPath, 'mv', 'before-rename.txt', renamed);
  runGit(repoPath, 'commit', '-q', '-m', 'rename before-rename.txt');
  writeFileSync(join(repoPath, renamed), 'first\nsecond\n');
  runGit(repoPath, 'add', '-A');
  runGit(repoPath, 'commit', '-q', '-m', 'edit renamed.txt');

  const runSearch = async (search) => {
    const from = posted.filter((m) => m.type === 'done').length;
    messageHandler({ type: 'search', search });

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && posted.filter((m) => m.type === 'done').length === from) {
      await new Promise((r) => setTimeout(r, 25));
    }

    return posted.filter((m) => m.type === 'done').pop()?.total ?? -1;
  };

  const base = { query: renamed, mode: 'path', regex: false, caseSensitive: false, allTerms: false, invert: false };
  const withoutFollow = await runSearch({ ...base, follow: false });
  const withFollow = await runSearch({ ...base, follow: true, caseSensitive: true });

  console.log('\nfile history   :', renamed, '|', withoutFollow, 'commits touching it,', withFollow, 'following renames');

  if (withoutFollow < 1) {
    problems.push(`a path search for ${renamed} found ${withoutFollow} commits`);
  }

  if (withFollow <= withoutFollow) {
    problems.push(
      `--follow found ${withFollow} commits where a plain path search found ${withoutFollow}; it did not reach past the rename`,
    );
  }

  await runSearch(null);
}

/*
 * Comparing two commits, end to end: two shas -> `git diff --raw` -> a file list with a blob on
 * both sides -> a diff addressed by those blobs. The counts come from the symmetric difference, so
 * a pair that has diverged gets a number for each side rather than one that has to pick a side.
 */
{
  const rows = posted.filter((m) => m.type === 'page').flatMap((m) => m.rows);
  const newest = rows[0];
  const oldest = rows[rows.length - 1];

  if (newest === undefined || oldest === undefined || newest.sha === oldest.sha) {
    problems.push('not enough commits to compare');
  } else {
    const before = posted.filter((m) => m.type === 'comparison').length;
    messageHandler({ type: 'compare', from: oldest.sha, to: newest.sha });

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && posted.filter((m) => m.type === 'comparison').length === before) {
      await new Promise((r) => setTimeout(r, 25));
    }

    const comparison = posted.filter((m) => m.type === 'comparison').pop();

    console.log(
      '\ncompare        :',
      comparison === undefined
        ? 'NO ANSWER'
        : `${comparison.from.slice(0, 8)} → ${comparison.to.slice(0, 8)} | ${comparison.files} files | ${comparison.onlyFrom} left, ${comparison.onlyTo} right`,
    );

    if (comparison === undefined) {
      problems.push('comparing two commits produced nothing');
    } else {
      if (comparison.files === 0) {
        problems.push('comparing the first and last commit found no changed files');
      }

      // The root is an ancestor of the tip, so everything is on one side and nothing on the other.
      if (comparison.onlyFrom !== 0 || comparison.onlyTo === 0) {
        problems.push(
          `an ancestor compared to its descendant came back ${comparison.onlyFrom} left and ${comparison.onlyTo} right`,
        );
      }

      const provider = treeProviders.get('weft.files');
      const nodes = [];
      const walk = (list) => {
        for (const node of list) {
          if (node.kind === 'file') {
            nodes.push(node);
          } else {
            walk(provider.getChildren(node));
          }
        }
      };

      walk(provider.getChildren());

      console.log('  section says :', treeViews.get('weft.files')?.description ?? 'NO DESCRIPTION');

      if (nodes.length !== comparison.files) {
        problems.push(`the section listed ${nodes.length} files, the comparison found ${comparison.files}`);
      }

      // A file opened from a range diffs blob against blob, not against the working tree.
      diffsOpened.length = 0;
      await commands.get('weft.openCommitFile')(nodes[0]);

      const opened = diffsOpened[0];

      if (opened === undefined) {
        problems.push('opening a file from a comparison produced no diff');
      } else {
        console.log('  diff         :', opened.title);

        if (!opened.title.includes('→')) {
          problems.push(`a comparison diff is titled ${opened.title}`);
        }

        const contents = contentProviders.get('weft-git');
        const right = await contents.provideTextDocumentContent(opened.right);

        if (right.length === 0 && nodes[0].file.newBlob !== null) {
          problems.push('the newer side of a comparison diff came back empty');
        }
      }
    }
  }
}

/*
 * The working tree's own row - the one row in the graph that is not a commit, and so the one that
 * takes a path nothing else here exercises: `git status` -> a `working` message -> a file list with
 * no blob OIDs on either side -> a diff whose right-hand side is the file on disk.
 */
{
  writeFileSync(join(repoPath, 'f1.txt'), 'edited but not committed\n');
  // Its own untracked file rather than one an earlier section happened to leave behind: that
  // one only exists under --watch, and a test that passes depending on a flag is not one.
  writeFileSync(join(repoPath, 'never-added.txt'), 'not in the index\n');

  const from = posted.filter((m) => m.type === 'done').length;
  messageHandler({ type: 'refresh' });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && posted.filter((m) => m.type === 'done').length === from) {
    await new Promise((r) => setTimeout(r, 25));
  }

  const state = posted.filter((m) => m.type === 'working').pop();

  /*
   * The counts beside the title are a statement about the last fetch, not about now - `origin/main`
   * is a local pointer only a fetch moves. Without the timestamp travelling with them they read as
   * current, which is exactly how a graph tells you that you are up to date when you are not.
   */
  if (state !== undefined && !('fetchedAt' in state)) {
    problems.push('the working message does not say when the remote was last heard from');
  }

  console.log(
    '\nworking tree   :',
    state === undefined
      ? 'NOT REPORTED'
      : `${state.total} files on ${state.branch} (${state.unstaged} unstaged, ${state.untracked} untracked)`,
  );

  if (state === undefined || state.total === 0) {
    problems.push('a dirty working tree was not reported to the view');
  } else if (state.unstaged === 0 || state.untracked === 0) {
    problems.push(
      `the working tree came back as ${state.unstaged} unstaged and ${state.untracked} untracked; both were expected`,
    );
  }

  await messageHandler({ type: 'selectUncommitted' });

  const provider = treeProviders.get('weft.files');
  const nodes = [];
  const walk = (list) => {
    for (const node of list) {
      if (node.kind === 'file') {
        nodes.push(node);
      } else {
        walk(provider.getChildren(node));
      }
    }
  };

  walk(provider.getChildren());

  console.log('  files listed :', nodes.map((n) => `${n.file.status} ${n.file.path}`).join(', ') || '(none)');
  console.log('  section says :', treeViews.get('weft.files')?.description ?? 'NO DESCRIPTION');

  if (state !== undefined && nodes.length !== state.total) {
    problems.push(`the section listed ${nodes.length} working-tree files, git status found ${state.total}`);
  }

  if (!nodes.some((n) => n.file.status === '?')) {
    problems.push('an untracked file was not listed as untracked');
  }

  const edited = nodes.find((n) => n.file.status === 'M');

  if (edited === undefined) {
    problems.push('the edited file was not listed as modified');
  } else {
    diffsOpened.length = 0;
    await commands.get('weft.openCommitFile')(edited);

    const opened = diffsOpened[0];

    if (opened === undefined) {
      problems.push('opening an uncommitted file produced no diff');
    } else {
      console.log('  diff         :', opened.title);

      if (!opened.title.includes('working tree')) {
        problems.push(`an uncommitted diff was titled ${opened.title}`);
      }

      // The right side is the file itself, not a revision Weft serves.
      if (!String(opened.right.fsPath ?? '').endsWith('f1.txt')) {
        problems.push('the right side of an uncommitted diff is not the file on disk');
      }

      // The left side has no blob OID, so it can only come back through `HEAD:<path>`.
      const contents = contentProviders.get('weft-git');
      const left = await contents.provideTextDocumentContent(opened.left);

      console.log('  HEAD side    :', left.length, 'chars');

      if (left.length === 0) {
        problems.push('the HEAD side of an uncommitted diff came back empty');
      }

      if (left.includes('edited but not committed')) {
        problems.push('the HEAD side of an uncommitted diff shows the working copy');
      }
    }
  }
}

/*
 * The three things the stub could not do until it stopped pretending: the built-in git extension
 * existing, a setting having a value other than its default, and the panel being closed. Each of
 * them gates a path that had never run a line here.
 */
{
  // --- the working tree, told to us by someone else -----------------------------------------
  const walksBefore = posted.filter((m) => m.type === 'done').length;
  const workingBefore = posted.filter((m) => m.type === 'working').length;

  writeFileSync(join(repoPath, 'f1.txt'), 'edited again, without committing\n');
  repositoryState.fire();

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && posted.filter((m) => m.type === 'working').length === workingBefore) {
    await new Promise((r) => setTimeout(r, 25));
  }

  const walksAfter = posted.filter((m) => m.type === 'done').length;
  const told = posted.filter((m) => m.type === 'working').length > workingBefore;

  console.log('\nworking events :', told ? 'the view was told' : 'NOT TOLD', '| walks:', walksBefore, '->', walksAfter);

  if (!told) {
    problems.push('a working-tree change from the git extension never reached the view');
  }

  // The whole point of listening rather than reloading: one `git status`, not a walk.
  if (walksAfter !== walksBefore) {
    problems.push('a file being saved re-walked the history');
  }

  // --- a repository appearing, which is what makes the sections show up ----------------------
  contextKeys.delete('weft.hasRepository');
  repositoryOpened.fire({
    rootUri: uri(repoPath.replace(/\\/g, '/')),
    state: { onDidChange: repositoryState.event },
  });

  const presenceBy = Date.now() + 10_000;
  while (Date.now() < presenceBy && !contextKeys.has('weft.hasRepository')) {
    await new Promise((r) => setTimeout(r, 25));
  }

  console.log('repo events    : hasRepository ->', contextKeys.get('weft.hasRepository'));

  if (contextKeys.get('weft.hasRepository') !== true) {
    problems.push('a repository opening did not put the Source Control sections back');
  }

  // --- a setting with a value ----------------------------------------------------------------
  const scheduled = intervals.length;

  settings.set('weft.autoFetchMinutes', 5);
  configurationChanged.fire(['weft.autoFetchMinutes']);
  await new Promise((r) => setTimeout(r, 200));

  const timer = intervals[intervals.length - 1];
  console.log('auto-fetch     :', intervals.length > scheduled ? `every ${timer.ms} ms` : 'NOT SCHEDULED');

  if (intervals.length === scheduled) {
    problems.push('turning auto-fetch on scheduled nothing');
  } else if (timer.ms !== 5 * 60_000) {
    problems.push(`auto-fetch asked for 5 minutes and scheduled ${timer.ms} ms`);
  }

  settings.set('weft.autoFetchMinutes', 0);
  configurationChanged.fire(['weft.autoFetchMinutes']);
  await new Promise((r) => setTimeout(r, 200));

  if (intervals.length > scheduled + 1) {
    problems.push('turning auto-fetch off scheduled another one');
  }

  // The status bar has a switch too, and its off position had never been taken.
  settings.set('weft.statusBar.enabled', false);
  configurationChanged.fire(['weft.statusBar.enabled']);

  const hiddenBy = Date.now() + 10_000;
  while (Date.now() < hiddenBy && statusBarItem?.visible !== false) {
    await new Promise((r) => setTimeout(r, 25));
  }

  console.log('status bar off :', statusBarItem?.visible === false ? 'hidden' : 'STILL SHOWING');

  if (statusBarItem?.visible !== false) {
    problems.push('turning the status bar item off left it on screen');
  }

  settings.set('weft.statusBar.enabled', true);
  configurationChanged.fire(['weft.statusBar.enabled']);
  await new Promise((r) => setTimeout(r, 400));
}

/*
 * Deleting a branch from the tree, end to end.
 *
 * Not "the action works" - `write.test.ts` covers that against real repositories. What is covered
 * here is the wiring either side of it: that a tree node reaches the right action through the
 * panel, and that the two places showing the branch agree afterwards. A delete that removes the ref
 * and leaves it listed is indistinguishable, from the outside, from a delete that did nothing.
 */
{
  const refsProvider = treeProviders.get('weft.refs');
  const heads = () =>
    refsProvider.getChildren(refsProvider.getChildren().find((g) => g.id === 'heads'));

  const victim = heads().find((node) => node.label === 'side');
  const before = confirmations.length;

  if (victim === undefined) {
    problems.push('no branch to delete from the tree');
  } else {
    await commands.get('weft.deleteRef')(victim);

    const by = Date.now() + 15_000;
    while (Date.now() < by && confirmations.length === before) {
      await new Promise((r) => setTimeout(r, 25));
    }

    await new Promise((r) => setTimeout(r, 1500));

    const asked = confirmations.at(-1);
    const inGit = runGit(repoPath, 'branch', '--list', 'side').trim();
    const listed = heads().some((node) => node.label === 'side');

    console.log('\ndelete branch  :', JSON.stringify(asked?.message ?? '(never asked)'));
    console.log('  git has it   :', inGit.length > 0 ? inGit : 'no');
    console.log('  tree lists it:', listed);

    if (asked === undefined) {
      problems.push('deleting a branch from the tree never asked for confirmation');
    }

    if (inGit.length > 0) {
      problems.push('confirming the delete left the branch in git');
    }

    // The half that is easy to miss: the ref is gone and the sidebar still shows it, which reads
    // as the delete having done nothing at all.
    if (listed) {
      problems.push('the branch was deleted but Branches & Tags still lists it');
    }
  }
}

/*
 * Closing the graph, which nothing here had ever done. Everything the panel holds is released in
 * one place - the watcher, the auto-fetch timer - and with no graph left to select in, the file
 * list is showing a commit nobody can point at.
 */
if (disposeHandler !== null) {
  disposeHandler();
  await new Promise((r) => setTimeout(r, 200));

  const filesView = treeViews.get('weft.files');
  const filesProvider = treeProviders.get('weft.files');

  console.log('panel closed   :', JSON.stringify(filesView?.message ?? ''), '|', filesProvider?.getChildren().length, 'files listed');

  if (filesProvider?.getChildren().length !== 0) {
    problems.push('closing the last graph left files in the Commit Files section');
  }

  if (!String(filesView?.message ?? '').includes('Select a commit')) {
    problems.push(`closing the last graph left the section saying ${filesView?.message}`);
  }
} else {
  problems.push('the panel never registered a dispose handler');
}

console.log('\ngit log        :', outputLines.filter((l) => l.startsWith('debug')).length, 'commands');

if (problems.length > 0) {
  console.error('\nFAILED:');
  for (const p of problems) {
    console.error(`  - ${p}`);
  }

  process.exit(1);
}

console.log('\nOK - the extension loads, activates, and delivers a graph.');
