/**
 * Does the author tint actually work?
 *
 * The stylesheet claims two things that are easy to assert and hard to eyeball: that all twelve
 * hues are equally readable, and that they are far enough apart to read as different colours. Both
 * are measurable, so they get measured rather than believed - the same reason `icon-check.mjs`
 * rasterises the icon at its real size instead of trusting that it looks fine at 512px.
 *
 * The lightness and chroma are read out of style.css and the hue count out of authorColor.ts, so
 * this cannot quietly pass against numbers the extension no longer ships.
 *
 *   node scripts/color-check.mjs
 */

import { readFileSync } from 'node:fs';

import { AUTHOR_HUES, authorHue } from '../src/webview/authorColor.ts';

/** Text this size is "normal text" to WCAG, so the AA floor is 4.5:1, not 3:1. */
const FLOOR = 4.5;

/**
 * Two colours closer than this in OKLab read as the same colour side by side. ~0.02 is one just
 * noticeable difference; a list you scan rather than study needs more margin than that.
 */
const MIN_SEPARATION = 0.04;

/* ---------------------------------------------------------------- colour maths */

const srgbFromLinear = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const linearFromSrgb = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** OKLCH -> linear sRGB (Bjorn Ottosson's matrices). May land outside 0..1: that is out of gamut. */
function oklchToLinear(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function linearToOklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

const inGamut = ([r, g, b]) => [r, g, b].every((c) => c >= -0.0001 && c <= 1.0001);

/**
 * What the browser will actually paint.
 *
 * An out-of-gamut oklch() is not clipped channel by channel - that would shift the hue and the
 * lightness both. CSS Color 4 walks the chroma down until the colour fits, holding L and h, which
 * is what this does. So a hue that cannot reach the requested chroma comes back duller, never
 * lighter and never a different colour.
 */
function render(L, C, h) {
  if (inGamut(oklchToLinear(L, C, h))) {
    return { linear: oklchToLinear(L, C, h), chroma: C, clipped: false };
  }

  let lo = 0;
  let hi = C;

  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;

    if (inGamut(oklchToLinear(L, mid, h))) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  return { linear: oklchToLinear(L, lo, h), chroma: lo, clipped: true };
}

const clamp01 = (c) => Math.min(1, Math.max(0, c));

const hex = (linear) =>
  '#' +
  linear
    .map((c) => Math.round(srgbFromLinear(clamp01(c)) * 255).toString(16).padStart(2, '0'))
    .join('');

const luminance = ([r, g, b]) => 0.2126 * clamp01(r) + 0.7152 * clamp01(g) + 0.0722 * clamp01(b);

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function fromHex(text) {
  const n = parseInt(text.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => linearFromSrgb(c / 255));
}

function distance(a, b) {
  const x = linearToOklab(a);
  const y = linearToOklab(b);
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/* ---------------------------------------------------------------- what ships */

/** Pull a custom property out of style.css, so this checks the real values, not a copy of them. */
function cssVar(css, name, after) {
  const scope = after === undefined ? css : css.slice(css.indexOf(after));
  const match = new RegExp('--' + name + ':\\s*([^;]+);').exec(scope);

  if (match === null) {
    throw new Error(`style.css no longer defines --${name}${after === undefined ? '' : ` under ${after}`}`);
  }

  return match[1].trim();
}

const css = readFileSync(new URL('../src/webview/style.css', import.meta.url), 'utf8');
const number = (v) => (v.includes('%') ? Number(v.replace('%', '')) / 100 : Number(v));

const themes = [
  {
    name: 'dark',
    // Dark Modern and Light Modern, the same values the preview harness uses.
    background: '#1f1f1f',
    baseline: '#9d9d9d',
    L: number(cssVar(css, 'weft-author-l')),
    C: number(cssVar(css, 'weft-author-c')),
  },
  {
    name: 'light',
    background: '#ffffff',
    baseline: '#717171',
    L: number(cssVar(css, 'weft-author-l', 'body.vscode-light')),
    C: number(cssVar(css, 'weft-author-c', 'body.vscode-light')),
  },
];

const problems = [];

for (const theme of themes) {
  const bg = fromHex(theme.background);
  const base = contrast(fromHex(theme.baseline), bg);

  console.log(
    `\n${theme.name}  L=${(theme.L * 100).toFixed(0)}% C=${theme.C}  on ${theme.background}` +
      `   (plain grey ${theme.baseline} is ${base.toFixed(2)}:1)`,
  );

  const swatches = [];

  for (let i = 0; i < AUTHOR_HUES; i++) {
    const h = i * (360 / AUTHOR_HUES);
    const { linear, chroma, clipped } = render(theme.L, theme.C, h);
    const ratio = contrast(linear, bg);

    swatches.push({ h, linear, ratio });

    console.log(
      `  ${String(h).padStart(3)}deg  ${hex(linear)}  ${ratio.toFixed(2)}:1` +
        (clipped ? `  (chroma clipped to ${chroma.toFixed(3)})` : ''),
    );

    if (ratio < FLOOR) {
      problems.push(`${theme.name}: hue ${h} is ${ratio.toFixed(2)}:1, under the ${FLOOR}:1 floor`);
    }
  }

  /*
   * The point of oklch is that the whole set reads at one volume. A wide spread would mean some
   * authors shout and others are hard to read, which is worse than the grey it replaced.
   */
  const ratios = swatches.map((s) => s.ratio);
  const spread = Math.max(...ratios) / Math.min(...ratios);

  console.log(
    `  spread ${Math.min(...ratios).toFixed(2)}..${Math.max(...ratios).toFixed(2)}` +
      ` (x${spread.toFixed(2)}), grey was ${base.toFixed(2)}`,
  );

  if (spread > 1.5) {
    problems.push(
      `${theme.name}: contrast swings x${spread.toFixed(2)} across hues - lower the chroma`,
    );
  }

  // Neighbours are the hard case: if 0deg and 30deg are tellable apart, everything else is.
  let closest = Infinity;
  let closestPair = '';

  for (let i = 0; i < swatches.length; i++) {
    const a = swatches[i];
    const b = swatches[(i + 1) % swatches.length];
    const d = distance(a.linear, b.linear);

    if (d < closest) {
      closest = d;
      closestPair = `${a.h}deg vs ${b.h}deg`;
    }
  }

  console.log(`  closest neighbours ${closestPair}: ${closest.toFixed(3)} OKLab apart`);

  if (closest < MIN_SEPARATION) {
    problems.push(
      `${theme.name}: ${closestPair} are only ${closest.toFixed(3)} apart, under ${MIN_SEPARATION}`,
    );
  }
}

/* ---------------------------------------------------------------- the hash itself */

/**
 * Even hues are no use if the hash piles everyone onto two of them. Real names rather than
 * `user1..userN`, because sequential names are the one input every hash spreads perfectly.
 */
const NAMES = [
  'Martin Wang',
  'MartinWang',
  'Linus Torvalds',
  'Junio C Hamano',
  'Jeff King',
  'Elijah Newren',
  'Derrick Stolee',
  'Taylor Blau',
  'Patrick Steinhardt',
  'Johannes Schindelin',
  '王小明',
  '陳大文',
  'dependabot[bot]',
  'github-actions',
];

const buckets = new Map();
const step = 360 / AUTHOR_HUES;

for (const name of NAMES) {
  const h = authorHue(name);

  // The stylesheet feeds this straight into oklch(), which has no opinion about 400 or -30.
  if (!Number.isInteger(h / step) || h < 0 || h >= 360) {
    problems.push(`authorHue(${JSON.stringify(name)}) returned ${h}, not a step of ${step} in 0..360`);
  }

  buckets.set(h, [...(buckets.get(h) ?? []), name]);
}

console.log(`\n${NAMES.length} names over ${AUTHOR_HUES} hues -> ${buckets.size} distinct`);

for (const [h, names] of [...buckets].sort((a, b) => a[0] - b[0])) {
  console.log(`  ${String(h).padStart(3)}deg  ${names.join(', ')}`);
}

// With more names than buckets some sharing is arithmetic, not a bad hash. Piling up is the signal.
const worst = Math.max(...[...buckets.values()].map((names) => names.length));

if (worst > 3) {
  problems.push(`the hash put ${worst} of ${NAMES.length} names on one hue`);
}

console.log('');

for (const problem of problems) {
  console.error(`  ! ${problem}`);
}

console.log(problems.length === 0 ? 'OK - every tint is readable and distinguishable.' : 'FAILED');
process.exit(problems.length === 0 ? 0 : 1);
