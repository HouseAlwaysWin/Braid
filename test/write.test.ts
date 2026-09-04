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
import { buildMenu, confirmIfNeeded, findAction } from '../src/actions/registry.ts';
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

/**
 * Records what it was asked and answers however the test says.
 *
 * `inputs` are handed out in order, so a test can script a whole prompt sequence; running out
 * answers null, which every action treats as a cancel.
 */
function fakeUi(
  options: { confirm?: boolean; inputs?: string[] } = {},
): ActionUi & { confirmations: string[]; prompts: string[] } {
  const confirmations: string[] = [];
  const prompts: string[] = [];
  const inputs = [...(options.inputs ?? [])];

  return {
    confirmations,
    prompts,
    confirm: async (request) => {
      confirmations.push(request.detail);
      return options.confirm ?? true;
    },
    input: async (request) => {
      prompts.push(request.title);
      const next = inputs.shift();

      if (next === undefined) {
        return null;
      }

      const rejection = request.validate?.(next) ?? null;
      assert.equal(rejection, null, `the test supplied a value the action rejects: ${rejection}`);
      return next;
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

const commit = (sha: string): Target => ({ kind: 'commit', sha, subject: 'x' });

async function run(dir: string, id: string, target: Target, ui = fakeUi()) {
  const repo = await open(dir);
  const state = await readRepoState(git, repo);
  const action = findAction(id);

  assert.notEqual(action, undefined, `no such action: ${id}`);

  const context = { git, repo, state, target, ui };
  const allowed = await confirmIfNeeded(action!, context);

  return allowed ? action!.run(context) : { message: '', ran: false };
}

test('creating a branch makes it and checks it out', async () => {
  const dir = makeRepo();
  const head = sh(dir, 'rev-parse', 'HEAD').trim();

  await run(dir, 'braid.createBranch', commit(head), fakeUi({ inputs: ['topic/new-thing'] }));

  assert.equal(sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'topic/new-thing');
  assert.equal(sh(dir, 'rev-parse', 'topic/new-thing').trim(), head);
});

test('a branch name git would reject never reaches git', async () => {
  const dir = makeRepo();
  const head = sh(dir, 'rev-parse', 'HEAD').trim();
  const ui = fakeUi({ inputs: [] });
  const repo = await open(dir);
  const state = await readRepoState(git, repo);

  // The action asks; the fake declines. Nothing should have been created either way.
  await findAction('braid.createBranch')?.run({ git, repo, state, target: commit(head), ui });
  assert.equal(sh(dir, 'branch', '--list', '--format=%(refname:short)').trim().split('\n').sort().join(','), 'feature,main');

  // And the validator the action supplies rejects what git rejects.
  const captured: Array<(v: string) => string | null> = [];
  const capturingUi: ActionUi = {
    ...fakeUi(),
    input: async (request) => {
      if (request.validate !== undefined) {
        captured.push(request.validate);
      }
      return null;
    },
  };

  await findAction('braid.createBranch')?.run({ git, repo, state, target: commit(head), ui: capturingUi });

  const validate = captured[0];
  assert.notEqual(validate, undefined);
  assert.equal(validate?.('main'), 'main already exists');
  assert.match(validate?.('has space') ?? '', /Not allowed/);
  assert.match(validate?.('bad..name') ?? '', /Not allowed/);
  assert.match(validate?.('ends.lock') ?? '', /end with .lock/);
  assert.equal(validate?.('perfectly/fine'), null);
  // 'feature' already exists, so it cannot also be a folder holding 'feature/x'.
  assert.match(validate?.('feature/x') ?? '', /Conflicts with feature/);
});

test('renaming a branch moves the name and keeps the commit', async () => {
  const dir = makeRepo();
  const before = sh(dir, 'rev-parse', 'feature').trim();

  await run(dir, 'braid.renameBranch', branch('feature'), fakeUi({ inputs: ['feature-renamed'] }));

  assert.equal(sh(dir, 'rev-parse', 'feature-renamed').trim(), before);
  assert.equal(sh(dir, 'branch', '--list', 'feature').trim(), '');
});

test('deleting a merged branch says nothing is lost, and deletes it', async () => {
  const dir = makeRepo();
  sh(dir, 'merge', '--no-edit', '-q', 'feature');

  const ui = fakeUi();
  const result = await run(dir, 'braid.deleteBranch', branch('feature'), ui);

  assert.equal(result.ran, true);
  assert.match(ui.confirmations[0] ?? '', /reachable from somewhere else/);
  assert.equal(sh(dir, 'branch', '--list', 'feature').trim(), '');
});

test('deleting an unmerged branch counts the commits it would strand', async () => {
  const dir = makeRepo();
  const ui = fakeUi();

  const result = await run(dir, 'braid.deleteBranch', branch('feature'), ui);

  // `feature` is one commit ahead of main and nowhere else, so exactly one commit is at stake.
  assert.match(ui.confirmations[0] ?? '', /^1 commit is on this branch and nowhere else/);
  assert.match(ui.confirmations[0] ?? '', /reflog/);
  assert.equal(result.ran, true);
  assert.equal(sh(dir, 'branch', '--list', 'feature').trim(), '');
});

test('declining the confirmation leaves the branch alone', async () => {
  const dir = makeRepo();

  const result = await run(dir, 'braid.deleteBranch', branch('feature'), fakeUi({ confirm: false }));

  assert.equal(result.ran, false);
  assert.match(sh(dir, 'branch', '--list', 'feature'), /feature/);
});

test('the branch you are standing on is not offered for deletion', async () => {
  const repo = await open(makeRepo());
  const state = await readRepoState(git, repo);
  const item = buildMenu(branch('main'), state).find((i) => i.id === 'braid.deleteBranch');

  assert.equal(item?.disabledReason, 'Currently checked out');
});

test('an empty tag message makes a lightweight tag, a message makes an annotated one', async () => {
  const dir = makeRepo();
  const head = sh(dir, 'rev-parse', 'HEAD').trim();

  await run(dir, 'braid.createTag', commit(head), fakeUi({ inputs: ['v1.0', ''] }));
  await run(dir, 'braid.createTag', commit(head), fakeUi({ inputs: ['v2.0', 'the second one'] }));

  assert.equal(sh(dir, 'cat-file', '-t', 'v1.0').trim(), 'commit', 'lightweight tags point straight at the commit');
  assert.equal(sh(dir, 'cat-file', '-t', 'v2.0').trim(), 'tag', 'annotated tags are their own object');
  assert.match(sh(dir, 'tag', '-n', '--list', 'v2.0'), /the second one/);
});

test('checking out a commit detaches HEAD and says how to get back', async () => {
  const dir = makeRepo();
  const first = sh(dir, 'rev-list', '--max-parents=0', 'HEAD').trim();

  const result = await run(dir, 'braid.checkoutCommit', commit(first));

  assert.equal(sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'HEAD', 'detached HEAD has no branch name');
  assert.equal(sh(dir, 'rev-parse', 'HEAD').trim(), first);
  assert.match(result.message, /detached/);
  assert.match(result.message, /git checkout main/);
});
