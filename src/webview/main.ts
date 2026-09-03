/**
 * The graph view.
 *
 * Two things are kept deliberately separate:
 *
 * - **Rows are DOM**, so text selection, theming and accessibility come for free. Only the visible
 *   window exists as elements; the scrollbar comes from one tall spacer.
 * - **Lanes are canvas**, drawn over the scroller rather than inside it. Putting the canvas in the
 *   scrolling content would mean either one canvas the height of the whole history (which no
 *   browser will allocate at 100k rows) or per-row canvases (which shreds the lines at the seams).
 *
 * The two stay locked together because the layout's Y coordinate is in *rows*, not pixels: a point
 * at `y` is drawn at `y * rowHeight - scrollTop`, which is exactly where the matching row div is.
 */

import type { GraphDelta, PathDelta } from '../graph/layout.ts';
import type { GraphDot, Point } from '../graph/model.ts';
import { DotKind } from '../graph/model.ts';
import type { CommitDetails, FileChange } from '../git/details.ts';
import type { SearchMode } from '../git/search.ts';
import type { HostMessage, Row, WebviewMessage } from '../protocol.ts';

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// Must be called exactly once - a second call throws.
const vscode = acquireVsCodeApi();

const LANE_COLORS = 10;
const DOT_RADIUS = 3.5;

const header = document.getElementById('header') as HTMLElement;
const titleEl = document.getElementById('title') as HTMLElement;
const statusEl = document.getElementById('status') as HTMLElement;
const viewport = document.getElementById('viewport') as HTMLElement;
const spacer = document.getElementById('spacer') as HTMLElement;
const rowsEl = document.getElementById('rows') as HTMLElement;
const canvas = document.getElementById('graph') as HTMLCanvasElement;
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
const detailsEl = document.getElementById('details') as HTMLElement;
const detailMetaEl = document.getElementById('detail-meta') as HTMLElement;
const detailBodyEl = document.getElementById('detail-body') as HTMLElement;
const detailFilesEl = document.getElementById('detail-files') as HTMLElement;

let rowHeight = 24;
let graphWidth = 0;
let rows: Row[] = [];
let selected = -1;
const paths = new Map<number, { color: number; points: Point[] }>();
let dots: GraphDot[] = [];
let palette: string[] = [];
let pending = false;

function readPalette(): string[] {
  const style = getComputedStyle(document.documentElement);
  const out: string[] = [];

  for (let i = 0; i < LANE_COLORS; i++) {
    out.push(style.getPropertyValue(`--braid-lane-${i}`).trim() || '#888');
  }

  return out;
}

function schedule(): void {
  if (pending) {
    return;
  }

  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    render();
  });
}

function render(): void {
  renderRows();
  drawGraph();
}

/** Rebuild only the row elements the viewport can actually show. */
function renderRows(): void {
  const scrollTop = viewport.scrollTop;
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - 1);
  const visible = Math.ceil(viewport.clientHeight / rowHeight) + 2;
  const last = Math.min(rows.length, first + visible);

  const frag = document.createDocumentFragment();

  for (let i = first; i < last; i++) {
    const row = rows[i];
    if (row === undefined) {
      continue;
    }

    const el = document.createElement('div');
    el.className = i === selected ? 'row selected' : 'row';
    el.style.top = `${i * rowHeight}px`;
    el.style.paddingLeft = `${graphWidth + 8}px`;

    for (const ref of row.refs) {
      const badge = document.createElement('span');
      badge.className = `ref ${ref.kind}`;
      badge.textContent = ref.name;
      el.append(badge);
    }

    const subject = document.createElement('span');
    subject.className = 'subject';
    subject.textContent = row.subject;
    el.append(subject);

    const author = document.createElement('span');
    author.className = 'author';
    author.textContent = row.author;
    el.append(author);

    const date = document.createElement('span');
    date.className = 'date';
    date.textContent = row.date.slice(0, 10);
    el.append(date);

    const sha = document.createElement('span');
    sha.className = 'sha';
    sha.textContent = row.sha.slice(0, 8);
    el.append(sha);

    el.addEventListener('click', () => select(i));
    frag.append(el);
  }

  rowsEl.replaceChildren(frag);
}

