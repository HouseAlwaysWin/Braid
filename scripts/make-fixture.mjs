/**
 * Builds a large synthetic repository with `git fast-import`.
 *
 * Plumbing, not porcelain: `git commit` needs a working tree and spawns a process per commit, so
 * 100k commits would take hours. fast-import takes one stream on stdin and does it in seconds.
 * Fixed author identity and fixed timestamps make the resulting OIDs identical on every machine,
 * so snapshot assertions are stable.
 *
 *   node scripts/make-fixture.mjs <dir> [commits] [branchEvery] [branchLength]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';

const dir = process.argv[2];
const count = Number(process.argv[3] ?? 100_000);
const branchEvery = Number(process.argv[4] ?? 50);
const branchLength = Number(process.argv[5] ?? 5);

if (dir === undefined) {
  console.error('usage: node scripts/make-fixture.mjs <dir> [commits] [branchEvery] [branchLength]');
  process.exit(1);
}

rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const run = (args, stdin) =>
  new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: dir, shell: false, windowsHide: true });
    let err = '';
    child.stderr.on('data', (c) => (err += c));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`git ${args[0]}: ${err}`))));
    if (stdin !== undefined) {
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
  });

await run(['init', '-q', '--bare', '--initial-branch=main']);

const IDENT = 'Fixture <fixture@example.invalid>';
const out = [];
let mark = 0;
let time = 1_700_000_000;

function commit(ref, message, parents) {
  mark++;
  time += 60;
  out.push(`commit ${ref}`);
  out.push(`mark :${mark}`);
  out.push(`author ${IDENT} ${time} +0000`);
  out.push(`committer ${IDENT} ${time} +0000`);
  out.push(`data ${Buffer.byteLength(message)}`);
  out.push(message);

  if (parents.length > 0) {
    out.push(`from :${parents[0]}`);
    for (const extra of parents.slice(1)) {
      out.push(`merge :${extra}`);
    }
  }

  out.push(`M 644 inline file-${mark % 200}.txt`);
  const body = `content ${mark}\n`;
  out.push(`data ${Buffer.byteLength(body)}`);
  out.push(body.trimEnd());
  out.push('');
  return mark;
}

let head = commit('refs/heads/main', 'root', []);
let branches = 0;

while (mark < count) {
  head = commit('refs/heads/main', `commit ${mark + 1}`, [head]);

  if (mark % branchEvery === 0 && mark + branchLength + 1 < count) {
    branches++;
    const name = `refs/heads/topic/${branches}`;
    let tip = head;

    for (let i = 0; i < branchLength; i++) {
      tip = commit(name, `topic ${branches} step ${i + 1}`, [tip]);
    }

    head = commit('refs/heads/main', `Merge topic/${branches}`, [head, tip]);

    // Keep only every fifth topic branch as a ref, so the ref table stays realistic rather than
    // turning into one ref per branch for 2000 branches.
    if (branches % 5 !== 0) {
      out.push(`reset ${name}`);
      out.push('from 0000000000000000000000000000000000000000');
      out.push('');
    }
  }
}

out.push(`reset refs/heads/main`);
out.push(`from :${head}`);
out.push('');
out.push('done');

const started = Date.now();
await run(['fast-import', '--quiet', '--done'], out.join('\n') + '\n');
await run(['pack-refs', '--all']);

console.log(
  `built ${mark} commits, ${branches} topic branches in ${Date.now() - started}ms at ${dir}`,
);
