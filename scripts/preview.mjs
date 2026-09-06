/**
 * Renders the webview outside VS Code, with real data from a real repository.
 *
 * The extension host half can be exercised from Node, but the drawing half normally needs an
 * Extension Development Host to look at. This stubs `acquireVsCodeApi` and the handful of
 * `--vscode-*` theme variables the stylesheet reads, then replays exactly the messages the panel
 * would post - so what renders here is what renders in VS Code.
 *
 *   npm run build && node scripts/preview.mjs [repo] [--light]
 */
import { writeFileSync } from 'node:fs';

import { Git } from '../src/git/exec.ts';
import { discover } from '../src/git/discovery.ts';
import { HistoryLoader } from '../src/git/history.ts';
import { BODY_MARKUP } from '../src/webview/markup.ts';
import { loadCommitDetails } from '../src/git/details.ts';
import { readRepoState } from '../src/git/repoState.ts';

const repoPath = process.argv[2] ?? 'D:/DotNetProjects/GitFlick';
const light = process.argv.includes('--light');
const maxCommits = Number(process.argv.find((a) => a.startsWith('--max='))?.slice(6) ?? 5000);

const git = new Git({});
const repo = await discover(git, repoPath);

if (repo === null) {
  console.error(`not a git repository: ${repoPath}`);
  process.exit(1);
}

const loader = new HistoryLoader(git, repo);
const messages = [];

await loader.load(
  (page) => {
    if (page.commits.length > 0 || page.done) {
      messages.push({
        type: 'page',
        rows: page.commits.map((c) => ({
          sha: c.sha,
          subject: c.subject,
          author: c.author,
          date: c.authorDate,
          refs: c.refs,
          isHead: c.isHead,
        })),
        delta: page.delta,
      });
    }
  },
  { batchSize: 500, maxCommits },
);

// The working tree, read for real: the row that stands for it is only worth looking at against a
// repository that actually has uncommitted changes in it.
const state = await readRepoState(git, repo);

messages.push({
  type: 'working',
  total: state.files.length,
  staged: state.files.filter((f) => f.staged).length,
  unstaged: state.files.filter((f) => f.unstaged).length,
  untracked: state.files.filter((f) => f.untracked).length,
  conflicted: state.files.filter((f) => f.conflicted).length,
  branch: state.branch,
  upstream: state.upstream,
  fetchedAt: state.fetchedAt,
});

messages.push({ type: 'done', total: loader.rowCount, elapsedMs: 0 });

// A stand-in for a stopped merge, so the in-progress banner is something that can be looked at.
if (process.argv.includes('--conflict')) {
  messages.push({
    type: 'operation',
    operation: 'merge',
    description: 'a merge',
    conflicted: ['GitFlick/ViewModels/HistoryViewModel.cs', 'CHANGELOG.md'],
    controls: [
      { id: 'weft.continueOperation', label: 'Continue', group: 'operation', destructive: false, disabledReason: 'Resolve the conflicts first' },
      { id: 'weft.skipOperation', label: 'Skip', group: 'operation', destructive: false, disabledReason: 'A merge cannot skip a commit' },
      { id: 'weft.abortOperation', label: 'Abort', group: 'danger', destructive: false, disabledReason: null },
    ],
  });
}

// Replay a selection too, so the details pane is part of what gets looked at rather than something
// only ever seen inside VS Code. Its file list moved to the Source Control sidebar, which is not
// something this harness can render, so any commit with a message will do.
const sample = messages.find((m) => m.type === 'page')?.rows?.[0];

if (sample !== undefined) {
  const { files: _files, ...info } = await loadCommitDetails(git, repo, sample.sha);
  messages.push({ type: 'details', details: info });
}

/*
 * Approximations of VS Code's own Dark Modern / Light Modern values. A light theme is not a dark
 * theme with a white background: its accent colours are darker too. Getting that wrong here made
 * the preview lie about contrast - which is the one thing this harness exists to be honest about.
 */
const dark = {
  '--vscode-editor-background': '#1f1f1f',
  '--vscode-editor-foreground': '#cccccc',
  '--vscode-descriptionForeground': '#9d9d9d',
  '--vscode-list-hoverBackground': '#2a2d2e',
  '--vscode-list-activeSelectionBackground': '#04395e',
  '--vscode-panel-border': '#2b2b2b',
  '--vscode-errorForeground': '#f14c4c',
  '--vscode-focusBorder': '#0078d4',
  '--vscode-font-family': 'system-ui, sans-serif',
  '--vscode-font-size': '13px',
  '--vscode-editor-font-family': 'Consolas, monospace',
  '--vscode-editorWidget-background': '#252526',
  '--vscode-input-background': '#313131',
  '--vscode-input-foreground': '#cccccc',
  '--vscode-input-border': '#3c3c3c',
  '--vscode-inputOption-activeBackground': 'rgba(36, 137, 219, 0.35)',
  '--vscode-inputOption-activeBorder': '#2488db',
  '--vscode-inputOption-activeForeground': '#ffffff',
  '--vscode-editor-findMatchHighlightBackground': 'rgba(234, 92, 0, 0.33)',
  '--vscode-textCodeBlock-background': '#2b2b2b',
  '--vscode-textLink-foreground': '#4daafc',
  '--vscode-charts-blue': '#3794ff',
  '--vscode-charts-green': '#89d185',
  '--vscode-charts-orange': '#d18616',
  '--vscode-charts-purple': '#b180d7',
  '--vscode-charts-red': '#f14c4c',
  '--vscode-charts-yellow': '#cca700',
  '--vscode-charts-foreground': '#cccccc',
  '--vscode-gitDecoration-addedResourceForeground': '#81b88b',
  '--vscode-gitDecoration-modifiedResourceForeground': '#e2c08d',
  '--vscode-gitDecoration-deletedResourceForeground': '#c74e39',
  '--vscode-gitDecoration-renamedResourceForeground': '#73c991',
};

