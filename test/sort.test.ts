import test from 'node:test';
import assert from 'node:assert/strict';

import type { SortableRow } from '../src/webview/sort.ts';
import { FIRST_DIRECTION, sortRows } from '../src/webview/sort.ts';

function row(sha: string, author: string, date: string, subject = 'subject'): SortableRow {
  return { sha, author, date, subject };
}

const shas = (rows: readonly SortableRow[]): string[] => rows.map((r) => r.sha);

test('sorting leaves the graph order it was given untouched', () => {
  const rows = [row('c', 'Zoe', '2026-01-03'), row('a', 'Ada', '2026-01-01')];
  const before = shas(rows);

  sortRows(rows, { column: 'author', direction: 'asc' });

  assert.deepEqual(shas(rows), before);
});

test('commits by the same author keep the order history put them in', () => {
  const rows = [
    row('newest', 'Ada', '2026-01-03T00:00:00+00:00'),
    row('middle', 'Zoe', '2026-01-02T00:00:00+00:00'),
    row('oldest', 'Ada', '2026-01-01T00:00:00+00:00'),
  ];

  // Ada's two commits stay newest-then-oldest. A sort that shuffled them would make the list move
  // under someone who only asked to group it by name.
  assert.deepEqual(shas(sortRows(rows, { column: 'author', direction: 'asc' })), [
    'newest',
    'oldest',
    'middle',
  ]);

  // Reversing swaps the *groups*, not the rows inside one: Zoe first, Ada's pair unchanged.
  assert.deepEqual(shas(sortRows(rows, { column: 'author', direction: 'desc' })), [
    'middle',
    'newest',
    'oldest',
  ]);
});

test('a date column sorts by the instant, not by the text of the timestamp', () => {
  /*
   * These two are eight hours apart in the direction the strings deny: 01:00+08:00 is 17:00 the
   * previous day in UTC, so the row that reads as later is the earlier commit. `%aI` carries every
   * author's own offset, so this is not a contrived case - it is any repository with contributors
   * in two timezones.
   */
  const rows = [row('east', 'Ada', '2026-03-02T01:00:00+08:00'), row('west', 'Zoe', '2026-03-01T20:00:00-05:00')];

  assert.deepEqual(shas(sortRows(rows, { column: 'date', direction: 'asc' })), ['east', 'west']);
  assert.deepEqual(shas(sortRows(rows, { column: 'date', direction: 'desc' })), ['west', 'east']);
});

test('a version in a subject sorts by number, not by digit', () => {
  const rows = [
    row('b', 'Ada', '2026-01-01', 'chore: release v10.0'),
    row('a', 'Ada', '2026-01-01', 'chore: release v9.0'),
  ];

  assert.deepEqual(shas(sortRows(rows, { column: 'subject', direction: 'asc' })), ['a', 'b']);
});

test('a name typed in the wrong case is not filed twice', () => {
  const rows = [
    row('1', 'ada lovelace', '2026-01-01'),
    row('2', 'Zoe', '2026-01-01'),
    row('3', 'Ada Lovelace', '2026-01-01'),
  ];

  assert.deepEqual(shas(sortRows(rows, { column: 'author', direction: 'asc' })), ['1', '3', '2']);
});

test('hashes sort as hashes', () => {
  const rows = [row('ff0', 'Ada', '2026-01-01'), row('0af', 'Ada', '2026-01-01')];

  assert.deepEqual(shas(sortRows(rows, { column: 'sha', direction: 'asc' })), ['0af', 'ff0']);
  assert.deepEqual(shas(sortRows(rows, { column: 'sha', direction: 'desc' })), ['ff0', '0af']);
});

test('a date column opens newest first - the order it already had in the graph', () => {
  assert.equal(FIRST_DIRECTION.date, 'desc');
  assert.equal(FIRST_DIRECTION.author, 'asc');
  assert.equal(FIRST_DIRECTION.subject, 'asc');
});
