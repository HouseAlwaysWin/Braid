/**
 * Write actions, against real repositories.
 *
 * These assert on **git's state afterwards** - where HEAD points, what `status` says - rather than
 * on anything the UI did. A write action that draws the right thing and does the wrong thing is the
 * failure mode worth spending a test on.
 *
 * Every destructive path gets a test that it *refuses*, not just one that it works. "It does the
 * thing" is the easy half.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Git, GitError } from '../src/git/exec.ts';
import { discover } from '../src/git/discovery.ts';
import type { RepoInfo } from '../src/git/discovery.ts';
import { Operation, parseStatus, readOperation, readRepoState, workAtRisk } from '../src/git/repoState.ts';
import { Remedy, mapGitError } from '../src/git/errors.ts';
import type { ActionUi, Target } from '../src/actions/registry.ts';
import { buildMenu, findAction } from '../src/actions/registry.ts';
import { RepoLock } from '../src/git/lock.ts';

const git = new Git({});
const made: string[] = [];

function sh(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

/** A repository with `main`, a `feature` branch one commit ahead, and a clean tree. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'braid-write-')).split('\\').join('/');
  made.push(dir);

  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.name', 'Braid Test');
  sh(dir, 'config', 'user.email', 'test@example.invalid');
  sh(dir, 'config', 'commit.gpgsign', 'false');

  writeFileSync(join(dir, 'a.txt'), 'one\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'first');

  sh(dir, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(dir, 'b.txt'), 'two\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'second');
  sh(dir, 'checkout', '-q', 'main');

  return dir;
}

async function open(dir: string): Promise<RepoInfo> {
  const repo = await discover(git, dir);
  assert.notEqual(repo, null, 'fixture should be a repository');
  return repo as RepoInfo;
}

/** Records what it was asked, and answers however the test says. */
function fakeUi(answer = true): ActionUi & { confirmations: string[] } {
  const confirmations: string[] = [];

  return {
    confirmations,
    confirm: async (request) => {
      confirmations.push(request.detail);
      return answer;
    },
    progress: async (_title, work) => work(),
    notify: () => undefined,
  };
}

const branch = (label: string): Target => ({
  kind: 'ref',
  refName: `refs/heads/${label}`,
  label,
  refKind: 'local',
});

test.after(() => {
  for (const dir of made) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkout moves HEAD to the branch', async () => {
  const dir = makeRepo();
  const repo = await open(dir);
  const action = findAction('braid.checkoutBranch');

  assert.notEqual(action, undefined);

  const state = await readRepoState(git, repo);
  assert.equal(state.branch, 'main');

  await action?.run({ git, repo, state, target: branch('feature'), ui: fakeUi() });

  assert.equal(sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'feature');
});

test('checkout is offered for another branch and refused for the current one', async () => {
  const repo = await open(makeRepo());
  const state = await readRepoState(git, repo);

  const other = buildMenu(branch('feature'), state);
  const current = buildMenu(branch('main'), state);

  assert.equal(other[0]?.disabledReason, null);
  assert.equal(current[0]?.disabledReason, 'Already checked out');
});