const lightTheme = {
  ...dark,
  '--vscode-editor-background': '#ffffff',
  '--vscode-editor-foreground': '#3b3b3b',
  '--vscode-descriptionForeground': '#717171',
  '--vscode-list-hoverBackground': '#f0f0f0',
  '--vscode-list-activeSelectionBackground': '#e4e6f1',
  '--vscode-panel-border': '#e5e5e5',
  '--vscode-editorWidget-background': '#f8f8f8',
  '--vscode-input-background': '#ffffff',
  '--vscode-input-foreground': '#3b3b3b',
  '--vscode-input-border': '#cecece',
  '--vscode-inputOption-activeBackground': 'rgba(0, 122, 204, 0.2)',
  '--vscode-inputOption-activeBorder': '#005fb8',
  '--vscode-inputOption-activeForeground': '#000000',
  '--vscode-editor-findMatchHighlightBackground': 'rgba(234, 92, 0, 0.33)',
  '--vscode-textCodeBlock-background': '#f3f3f3',
  '--vscode-textLink-foreground': '#005fb8',
  '--vscode-charts-blue': '#1a85ff',
  '--vscode-charts-green': '#388a34',
  '--vscode-charts-orange': '#b5620a',
  '--vscode-charts-purple': '#652d90',
  '--vscode-charts-red': '#cd3131',
  '--vscode-charts-yellow': '#a67c00',
  '--vscode-charts-foreground': '#3b3b3b',
  '--vscode-gitDecoration-addedResourceForeground': '#587c0c',
  '--vscode-gitDecoration-modifiedResourceForeground': '#895503',
  '--vscode-gitDecoration-deletedResourceForeground': '#ad0707',
  '--vscode-gitDecoration-renamedResourceForeground': '#007100',
};

const theme = light ? lightTheme : dark;
const vars = Object.entries(theme)
  .map(([k, v]) => `  ${k}: ${v};`)
  .join('\n');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Weft preview - ${repo.root}</title>
<style>:root {\n${vars}\n}</style>
<link href="style.css" rel="stylesheet">
</head>
<body class="${light ? 'vscode-light' : 'vscode-dark'}">
${BODY_MARKUP}
<script>
  const sent = window.__sent = [];
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => {
      sent.push(m);
      if (m.type === 'ready') replay();
      // Stand in for the host so the menu can be looked at: a real one, plus a disabled one.
      if (m.type === 'requestMenu') {
        window.postMessage({
          type: 'menu',
          target: m.target,
          x: m.x,
          y: m.y,
          items: m.target.kind === 'ref'
            ? [
                { id: 'weft.checkoutBranch', label: 'Checkout ' + m.target.label, group: 'branch', destructive: false, disabledReason: null },
                { id: 'weft.renameBranch', label: 'Rename ' + m.target.label + '…', group: 'branch', destructive: false, disabledReason: null },
                { id: 'weft.createBranch', label: 'Create branch from ' + m.target.label + '…', group: 'create', destructive: false, disabledReason: null },
                { id: 'weft.createTag', label: 'Create tag at ' + m.target.label + '…', group: 'create', destructive: false, disabledReason: null },
                { id: 'weft.deleteBranch', label: 'Delete ' + m.target.label, group: 'danger', destructive: false, disabledReason: null },
              ]
            : [
                { id: 'weft.checkoutCommit', label: 'Checkout ' + m.target.sha.slice(0,8) + ' (detached)', group: 'branch', destructive: false, disabledReason: null },
                { id: 'weft.createBranch', label: 'Create branch from ' + m.target.sha.slice(0,8) + '…', group: 'create', destructive: false, disabledReason: null },
                { id: 'weft.createTag', label: 'Create tag at ' + m.target.sha.slice(0,8) + '…', group: 'create', destructive: false, disabledReason: null },
                { id: 'demo.reset', label: 'Reset main to here (hard)', group: 'danger', destructive: true, disabledReason: 'Not built yet' },
              ],
        }, '*');
      }
    },
    // A real store rather than a stub: the view's layout and filters are supposed to survive the
    // tab being hidden, and a getState that always answers undefined would hide it if they did not.
    getState: () => { try { return JSON.parse(sessionStorage.getItem('weft.state') ?? 'null') ?? undefined; } catch { return undefined; } },
    setState: (v) => { try { sessionStorage.setItem('weft.state', JSON.stringify(v)); } catch {} },
  });
  const MESSAGES = ${JSON.stringify(messages)};
  const INIT = ${JSON.stringify({
    type: 'init',
    repoName: repo.root.split('/').pop(),
    repoRoot: repo.root,
    rowHeight: 24,
    authorColors: true,
    kind: repo.isBare ? 'bare' : repo.isLinkedWorktree ? 'linked worktree' : null,
  })};
  function replay() {
    window.postMessage(INIT, '*');
    // The panel always opens a load with a reset; replaying without one would hide anything the
    // view only learns from it.
    window.postMessage({ type: 'reset', filtered: false }, '*');
    for (const m of MESSAGES) window.postMessage(m, '*');
  }
</script>
<script src="main.js"></script>
</body>
</html>`;

writeFileSync('dist/preview.html', html);
console.log(
  `dist/preview.html  <- ${loader.rowCount} commits from ${repo.root}${light ? ' (light)' : ' (dark)'}`,
);
