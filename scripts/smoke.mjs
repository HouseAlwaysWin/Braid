// End-to-end check: real git -> streaming parser -> incremental layout.
// Reports time-to-first-page, which is the number that decides whether a big repo feels instant.
import { Git } from '../src/git/exec.ts';
import { discover, listWorktrees } from '../src/git/discovery.ts';
import { HistoryLoader } from '../src/git/history.ts';

const repoPath = process.argv[2] ?? 'D:/DotNetProjects/GitFlick';
const verbose = process.argv.includes('--verbose');

const git = new Git({
  onCommand: (e) =>
    verbose && console.log(`  [${e.durationMs}ms exit=${e.exitCode}] git ${e.args.join(' ')}`),
});

const t0 = Date.now();
const repo = await discover(git, repoPath);

if (repo === null) {
  console.error(`not a git repository: ${repoPath}`);
  process.exit(1);
}

console.log(`repo            : ${repo.root}`);
console.log(`git dir         : ${repo.gitDir}`);
console.log(`common dir      : ${repo.commonDir}${repo.isLinkedWorktree ? '   <- differs: linked worktree' : ''}`);
console.log(`bare            : ${repo.isBare}`);
console.log(`submodule of    : ${repo.superproject ?? '(not a submodule)'}`);

const worktrees = await listWorktrees(git, repo);
console.log(`worktrees       : ${worktrees.length}`);
for (const w of worktrees) {
  console.log(`  ${w.path}  ${w.branch ?? (w.isDetached ? '(detached)' : '')}${w.isLocked ? ' [locked]' : ''}`);
}

const loader = new HistoryLoader(git, repo);
let pages = 0;
let firstPageAt = 0;
let commits = 0;
let arcs = 0;
let lanes = 0;

await loader.load(
  (page) => {
    if (!page.done) {
      pages++;
      commits += page.commits.length;
      arcs += page.delta.links.length;
      lanes += page.delta.paths.length;
      if (firstPageAt === 0) {
        firstPageAt = Date.now() - t0;
      }
    }
  },
  { batchSize: 500 },
);

const total = Date.now() - t0;

console.log(`\ncommits         : ${commits}`);
console.log(`pages           : ${pages}`);
console.log(`merge arcs      : ${arcs}`);
console.log(`lane segments   : ${lanes}`);
console.log(`first page      : ${firstPageAt}ms   <- what the user waits for`);
console.log(`full history    : ${total}ms`);
console.log(`rows/sec        : ${Math.round((commits / Math.max(total, 1)) * 1000).toLocaleString()}`);