/** Move the selection, keep it on screen, and ask the host for that commit's details. */
function select(index: number): void {
  if (index < 0 || index >= rows.length || index === selected) {
    return;
  }

  selected = index;
  const row = rows[index];

  if (row !== undefined) {
    vscode.postMessage({ type: 'selectCommit', sha: row.sha });
  }

  const top = index * rowHeight;
  const bottom = top + rowHeight;

  if (top < viewport.scrollTop) {
    viewport.scrollTop = top;
  } else if (bottom > viewport.scrollTop + viewport.clientHeight) {
    viewport.scrollTop = bottom - viewport.clientHeight;
  }

  schedule();
}

const STATUS_LABEL: Record<string, string> = {
  A: 'added',
  C: 'copied',
  D: 'deleted',
  M: 'modified',
  R: 'renamed',
  T: 'type changed',
  U: 'unmerged',
  X: 'unknown',
};

function renderDetails(details: CommitDetails): void {
  detailsEl.hidden = false;

  const meta = document.createDocumentFragment();

  const line = (label: string, value: string): void => {
    const wrap = document.createElement('div');
    const key = document.createElement('span');
    key.className = 'meta-key';
    key.textContent = label;
    const val = document.createElement('span');
    val.className = 'meta-value';
    val.textContent = value;
    wrap.append(key, val);
    meta.append(wrap);
  };

  line('commit', details.sha);
  line('author', `${details.author} <${details.authorEmail}>  ${details.authorDate.slice(0, 19).replace('T', ' ')}`);

  if (details.parents.length > 0) {
    line('parents', details.parents.map((p) => p.slice(0, 8)).join('  '));
  }

  detailMetaEl.replaceChildren(meta);
  detailBodyEl.textContent = details.body;

  const files = document.createDocumentFragment();
  const heading = document.createElement('div');
  heading.className = 'files-heading';
  heading.textContent =
    details.files.length === 1 ? '1 file changed' : `${details.files.length} files changed`;
  files.append(heading);

  details.files.forEach((file: FileChange, index) => {
    const el = document.createElement('div');
    el.className = 'file';
    el.title = `${STATUS_LABEL[file.status] ?? file.status}: ${file.path}`;

    const badge = document.createElement('span');
    badge.className = `status status-${file.status}`;
    badge.textContent = file.status;

    const path = document.createElement('span');
    path.className = 'file-path';
    path.textContent =
      file.oldPath === null ? file.path : `${file.oldPath} → ${file.path}`;

    el.append(badge, path);
    el.addEventListener('click', () =>
      vscode.postMessage({ type: 'openDiff', sha: details.sha, index }),
    );

    files.append(el);
  });

  detailFilesEl.replaceChildren(files);
}

function drawGraph(): void {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(graphWidth, 1);
  const height = viewport.clientHeight;

  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const scrollTop = viewport.scrollTop;
  const topRow = scrollTop / rowHeight;
  const bottomRow = (scrollTop + height) / rowHeight;
  const y = (row: number): number => row * rowHeight - scrollTop;

  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  for (const path of paths.values()) {
    const pts = path.points;
    const firstPt = pts[0];
    const lastPt = pts[pts.length - 1];

    // A lane entirely above or below the viewport costs two comparisons and nothing else.
    if (pts.length < 2 || firstPt === undefined || lastPt === undefined) {
      continue;
    }

    if (lastPt.y < topRow || firstPt.y > bottomRow) {
      continue;
    }

    ctx.strokeStyle = palette[path.color % LANE_COLORS] ?? '#888';
    ctx.beginPath();
    ctx.moveTo(firstPt.x, y(firstPt.y));

    for (let i = 1; i < pts.length; i++) {
      const p = pts[i] as Point;
      ctx.lineTo(p.x, y(p.y));
    }

    ctx.stroke();
  }

  const firstDot = Math.max(0, Math.floor(topRow) - 1);
  const lastDot = Math.min(dots.length, Math.ceil(bottomRow) + 1);

  for (let i = firstDot; i < lastDot; i++) {
    const dot = dots[i];
    if (dot === undefined) {
      continue;
    }

    const color = palette[dot.color % LANE_COLORS] ?? '#888';
    const cy = y(dot.center.y);

    ctx.beginPath();
    ctx.arc(dot.center.x, cy, dot.kind === DotKind.Head ? DOT_RADIUS + 1.5 : DOT_RADIUS, 0, Math.PI * 2);

    if (dot.kind === DotKind.Merge) {
      // A merge is drawn hollow so it reads differently at a glance without needing a legend.
      ctx.fillStyle = getComputedStyle(document.documentElement)
        .getPropertyValue('--braid-bg')
        .trim();
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.stroke();
    } else {
      ctx.fillStyle = color;
      ctx.fill();
    }

    if (dot.kind === DotKind.Head) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(dot.center.x, cy, DOT_RADIUS + 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1.5;
    }
  }
}