test('nothing is offered while another operation is in progress', async () => {
  const dir = makeRepo();
  const repo = await open(dir);

  // Stop a real merge on a conflict rather than faking the state file, so this tests the same
  // thing the user would hit.
  sh(dir, 'checkout', '-q', '-b', 'conflicting', 'main');
  writeFileSync(join(dir, 'b.txt'), 'different\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'conflicting');

  try {
    sh(dir, 'merge', 'feature');
  } catch {
    // Expected: the merge conflicts and leaves MERGE_HEAD behind.
  }

  assert.equal(await readOperation(repo.gitDir), Operation.Merge);

  const state = await readRepoState(git, repo);
  assert.equal(state.operation, Operation.Merge);
  assert.equal(buildMenu(branch('main'), state)[0]?.disabledReason, 'Finish a merge first');
});

test('checkout refuses rather than discarding uncommitted work', async () => {
  const dir = makeRepo();
  const repo = await open(dir);

  // b.txt exists on feature but not on main, so an uncommitted b.txt is in the way of switching.
  writeFileSync(join(dir, 'b.txt'), 'work in progress\n');

  const state = await readRepoState(git, repo);
  const action = findAction('braid.checkoutBranch');

  await assert.rejects(
    () => action?.run({ git, repo, state, target: branch('feature'), ui: fakeUi() }) as Promise<unknown>,
    GitError,
  );

  assert.equal(sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main', 'HEAD must not move');
  assert.equal(
    readFileSync(join(dir, 'b.txt'), 'utf8'),
    'work in progress\n',
    'the refusal is only worth anything if the work is still there afterwards',
  );
});

test('the refusal maps to an offer to stash', async () => {
  const dir = makeRepo();
  const repo = await open(dir);

  writeFileSync(join(dir, 'b.txt'), 'work in progress\n');
  const state = await readRepoState(git, repo);

  try {
    await findAction('braid.checkoutBranch')?.run({
      git,
      repo,
      state,
      target: branch('feature'),
      ui: fakeUi(),
    });
    assert.fail('expected the checkout to be refused');
  } catch (err) {
    const mapped = mapGitError(err);

    assert.match(mapped.message, /would be overwritten/);
    assert.ok(mapped.remedies.includes(Remedy.StashAndRetry));
    assert.deepEqual(mapped.paths, ['b.txt'], 'the dialog needs the file names, not just a warning');
  }
});

test('uncommitted work is reported, untracked files are not counted as at risk', async () => {
  const dir = makeRepo();
  const repo = await open(dir);

  writeFileSync(join(dir, 'a.txt'), 'edited\n');
  writeFileSync(join(dir, 'brand-new.txt'), 'untracked\n');

  const state = await readRepoState(git, repo);
  const risky = workAtRisk(state).map((file) => file.path);

  assert.deepEqual(risky, ['a.txt']);
  assert.equal(state.files.some((file) => file.path === 'brand-new.txt' && file.untracked), true);
});

test('status parsing does not shift records after a rename', () => {
  // `R  new\0old\0M  other\0` - the rename's source path is a field of its own.
  const files = parseStatus('R  new/name.ts\x00old/name.ts\x00M  other.ts\x00?? junk.txt\x00');

  assert.deepEqual(
    files.map((f) => f.path),
    ['new/name.ts', 'other.ts', 'junk.txt'],
  );
  assert.equal(files[1]?.code, 'M ');
  assert.equal(files[2]?.untracked, true);
});

test('conflicted files are recognised in every unmerged form', () => {
  const files = parseStatus('UU both.ts\x00AA added.ts\x00DD gone.ts\x00M  normal.ts\x00');
  const conflicted = files.filter((f) => f.conflicted).map((f) => f.path);

  assert.deepEqual(conflicted, ['both.ts', 'added.ts', 'gone.ts']);
});

test('the lock serialises writers and survives one of them failing', async () => {
  const lock = new RepoLock();
  const order: string[] = [];

  const slow = lock.run('r', async () => {
    await new Promise((r) => setTimeout(r, 30));
    order.push('first');
  });

  const failing = lock.run('r', async () => {
    order.push('second');
    throw new Error('boom');
  });

  const after = lock.run('r', async () => {
    order.push('third');
  });

  await slow;
  await assert.rejects(() => failing, /boom/);
  await after;

  assert.deepEqual(order, ['first', 'second', 'third'], 'a failure must not skip or poison the queue');
  assert.equal(lock.isBusy('r'), false, 'the queue should drain');
});

test('an unrecognised failure keeps git own words rather than inventing vaguer ones', () => {
  const mapped = mapGitError(new GitError(['push'], 1, 'fatal: something entirely new happened\n'));

  assert.equal(mapped.message, 'something entirely new happened');
  assert.ok(mapped.remedies.includes(Remedy.ShowLog));
});
