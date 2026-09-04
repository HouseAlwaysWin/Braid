/**
 * Loads the built extension with a stubbed `vscode` module and drives it end to end.
 *
 * This is the check that "it fails to load" and "the command is dead" cannot survive. It exercises
 * the real CommonJS bundle VS Code will require, calls `activate`, invokes `braid.openGraph`, and
 * replays the webview handshake - so everything except VS Code's own chrome is covered before
 * anyone presses F5.
 *
 *   node scripts/load-check.mjs [repo]
 */
import { createRequire } from 'node:module';
import Module from 'node:module';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const watchTest = process.argv.includes('--watch');
const given = process.argv.slice(2).find((a) => !a.startsWith('--'));

/** A throwaway repository, so the watcher test can commit into it without touching anything real. */
function makeTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'braid-watch-')).split('\\').join('/');
  runGit(dir, 'init', '-q', '-b', 'main');
  runGit(dir, 'config', 'user.name', 'Braid Test');
  runGit(dir, 'config', 'user.email', 'test@example.invalid');
  runGit(dir, 'config', 'commit.gpgsign', 'false');

  for (const n of [1, 2, 3]) {
    commitInto(dir, n);
  }

  // A side branch with a commit of its own, so the ref filter has something to remove.
  runGit(dir, 'checkout', '-q', '-b', 'side');
  commitInto(dir, 9);
  runGit(dir, 'checkout', '-q', 'main');

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

const commands = new Map();
const posted = [];
const outputLines = [];
let messageHandler = null;
let panelCreated = null;
const problems = [];
const contentProviders = new Map();
const diffsOpened = [];
let statusBarItem = null;
let treeProvider = null;
let checkboxHandler = null;
let treeView = null;

class StubEmitter {
  constructor() { this.listeners = []; }
  get event() { return (fn) => { this.listeners.push(fn); return { dispose() {} }; }; }
  fire(v) { for (const l of [...this.listeners]) l(v); }
  dispose() {}
}

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
      return undefined;
    },
  },
  window: {
    activeTextEditor: undefined,
    createOutputChannel: () => ({
      info: (m) => outputLines.push(`info  ${m}`),
      warn: (m) => outputLines.push(`warn  ${m}`),
      debug: (m) => outputLines.push(`debug ${m}`),
      show() {},
      dispose() {},
    }),
    showInformationMessage: (m) => problems.push(`unexpected info message: ${m}`),
    showWarningMessage: (m) => problems.push(`unexpected warning: ${m}`),
    setStatusBarMessage: () => ({ dispose() {} }),
    createTreeView: (id, options) => {
      treeProvider = options.treeDataProvider;
      treeView = {
        message: undefined,
        onDidChangeCheckboxState: (fn) => { checkboxHandler = fn; return { dispose() {} }; },
        dispose() {},
      };
      return treeView;
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
      return {
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
        onDidChangeViewState: () => ({ dispose() {} }),
        onDidDispose: () => ({ dispose() {} }),
        reveal() {},
        dispose() {},
      };
    },
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  EventEmitter: StubEmitter,
  ThemeIcon: class { constructor(id) { this.id = id; } },
  TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
  workspace: {
    workspaceFolders: [{ uri: uri(repoPath) }],
    getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    registerTextDocumentContentProvider: (scheme, provider) => {
      contentProviders.set(scheme, provider);
      return { dispose() {} };
    },
  },
  extensions: {
    getExtension: () => undefined,
  },
  env: { clipboard: { writeText: async () => {} } },
};

// The bundle does `require('vscode')`, which only exists inside the extension host.
const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeStub;
  }

  return originalLoad.call(this, request, parent, isMain);
};

const require_ = createRequire(import.meta.url);
const extension = require_(resolve('dist/extension.js'));

console.log('exports        :', Object.keys(extension).join(', '));

const context = { subscriptions: [], extensionUri: uri(resolve('.').replace(/\\/g, '/')) };
extension.activate(context);

