import test from 'node:test';
import assert from 'node:assert/strict';

import { parseLog } from '../src/git/logParser.ts';
import { parseRawDiff } from '../src/git/details.ts';
import type { Search } from '../src/git/search.ts';
import { SearchMode, TOGGLES, escapeBasicRegex, filterArgs, looksLikeCommitId, searchArgs } from '../src/git/search.ts';
import { authorArgs } from '../src/git/authors.ts';
import { dateArgs, isDay } from '../src/git/dates.ts';

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

/** A search with every switch off - what the box sends before anyone touches it. */
function plain(query: string, mode: SearchMode): Search {
  return { query, mode, regex: false, caseSensitive: false, allTerms: false, invert: false };
}

test('a plain query matches as text, not as a pattern', () => {
  // The dots are escaped, so `v0.4.1` cannot also match `v0X4Y1`. Escaping rather than passing
  // --fixed-strings is deliberate: that flag is global and would reach the Authors sidebar too.
  assert.deepEqual(searchArgs(plain('v0.4.1', SearchMode.Message)), [
    '--regexp-ignore-case',
    '--grep=v0\\.4\\.1',
  ]);

  assert.deepEqual(searchArgs(plain('martin', SearchMode.Author)), [
    '--regexp-ignore-case',
    '--author=martin',
  ]);

  assert.deepEqual(searchArgs(plain('TODO', SearchMode.Content)), [
    '--regexp-ignore-case',
    '-GTODO',
  ]);
});

test('the regex switch hands the query to git as written', () => {
  assert.deepEqual(searchArgs({ ...plain('v0.4..', SearchMode.Message), regex: true }), [
    '--regexp-ignore-case',
    '--grep=v0.4..',
  ]);
});

test('escaping follows git basic regex, not the JavaScript reflex', () => {
  /*
   * The trap: in a BRE, `+ ? ( ) { } |` are literal *until* you escape them - `\+` is the
   * one-or-more operator, so backslashing a plus is what breaks it. Only `\ . * [ ^ $` are
   * operators to begin with.
   */
  assert.equal(escapeBasicRegex('C++'), 'C++');
  assert.equal(escapeBasicRegex('A|B'), 'A|B');
  assert.equal(escapeBasicRegex('Foo (Bar)'), 'Foo (Bar)');
  assert.equal(escapeBasicRegex('a{2}'), 'a{2}');
  assert.equal(escapeBasicRegex('A. Person'), 'A\\. Person');
  assert.equal(escapeBasicRegex('a*b'), 'a\\*b');
  assert.equal(escapeBasicRegex('[x]'), '\\[x]');
  assert.equal(escapeBasicRegex('^start'), '\\^start');
});

test('match case drops the flag rather than adding one', () => {
  assert.deepEqual(searchArgs({ ...plain('Fix', SearchMode.Message), caseSensitive: true }), [
    '--grep=Fix',
  ]);
});

test('all terms intersects; one term has nothing to intersect', () => {
  assert.deepEqual(searchArgs({ ...plain('feat filter', SearchMode.Message), allTerms: true }), [
    '--regexp-ignore-case',
    '--all-match',
    '--grep=feat',
    '--grep=filter',
  ]);

  // --all-match is a global flag, so it is not sent when there is a single pattern to match.
  assert.deepEqual(searchArgs({ ...plain('feat', SearchMode.Message), allTerms: true }), [
    '--regexp-ignore-case',
    '--grep=feat',
  ]);
});

test('invert asks for the commits that did not match', () => {
  assert.deepEqual(searchArgs({ ...plain('wip', SearchMode.Message), invert: true }), [
    '--regexp-ignore-case',
    '--invert-grep',
    '--grep=wip',
  ]);
});

test('committer is its own field, not a synonym for author', () => {
  assert.deepEqual(searchArgs(plain('martin', SearchMode.Committer)), [
    '--regexp-ignore-case',
    '--committer=martin',
  ]);
});