function applyDelta(delta: GraphDelta): void {
  graphWidth = Math.max(graphWidth, delta.width);
  dots.push(...delta.dots);

  for (const p of delta.paths as readonly PathDelta[]) {
    const existing = paths.get(p.id);
    if (existing === undefined) {
      paths.set(p.id, { color: p.color, points: [...p.points] });
    } else {
      existing.points.push(...p.points);
    }
  }
}

function reset(): void {
  rows = [];
  dots = [];
  paths.clear();
  graphWidth = 0;
  selected = -1;
  spacer.style.height = '0px';
  rowsEl.replaceChildren();
  detailsEl.hidden = true;
  header.classList.remove('error');
  statusEl.textContent = 'loading…';
}

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const message = event.data;

  switch (message.type) {
    case 'init':
      rowHeight = message.rowHeight;
      document.documentElement.style.setProperty('--braid-row-height', `${rowHeight}px`);
      titleEl.textContent = message.kind === null
        ? message.repoName
        : `${message.repoName}  (${message.kind})`;
      titleEl.title = message.repoRoot;
      palette = readPalette();
      break;

    case 'reset':
      reset();
      break;

    case 'page':
      rows.push(...message.rows);
      applyDelta(message.delta);
      spacer.style.height = `${rows.length * rowHeight}px`;
      statusEl.textContent = `${rows.length.toLocaleString()} commits…`;
      schedule();
      break;

    case 'done':
      // An empty result is a real answer, not a blank screen waiting for more.
      statusEl.textContent =
        message.total === 0
          ? 'no matching commits'
          : `${message.total.toLocaleString()} commits in ${message.elapsedMs} ms`;
      schedule();
      break;

    case 'details':
      renderDetails(message.details);
      break;

    case 'reloading':
      statusEl.textContent = `${message.reason} — reloading…`;
      break;

    case 'error':
      statusEl.textContent = message.message;
      header.classList.add('error');
      break;

    default:
      break;
  }
});

viewport.addEventListener('scroll', schedule, { passive: true });
window.addEventListener('resize', schedule);

/*
 * Search is debounced and pushed down to git: every keystroke would otherwise start a fresh walk of
 * the history. 300ms is long enough that typing a word costs one query, short enough to feel live.
 */
const searchInput = document.getElementById('search-input') as HTMLInputElement;
const searchMode = document.getElementById('search-mode') as HTMLSelectElement;
let searchTimer: number | undefined;

function submitSearch(): void {
  const query = searchInput.value.trim();

  vscode.postMessage({
    type: 'search',
    search: query.length === 0 ? null : { query, mode: searchMode.value as SearchMode },
  });
}

function queueSearch(): void {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(submitSearch, 300);
}

searchInput.addEventListener('input', queueSearch);
searchMode.addEventListener('change', () => {
  if (searchInput.value.trim().length > 0) {
    submitSearch();
  }
});

searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    window.clearTimeout(searchTimer);
    submitSearch();
  } else if (event.key === 'Escape') {
    searchInput.value = '';
    submitSearch();
  }

  // Arrow keys belong to the text field while it has focus, not to the commit list.
  event.stopPropagation();
});

document.addEventListener('keydown', (event) => {
  if (event.ctrlKey && event.key === 'f') {
    searchInput.focus();
    searchInput.select();
    event.preventDefault();
    return;
  }

  const page = Math.max(1, Math.floor(viewport.clientHeight / rowHeight) - 1);
  const from = selected < 0 ? -1 : selected;

  switch (event.key) {
    case 'ArrowDown':
      select(from + 1);
      break;
    case 'ArrowUp':
      select(from - 1);
      break;
    case 'PageDown':
      select(Math.min(rows.length - 1, from + page));
      break;
    case 'PageUp':
      select(Math.max(0, from - page));
      break;
    case 'Home':
      select(0);
      break;
    case 'End':
      select(rows.length - 1);
      break;
    default:
      return;
  }

  event.preventDefault();
});

vscode.postMessage({ type: 'ready' });
