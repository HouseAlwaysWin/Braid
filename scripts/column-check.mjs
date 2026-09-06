/**
 * Do the column controls still reach the stylesheet?
 *
 * The layout is split across two files on purpose. The webview's content security policy has no
 * `unsafe-inline` for styles, so a generated stylesheet is not available; what the script can do is
 * set custom properties, and what the stylesheet does is read them. That works, and it fails
 * silently: rename a property on one side and the columns stop resizing, stop hiding, or quietly
 * lose their alignment with the header - with no error anywhere, because a `var()` that resolves to
 * nothing falls back and a `setProperty` nobody reads is not an error.
 *
 * So the two halves are checked against each other. Every property the script sets has to be read
 * by a rule, every property a rule reads has to be set by the script, and every column has to have
 * both of its rules - the header's and the row's - because a column whose header moved and whose
 * cells did not is the one failure that looks like working software.
 *
 *   node scripts/column-check.mjs
 */

import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/webview/style.css', import.meta.url), 'utf8');
const script = readFileSync(new URL('../src/webview/main.ts', import.meta.url), 'utf8');
const markup = readFileSync(new URL('../src/webview/markup.ts', import.meta.url), 'utf8');

const problems = [];

/** The columns the script says are resizable, read out of the script rather than written here. */
const declared = [...script.matchAll(/\{ key: '([a-z]+)', label: '([A-Za-z]+)', fallback: '([^']+)' \}/g)].map(
  ([, key, label, fallback]) => ({ key, label, fallback }),
);

if (declared.length === 0) {
  problems.push('found no column declarations in main.ts - has FIXED_COLUMNS moved or changed shape?');
}

console.log(`columns        : ${declared.map((c) => `${c.label} (${c.fallback})`).join(', ')}`);

/** Properties each side names. */
const set = new Set([...script.matchAll(/setProperty\(\s*`--weft-col-\$\{column\.key\}(-show)?`/g)].map(
  ([, suffix]) => suffix ?? '',
));
const read = new Set([...css.matchAll(/var\(--weft-col-([a-z]+)(-show)?/g)].map(([, key, suffix]) => `${key}${suffix ?? ''}`));

console.log(`css reads      : ${[...read].sort().join(', ') || '(nothing)'}`);

for (const column of declared) {
  // The header cell and the row cell are different elements with different default displays, so
  // each column needs two rules. One of them alone is a column that half-moves.
  const header = new RegExp(`#columns \\.col\\[data-sort='${column.key}'\\]`).test(css);
  const cell = new RegExp(`^\\.${column.key} \\{`, 'm').test(css);

  if (!header) {
    problems.push(`${column.label} has no header rule, so its header will not move or hide`);
  }

  if (!cell) {
    problems.push(`${column.label} has no row rule, so its cells will not move or hide`);
  }

  if (!read.has(column.key)) {
    problems.push(`nothing in the stylesheet reads --weft-col-${column.key}`);
  }

  if (!read.has(`${column.key}-show`)) {
    problems.push(`nothing in the stylesheet reads --weft-col-${column.key}-show, so hiding it will not hide it`);
  }
}

// And the other direction: a rule reading a property for a column that no longer exists is dead.
for (const name of read) {
  const key = name.replace(/-show$/, '');

  if (!declared.some((column) => column.key === key)) {
    problems.push(`the stylesheet reads --weft-col-${name}, which no column declares`);
  }
}

if (!set.has('') || !set.has('-show')) {
  problems.push('main.ts no longer sets both the track and the visibility properties');
}

/*
 * The grips are absolutely positioned by measurement, which only works if the bar they sit in is
 * itself positioned. This is the one line whose absence moves all three of them to the corner of
 * the window, and it is three lines away from the rules that would make that look deliberate.
 */
if (!/#columns \{[^}]*position: relative/s.test(css)) {
  problems.push('#columns is not positioned, so the grips will not sit on their columns');
}

// Every row emits all four cells whatever is hidden, so the subject has to name its track too -
// otherwise it takes whichever one is free and the graph's text lands under the wrong heading.
if (!/\.cell-subject \{\s*grid-column: 1;/.test(css) && !/grid-column: 1;/.test(css)) {
  problems.push('the subject cell does not name its grid track');
}

/*
 * The lanes have a grip too, and it is the one that matters most on a wide history: without it the
 * graph takes whatever it needs and the subject column becomes `feat(s…`. It is not one of the
 * declared columns - the lanes are the header's left padding rather than a track - so it is checked
 * separately, and the markup and the script have to agree on the name.
 */
const graphGrip = /data-grip=['"]graph['"]/.test(markup);
const graphHandled = /grip\.dataset\['grip'\] === 'graph'/.test(script) || /=== 'graph'/.test(script);

console.log(`lane grip      : ${graphGrip ? 'in the markup' : 'MISSING'}, ${graphHandled ? 'handled' : 'UNHANDLED'}`);

if (!graphGrip) {
  problems.push('there is no grip for the lanes, so a wide graph cannot be given less room');
}

if (!graphHandled) {
  problems.push('nothing in main.ts handles the lane grip, so dragging it does nothing');
}

// And the ceiling that applies before anybody drags anything. A graph with no cap is the state the
// grip exists to rescue people from, and a default nobody has to discover is better than a rescue.
if (!/function laneWidth\(\)/.test(script) || !/clientWidth \/ 3/.test(script)) {
  problems.push('the lanes have no default ceiling, so a wide history takes the whole panel');
}

console.log('');

for (const problem of problems) {
  console.error(`  ! ${problem}`);
}

console.log(problems.length === 0 ? 'OK - the column controls reach the stylesheet.' : 'FAILED');
process.exit(problems.length === 0 ? 0 : 1);