test('a mode ignores the switches it cannot honour', () => {
  /*
   * --invert-grep inverts --grep and nothing else, and multiple -G do not intersect: a switch left
   * on from another mode has to be dropped rather than sent somewhere it means something else.
   */
  assert.deepEqual(TOGGLES[SearchMode.Content], ['caseSensitive', 'regex']);

  assert.deepEqual(
    searchArgs({ ...plain('TODO', SearchMode.Content), invert: true, allTerms: true }),
    ['--regexp-ignore-case', '-GTODO'],
  );

  // A pathspec is a glob with its own magic, so case travels inside it and regex is not offered.
  assert.deepEqual(searchArgs({ ...plain('src/app.ts', SearchMode.Path), regex: true }), [
    '--',
    ':(icase)src/app.ts',
  ]);
});

test('a path filter goes last, behind --', () => {
  const args = searchArgs({ ...plain('src/app.ts', SearchMode.Path), caseSensitive: true });

  assert.deepEqual(args, ['--', 'src/app.ts']);
  assert.equal(args[args.length - 2], '--', 'git reads anything before -- as a revision');
});

test('a query that looks like a flag stays one argument', () => {
  // No shell is involved, so this is inert - but it must not be split or dropped either.
  assert.deepEqual(searchArgs(plain('--upload-pack=evil', SearchMode.Message)), [
    '--regexp-ignore-case',
    '--grep=--upload-pack=evil',
  ]);
});

test('an empty or absent search filters nothing', () => {
  assert.deepEqual(searchArgs(null), []);
  assert.deepEqual(searchArgs(plain('   ', SearchMode.Message)), []);
});

test('every date bound carries an explicit time', () => {
  /*
   * The measured trap: git's approxidate fills a bare `YYYY-MM-DD` from the *current clock*, so
   * `--since=2026-07-24` run at 20:08 means 20:08 that day. On a 99-commit repository it returned
   * one commit where the day held twelve, and it would have answered differently an hour later.
   */
  assert.deepEqual(dateArgs({ since: '2026-07-24', until: null }, false), [
    '--since=2026-07-24 00:00:00',
  ]);

  // And `--until=<day>` means "before midnight", so an inclusive end has to spell out the day's end.
  assert.deepEqual(dateArgs({ since: null, until: '2026-07-26' }, false), [
    '--until=2026-07-26 23:59:59',
  ]);
});

test('a lower bound filters rather than stopping the walk, where git can', () => {
  /*
   * `--since` prunes a line of history at the first commit older than the cutoff, which hides newer
   * commits behind an older one. `--since-as-filter` visits everything instead - measured on a
   * two-commit repository with the dates crossed over, where `--since` found neither.
   */
  assert.deepEqual(dateArgs({ since: '2026-07-24', until: '2026-07-26' }, true), [
    '--since-as-filter=2026-07-24 00:00:00',
    '--until=2026-07-26 23:59:59',
  ]);
});

test('a bound git would guess at is not sent at all', () => {
  // `<input type="date">` yields a day or nothing, and anything else reaching here is a bug
  // somewhere - approxidate would accept `yesterday` and quietly mean something else tomorrow.
  assert.deepEqual(dateArgs({ since: 'yesterday', until: null }, true), []);
  assert.deepEqual(dateArgs({ since: '2026-7-4', until: null }, true), []);
  assert.deepEqual(dateArgs(null, true), []);

  assert.equal(isDay('2026-07-24'), true);
  assert.equal(isDay('last tuesday'), false);
});

test('an author filter cannot end up behind a path search', () => {
  /*
   * The one ordering git will not forgive. Behind `--` an `--author` is read as a filename, so the
   * author filter silently stops applying - the search still returns commits, just the wrong ones.
   */
  const args = filterArgs(
    plain('src/app.ts', SearchMode.Path),
    authorArgs(['Ada Lovelace']),
    dateArgs({ since: '2026-01-01', until: null }, true),
  );

  assert.deepEqual(args, [
    '--author=Ada Lovelace',
    '--since-as-filter=2026-01-01 00:00:00',
    '--',
    ':(icase)src/app.ts',
  ]);

  assert.ok(args.indexOf('--') === args.length - 2, 'nothing may follow the pathspec but the path');
});

test('commit ids are told apart from search text', () => {
  assert.equal(looksLikeCommitId('1883db13'), true);
  assert.equal(looksLikeCommitId('a'.repeat(40)), true);
  assert.equal(looksLikeCommitId('abc'), false, 'too short to be an abbreviation');
  assert.equal(looksLikeCommitId('deadbeeg'), false, 'g is not hex');
  assert.equal(looksLikeCommitId('fix: cafebabe'), false);
});
