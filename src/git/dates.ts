/**
 * Narrowing the walk to a stretch of time.
 *
 * Three things about git's date options are not what a reading of the flag names suggests, and all
 * three were measured rather than assumed:
 *
 * - **A bare `YYYY-MM-DD` is not midnight.** git's approxidate fills the unspecified fields from the
 *   *current clock*, so `--since=2026-07-24` run at 20:08 means `2026-07-24 20:08` - it silently
 *   drops that morning's commits, and the same query answers differently an hour later. Measured on
 *   a 99-commit repository: `--since=2026-07-24` returned 1 commit where the day held 12. Every
 *   bound here therefore carries an explicit time.
 *
 * - **`--until=<day>` excludes that day.** It means "before 00:00", so an inclusive end date has to
 *   ask for `23:59:59`.
 *
 * - **`--since` stops walking rather than filtering.** It prunes a line of history at the first
 *   commit older than the cutoff, which is right when committer dates decrease along parent links
 *   and wrong when they do not - a rewritten or imported history can hide newer commits behind an
 *   older one. `--since-as-filter` (git 2.37) visits everything and filters instead, so it is used
 *   wherever git is new enough. It gives up the early exit, which streaming makes affordable: rows
 *   still appear as they are found, the walk just takes longer to finish.
 *
 * What none of them do is look at the author date. `--since` and `--until` compare the *committer*
 * date, while the graph's Date column shows the author's - identical for ordinary history, and
 * different for anything rebased or cherry-picked.
 */

/** A day, `YYYY-MM-DD`, as an `<input type="date">` produces it. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface DateRange {
  /** First day to include, or null for no lower bound. */
  readonly since: string | null;
  /** Last day to include - inclusive, unlike git's own `--until`. */
  readonly until: string | null;
}

/** Whether a bound is a day git can be trusted with, rather than whatever arrived over the wire. */
export function isDay(value: unknown): value is string {
  return typeof value === 'string' && DAY.test(value);
}

/**
 * `git log` arguments for a date range, or an empty list when there is nothing to narrow.
 *
 * `sinceAsFilter` is whether git is new enough for `--since-as-filter`; on anything older the
 * traversal cutoff is the only lower bound on offer.
 */
export function dateArgs(range: DateRange | null, sinceAsFilter: boolean): string[] {
  if (range === null) {
    return [];
  }

  const args: string[] = [];

  if (isDay(range.since)) {
    const flag = sinceAsFilter ? '--since-as-filter' : '--since';
    args.push(`${flag}=${range.since} 00:00:00`);
  }

  if (isDay(range.until)) {
    args.push(`--until=${range.until} 23:59:59`);
  }

  return args;
}