await new Promise((r) => setTimeout(r, 800));

console.log('commands       :', [...commands.keys()].join(', '));
console.log('status bar     :', statusBarItem === null ? 'NOT CREATED' : JSON.stringify({ text: statusBarItem.text, command: statusBarItem.command, visible: statusBarItem.visible }));

if (statusBarItem === null) {
  problems.push('no status bar item was created');
} else {
  if (statusBarItem.command !== 'braid.openGraph') problems.push('status bar item runs the wrong command: ' + statusBarItem.command);
  if (!statusBarItem.visible) problems.push('status bar item stayed hidden in a real repository');
}
console.log('subscriptions  :', context.subscriptions.length);

for (const expected of ['braid.openGraph', 'braid.refresh', 'braid.showGitLog']) {
  if (!commands.has(expected)) {
    problems.push(`contributed but never registered: ${expected}`);
  }
}

await commands.get('braid.openGraph')();

if (panelCreated === null) {
  problems.push('braid.openGraph did not create a webview panel');
} else {
  console.log('panel          :', panelCreated.viewType, '/', panelCreated.title);
}

// The webview announces itself once its script loads; that is what starts the history walk.
if (messageHandler === null) {
  problems.push('panel never subscribed to webview messages');
} else {
  messageHandler({ type: 'ready' });

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
    console.log('details        :', details.sha.slice(0, 8), '|', details.files.length, 'files');
    console.log('  message      :', JSON.stringify(details.body.split('\n')[0]?.slice(0, 60)));
    for (const f of details.files.slice(0, 3)) {
      console.log(`  ${f.status} ${f.path}${f.oldPath === null ? '' : ` (was ${f.oldPath})`}`);
    }

    if (details.body.length === 0) {
      problems.push('commit message came back empty');
    }

    if (details.files.length === 0) {
      problems.push('commit reported no changed files');
    }

    if (details.files.some((f) => f.newBlob === null && f.status !== 'D')) {
      problems.push('a non-deleted file has no blob to diff against');
    }
  }
}

// Opening a diff has to survive the whole chain: raw record -> blob OID -> URI -> content provider.
const details = posted.find((m) => m.type === 'details')?.details;

if (details !== undefined && details.files.length > 0) {
  await messageHandler({ type: 'openDiff', sha: details.sha, index: 0 });

  const opened = diffsOpened[0];

  if (opened === undefined) {
    problems.push('opening a file produced no diff');
  } else {
    const provider = contentProviders.get('braid-git');
    console.log('diff           :', opened.title);
    console.log('  right uri    :', opened.right.path);

    if (provider === undefined) {
      problems.push('no content provider was registered for braid-git');
    } else {
      const text = await provider.provideTextDocumentContent(opened.right);
      const left = await provider.provideTextDocumentContent(opened.left);
      console.log('  content      :', text.length, 'chars (was', left.length + ')');

      if (text.length === 0 && details.files[0].newBlob !== null) {
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

  const impossible = await runSearch({ query: 'zzz-no-such-commit-zzz', mode: 'message' });
  console.log('search (miss)  :', impossible, 'of', baseline);

  if (impossible !== 0) {
    problems.push(`a query matching nothing returned ${impossible} commits`);
  }

  const cleared = await runSearch(null);
  console.log('search cleared :', cleared, 'of', baseline);

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

  if (onSide?.items?.[0]?.id !== 'braid.checkoutBranch') {
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
if (treeProvider !== null && checkboxHandler !== null) {
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
      await commands.get('braid.showAllRefs')();

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

console.log('\ngit log        :', outputLines.filter((l) => l.startsWith('debug')).length, 'commands');

if (problems.length > 0) {
  console.error('\nFAILED:');
  for (const p of problems) {
    console.error(`  - ${p}`);
  }

  process.exit(1);
}

console.log('\nOK - the extension loads, activates, and delivers a graph.');
