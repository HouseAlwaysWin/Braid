import test from 'node:test';
import assert from 'node:assert/strict';

import { parseLog } from '../src/git/logParser.ts';
import { parseRawDiff } from '../src/git/details.ts';
import { SearchMode, looksLikeCommitId, searchArgs } from '../src/git/search.ts';

const RS = '\x1e';
const NUL = '\x00';

function record(fields: string[]): string {
  return RS + fields.join(NUL);
}

test('a commit record round-trips through the parser', () => {
  const output = record([
    'a'.repeat(40),
    `${'b'.repeat(40)} ${'c'.repeat(40)}`,
    'Martin Wang',
    'martin@example.com',
    '2026-07-30T10:00:00+08:00',
    '2026-07-30T10:01:00+08:00',
    'HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1.0',
    'feat: something',
  ]);

  const [commit] = parseLog(output);

  assert.equal(commit?.sha, 'a'.repeat(40));
  assert.equal(commit?.parents.length, 2);
  assert.equal(commit?.author, 'Martin Wang');
  assert.equal(commit?.subject, 'feat: something');
  assert.equal(commit?.isHead, true);
  assert.deepEqual(commit?.refs, [
    { name: 'main', kind: 'local' },
    { name: 'origin/main', kind: 'remote' },
    { name: 'v1.0', kind: 'tag' },
  ]);
});

test('a subject containing the field separator cannot split a record', () => {
  // git folds %s to one line, but a subject can still contain almost anything else.
  const output = record([
    'a'.repeat(40),
    '',
    'A',
    'a@b',
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z',
    '',
    'fix: handle a, b, and "c" -> d',
  ]);

  const [commit] = parseLog(output);

  assert.equal(commit?.subject, 'fix: handle a, b, and "c" -> d');
  assert.deepEqual(commit?.parents, []);
});

test('origin/HEAD is skipped - it is an alias, not a branch', () => {
  const output = record([
    'a'.repeat(40),
    '',
    'A',
    'a@b',
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z',
    'refs/remotes/origin/HEAD, refs/remotes/origin/main',
    'x',
  ]);

  assert.deepEqual(parseLog(output)[0]?.refs, [{ name: 'origin/main', kind: 'remote' }]);
});

test('a detached HEAD marks the commit without inventing a branch', () => {
  const output = record([
    'a'.repeat(40),
    '',
    'A',
    'a@b',
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z',
    'HEAD',
    'x',
  ]);

  const [commit] = parseLog(output);

  assert.equal(commit?.isHead, true);
  assert.deepEqual(commit?.refs, []);
});

test('raw diff records give both blob sides', () => {
  const raw =
    ':100644 100644 aaaaaaa bbbbbbb M\x00src/app.ts\x00' +
    ':000000 100644 0000000 ccccccc A\x00src/new.ts\x00' +
    ':100644 000000 ddddddd 0000000 D\x00src/gone.ts\x00';

  const files = parseRawDiff(raw);

  assert.equal(files.length, 3);
  assert.equal(files[0]?.status, 'M');
  assert.equal(files[0]?.oldBlob, 'aaaaaaa');
  assert.equal(files[0]?.newBlob, 'bbbbbbb');

  assert.equal(files[1]?.status, 'A');
  assert.equal(files[1]?.oldBlob, null, 'an added file has no previous blob');

  assert.equal(files[2]?.status, 'D');
  assert.equal(files[2]?.newBlob, null, 'a deleted file has no new blob');
});

test('a rename record consumes two paths, not one', () => {
  // Getting this wrong shifts every subsequent record by one field.
  const raw =
    ':100644 100644 aaaaaaa bbbbbbb R096\x00old/name.ts\x00new/name.ts\x00' +
    ':100644 100644 ccccccc ddddddd M\x00after.ts\x00';

  const files = parseRawDiff(raw);

  assert.equal(files.length, 2);
  assert.equal(files[0]?.status, 'R');
  assert.equal(files[0]?.oldPath, 'old/name.ts');
  assert.equal(files[0]?.path, 'new/name.ts');
  assert.equal(files[0]?.similarity, 96);
  assert.equal(files[1]?.path, 'after.ts', 'the record after a rename must not be misaligned');
});

test('paths with spaces and non-ASCII survive -z', () => {
  const raw = ':100644 100644 aaaaaaa bbbbbbb M\x00docs/使用說明 v2.md\x00';

  assert.equal(parseRawDiff(raw)[0]?.path, 'docs/使用說明 v2.md');
});

test('search terms become git arguments, one argv entry each', () => {
  assert.deepEqual(searchArgs({ query: 'fix bug', mode: SearchMode.Message }), [
    '--regexp-ignore-case',
    '--grep=fix bug',
  ]);

  assert.deepEqual(searchArgs({ query: 'martin', mode: SearchMode.Author }), [
    '--regexp-ignore-case',
    '--author=martin',
  ]);

  assert.deepEqual(searchArgs({ query: 'TODO', mode: SearchMode.Content }), [
    '--regexp-ignore-case',
    '-GTODO',
  ]);
});

test('a path filter goes last, behind --', () => {
  const args = searchArgs({ query: 'src/app.ts', mode: SearchMode.Path });

  assert.deepEqual(args, ['--', 'src/app.ts']);
  assert.equal(args[args.length - 2], '--', 'git reads anything before -- as a revision');
});

test('a query that looks like a flag stays one argument', () => {
  // No shell is involved, so this is inert - but it must not be split or dropped either.
  assert.deepEqual(searchArgs({ query: '--upload-pack=evil', mode: SearchMode.Message }), [
    '--regexp-ignore-case',
    '--grep=--upload-pack=evil',
  ]);
});

test('an empty or absent search filters nothing', () => {
  assert.deepEqual(searchArgs(null), []);
  assert.deepEqual(searchArgs({ query: '   ', mode: SearchMode.Message }), []);
});

test('commit ids are told apart from search text', () => {
  assert.equal(looksLikeCommitId('1883db13'), true);
  assert.equal(looksLikeCommitId('a'.repeat(40)), true);
  assert.equal(looksLikeCommitId('abc'), false, 'too short to be an abbreviation');
  assert.equal(looksLikeCommitId('deadbeeg'), false, 'g is not hex');
  assert.equal(looksLikeCommitId('fix: cafebabe'), false);
});
