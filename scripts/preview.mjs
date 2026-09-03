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

messages.push({ type: 'done', total: loader.rowCount, elapsedMs: 0 });

// Replay a selection too, so the details pane is part of what gets looked at rather than something
// only ever seen inside VS Code.
const firstSha = messages.find((m) => m.type === 'page')?.rows?.[0]?.sha;

if (firstSha !== undefined) {
  messages.push({ type: 'details', details: await loadCommitDetails(git, repo, firstSha) });
}

const dark = {
  '--vscode-editor-background': '#1f1f1f',
  '--vscode-editor-foreground': '#cccccc',
  '--vscode-descriptionForeground': '#9d9d9d',
  '--vscode-list-hoverBackground': '#2a2d2e',
  '--vscode-panel-border': '#2b2b2b',
  '--vscode-errorForeground': '#f14c4c',
  '--vscode-font-family': 'system-ui, sans-serif',
  '--vscode-font-size': '13px',
  '--vscode-editor-font-family': 'Consolas, monospace',
  '--vscode-charts-blue': '#3794ff',
  '--vscode-charts-green': '#89d185',
  '--vscode-charts-orange': '#d18616',
  '--vscode-charts-purple': '#b180d7',
  '--vscode-charts-red': '#f14c4c',
  '--vscode-charts-yellow': '#cca700',
  '--vscode-charts-foreground': '#cccccc',
};

const lightTheme = {
  ...dark,
  '--vscode-editor-background': '#ffffff',
  '--vscode-editor-foreground': '#3b3b3b',
  '--vscode-descriptionForeground': '#717171',
  '--vscode-list-hoverBackground': '#f0f0f0',
  '--vscode-panel-border': '#e5e5e5',
  '--vscode-charts-foreground': '#3b3b3b',
};

const theme = light ? lightTheme : dark;
const vars = Object.entries(theme)
  .map(([k, v]) => `  ${k}: ${v};`)
  .join('\n');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Braid preview - ${repo.root}</title>
<style>:root {\n${vars}\n}</style>
<link href="style.css" rel="stylesheet">
</head>
<body>
${BODY_MARKUP}
<script>
  const sent = [];
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => { sent.push(m); if (m.type === 'ready') replay(); },
    getState: () => undefined,
    setState: () => {},
  });
  const MESSAGES = ${JSON.stringify(messages)};
  const INIT = ${JSON.stringify({
    type: 'init',
    repoName: repo.root.split('/').pop(),
    repoRoot: repo.root,
    rowHeight: 24,
    kind: repo.isBare ? 'bare' : repo.isLinkedWorktree ? 'linked worktree' : null,
  })};
  function replay() {
    window.postMessage(INIT, '*');
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
