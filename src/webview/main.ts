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
import type { MenuItem, Target } from '../actions/registry.ts';
import type { HostMessage, Row, WebviewMessage } from '../protocol.ts';
import { authorHue } from './authorColor.ts';

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
const splitter = document.getElementById('splitter') as HTMLElement;

type FileView = 'tree' | 'flat';

interface ViewState {
  readonly fileView?: FileView;
  readonly detailsHeight?: number;
}

let fileView: FileView = 'tree';
let detailsHeight = 260;
let currentDetails: CommitDetails | null = null;
/** Directories the user has folded away, keyed by full path so they survive a re-render. */
const collapsedDirs = new Set<string>();
/** Index into the current commit's file list, so the highlight survives a tree/flat switch. */
let selectedFileIndex = -1;
let selectedFileEl: HTMLElement | null = null;

/*
 * The panel is created with `retainContextWhenHidden: false`, so hiding the tab destroys this
 * webview and showing it again builds a new one. Layout choices would evaporate every time without
 * somewhere to put them - `setState` is that somewhere, and it costs nothing to keep warm.
 */
function saveViewState(): void {
  vscode.setState({ fileView, detailsHeight } satisfies ViewState);
}

function restoreViewState(): void {
  const state = vscode.getState() as ViewState | undefined;

  if (state?.fileView !== undefined) {
    fileView = state.fileView;
  }

  if (state?.detailsHeight !== undefined) {
    detailsHeight = state.detailsHeight;
  }
}

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

    if (row.stash !== undefined) {
      const badge = span('ref stash', row.stash);
      badge.title = `${row.stash}: ${row.subject}`;
      el.append(badge);
    }

    for (const ref of row.refs) {
      const badge = document.createElement('span');
      badge.className = `ref ${ref.kind}`;
      badge.textContent = ref.name;
      badge.title = refFullName(ref.kind, ref.name);
      badge.addEventListener('contextmenu', (event) => {
        event.stopPropagation();
        openMenu(event, {
          kind: 'ref',
          refName: refFullName(ref.kind, ref.name),
          label: ref.name,
          refKind: ref.kind,
        });
      });

      el.append(badge);
    }

    const subject = document.createElement('span');
    subject.className = 'subject';
    subject.textContent = row.subject;
    subject.title = row.subject;
    el.append(subject);

    const author = document.createElement('span');
    author.className = 'author';
    author.textContent = row.author;
    author.title = row.author;
    // Only the hue: the stylesheet holds the lightness, so the tint follows the theme.
    author.style.setProperty('--braid-author-hue', `${authorHue(row.author)}`);
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
    el.addEventListener('contextmenu', (event) =>
      openMenu(
        event,
        // A stash row is a commit underneath, but the actions worth offering are entirely different.
        row.stash === undefined
          ? { kind: 'commit', sha: row.sha, subject: row.subject }
          : { kind: 'stash', name: row.stash, sha: row.sha, message: row.subject },
      ),
    );

    frag.append(el);
  }

  rowsEl.replaceChildren(frag);
}

/** Move the selection, keep it on screen, and ask the host for that commit's details. */
function select(index: number): void {
  if (index < 0 || index >= rows.length) {
    return;
  }

  if (index === selected) {
    // Clicking the row that is already selected is how you ask for the pane back after closing it.
    // Without this, closing the pane makes that one row unclickable until you pick another.
    if (detailsEl.hidden && currentDetails !== null) {
      detailsEl.hidden = false;
      splitter.hidden = false;
      applyDetailsHeight(detailsHeight);
    }

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

/**
 * The full ref name git wants, rebuilt from the short label the row carries.
 *
 * The graph shows `origin/main`; git needs `refs/remotes/origin/main`. Passing the short form works
 * right up until a branch and a tag share a name, at which point git picks one and the user gets a
 * surprise - so the full name travels with every target.
 */
function refFullName(kind: string, name: string): string {
  switch (kind) {
    case 'remote':
      return `refs/remotes/${name}`;
    case 'tag':
      return `refs/tags/${name}`;
    default:
      return `refs/heads/${name}`;
  }
}

const operationEl = document.getElementById('operation') as HTMLElement;

/**
 * The banner for whatever git is halfway through.
 *
 * It is deliberately loud and deliberately at the top: an unfinished rebase changes what every
 * other action means, and a graph that draws history without mentioning it is how someone ends up
 * several commands deep in a state they did not know they were in.
 *
 * Conflicted files are listed and clickable. Braid does not resolve them - VS Code's merge editor
 * is better at that than anything that would fit here - so clicking one hands it over.
 */
function renderOperation(
  operation: string,
  description: string,
  conflicted: readonly string[],
  controls: readonly MenuItem[],
): void {
  if (operation === 'none') {
    operationEl.hidden = true;
    operationEl.replaceChildren();
    schedule();
    return;
  }

  const headline = document.createElement('div');
  headline.className = 'operation-headline';
  headline.append(span('operation-what', `You are in the middle of ${description}.`));

  const buttons = document.createElement('span');
  buttons.className = 'operation-controls';

  for (const control of controls) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = control.label;
    button.className = control.destructive ? 'destructive' : '';

    if (control.disabledReason === null) {
      button.addEventListener('click', () =>
        vscode.postMessage({ type: 'runAction', id: control.id, target: { kind: 'repo' } }),
      );
    } else {
      button.disabled = true;
      button.title = control.disabledReason;
    }

    buttons.append(button);
  }

  headline.append(buttons);
  operationEl.replaceChildren(headline);

  if (conflicted.length > 0) {
    const list = document.createElement('div');
    list.className = 'operation-conflicts';
    list.append(
      span(
        'operation-conflicts-heading',
        `${conflicted.length} ${conflicted.length === 1 ? 'file needs' : 'files need'} resolving:`,
      ),
    );

    for (const path of conflicted) {
      const entry = document.createElement('span');
      entry.className = 'operation-conflict';
      entry.textContent = path;
      entry.title = `Open ${path} in the merge editor`;
      entry.addEventListener('click', () => vscode.postMessage({ type: 'openConflict', path }));
      list.append(entry);
    }

    operationEl.append(list);
  }

  operationEl.hidden = false;
  schedule();
}

let menuEl: HTMLElement | null = null;

function closeMenu(): void {
  menuEl?.remove();
  menuEl = null;
}

/**
 * Right-click asks the host what is on the menu rather than deciding here: availability depends on
 * repository state - mid-rebase, already checked out, a dirty tree - that the webview has no view
 * of. One round trip per right-click is cheap; a menu that offers an action which then fails is not.
 */
function openMenu(event: MouseEvent, target: Target): void {
  event.preventDefault();
  closeMenu();
  vscode.postMessage({ type: 'requestMenu', target, x: event.clientX, y: event.clientY });
}

function renderMenu(target: Target, items: readonly MenuItem[], x: number, y: number): void {
  closeMenu();

  if (items.length === 0) {
    return;
  }

  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');

  let previousGroup: string | null = null;

  for (const item of items) {
    // A rule between groups, so "Delete" never sits flush against "Checkout" and gets hit by
    // someone aiming one row higher.
    if (previousGroup !== null && item.group !== previousGroup) {
      const rule = document.createElement('div');
      rule.className = 'menu-separator';
      menu.append(rule);
    }

    previousGroup = item.group;

    const el = document.createElement('div');
    el.className = item.destructive ? 'menu-item destructive' : 'menu-item';
    el.setAttribute('role', 'menuitem');
    el.textContent = item.label;

    if (item.disabledReason === null) {
      el.addEventListener('click', () => {
        closeMenu();
        vscode.postMessage({ type: 'runAction', id: item.id, target });
      });
    } else {
      // Greyed out with the reason attached, rather than hidden: an action that vanishes leaves the
      // user wondering whether they misremembered it.
      el.classList.add('disabled');
      el.append(span('menu-reason', item.disabledReason));
    }

    menu.append(el);
  }

  document.body.append(menu);
  menuEl = menu;

  // Place it at the pointer, then pull it back inside the window if it would hang off an edge.
  const box = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - box.width - 4);
  const top = Math.min(y, window.innerHeight - box.height - 4);
  menu.style.left = `${Math.max(4, left)}px`;
  menu.style.top = `${Math.max(4, top)}px`;
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

function span(className: string, text: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

/** `2026-07-28T13:37:20+08:00` -> `2026-07-28 13:37:20`, without pretending to know a locale. */
function formatDate(iso: string): string {
  return iso.slice(0, 19).replace('T', ' ');
}

/**
 * A path scans far better as a dim folder and a bright filename than as one even-toned string -
 * in a list of fourteen files under `GitFlick.Tests/`, the part that differs is the only part
 * worth reading.
 */
function appendPath(target: HTMLElement, path: string): void {
  const cut = path.lastIndexOf('/');

  if (cut >= 0) {
    target.append(span('path-dir', path.slice(0, cut + 1)));
  }

  target.append(span('path-name', cut >= 0 ? path.slice(cut + 1) : path));
}

/** Follow a parent link. The commit may not be loaded if a search is narrowing the view. */
function jumpTo(sha: string): void {
  const index = rows.findIndex((row) => row.sha === sha);

  if (index >= 0) {
    select(index);
  } else {
    statusEl.textContent = `${sha.slice(0, 8)} is not in the current view`;
  }
}

/**
 * Resize the details pane. The graph's canvas is sized to the viewport, so every change has to be
 * followed by a redraw - the lanes would otherwise keep the height they had before the drag.
 */
function applyDetailsHeight(height: number): void {
  const max = Math.max(120, window.innerHeight - 160);
  detailsHeight = Math.round(Math.min(Math.max(height, 90), max));
  detailsEl.style.height = `${detailsHeight}px`;
  schedule();
}

splitter.addEventListener('pointerdown', (event: PointerEvent) => {
  const startY = event.clientY;
  const startHeight = detailsEl.getBoundingClientRect().height;

  splitter.setPointerCapture(event.pointerId);
  splitter.classList.add('dragging');
  event.preventDefault();

  const onMove = (move: PointerEvent): void => {
    // The pane is below the graph, so dragging up must make it taller.
    applyDetailsHeight(startHeight - (move.clientY - startY));
  };

  const onUp = (): void => {
    splitter.classList.remove('dragging');
    splitter.removeEventListener('pointermove', onMove);
    splitter.removeEventListener('pointerup', onUp);
    splitter.removeEventListener('pointercancel', onUp);
    saveViewState();
  };

  splitter.addEventListener('pointermove', onMove);
  splitter.addEventListener('pointerup', onUp);
  splitter.addEventListener('pointercancel', onUp);
});

// Double-clicking a sash to reset it is the convention everywhere else in VS Code.
splitter.addEventListener('dblclick', () => {
  applyDetailsHeight(260);
  saveViewState();
});

/**
 * Put the details pane away.
 *
 * The selection stays where it is - closing the pane is about wanting the graph's height back, not
 * about deselecting - so clicking another commit brings it straight back.
 */
function closeDetails(): void {
  detailsEl.hidden = true;
  splitter.hidden = true;
  schedule();
}

(document.getElementById('detail-close') as HTMLElement).addEventListener('click', closeDetails);

function renderDetails(details: CommitDetails): void {
  currentDetails = details;
  // A different commit's third file is a different file; carrying the highlight over would be a lie.
  selectedFileIndex = -1;
  selectedFileEl = null;
  detailsEl.hidden = false;
  splitter.hidden = false;
  applyDetailsHeight(detailsHeight);

  const meta = document.createDocumentFragment();

  const line = (label: string, ...values: HTMLElement[]): void => {
    const wrap = document.createElement('div');
    const value = document.createElement('span');
    value.className = 'meta-value';
    value.append(...values);
    wrap.append(span('meta-key', label), value);
    meta.append(wrap);
  };

  const sha = span('sha-full', details.sha);
  sha.title = 'Copy the full hash';
  sha.addEventListener('click', () => vscode.postMessage({ type: 'copy', text: details.sha }));
  line('commit', sha);

  line(
    'author',
    span('person', details.author),
    span('email', `<${details.authorEmail}>`),
    span('when', formatDate(details.authorDate)),
  );

  // A rebase, a squash, or a merge made through a web UI leaves a committer who is not the author.
  // When they are the same person, saying it twice is noise.
  if (details.committer !== details.author) {
    line('committer', span('person', details.committer), span('when', formatDate(details.committerDate)));
  }

  if (details.parents.length > 0) {
    const parents = details.parents.map((parent) => {
      const chip = span('parent', parent.slice(0, 8));
      chip.title = `Go to ${parent}`;
      chip.addEventListener('click', () => jumpTo(parent));
      return chip;
    });

    line(details.parents.length > 1 ? 'parents' : 'parent', ...parents);
  }

  detailMetaEl.replaceChildren(meta);

  // The first line is a title and the rest is prose; rendering them alike makes a long message a
  // wall of text.
  const lines = details.body.split('\n');
  const body = document.createDocumentFragment();
  body.append(span('body-subject', lines[0] ?? ''));

  const rest = lines.slice(1).join('\n').trim();
  if (rest.length > 0) {
    body.append(span('body-rest', rest));
  }

  detailBodyEl.replaceChildren(body);

  renderFiles();
}

/**
 * Highlight a file without opening it.
 *
 * Opening a diff is a double-click, so a single click has to leave *some* mark or the list feels
 * dead under the cursor. The class is toggled directly rather than by re-rendering, because
 * rebuilding the tree on every click would collapse nothing and cost everything.
 */
function selectFile(el: HTMLElement, index: number): void {
  selectedFileEl?.classList.remove('selected');
  selectedFileEl = el;
  selectedFileIndex = index;
  el.classList.add('selected');
}

/** One entry in the changed-file list, at a given indent depth. */
function fileRow(sha: string, file: FileChange, index: number, depth: number, label: string): HTMLElement {
  const el = document.createElement('div');
  el.className = index === selectedFileIndex ? 'file selected' : 'file';
  el.title = `${STATUS_LABEL[file.status] ?? file.status}: ${file.path}\nDouble-click to open the diff`;
  el.style.paddingLeft = `${depth * 14 + 4}px`;

  if (index === selectedFileIndex) {
    selectedFileEl = el;
  }

  el.append(span(`status status-${file.status}`, file.status));

  const path = document.createElement('span');
  path.className = 'file-path';

  if (file.oldPath !== null) {
    appendPath(path, file.oldPath);
    path.append(span('rename-arrow', ' → '));
    appendPath(path, file.path);
  } else if (depth === 0) {
    appendPath(path, label);
  } else {
    // Inside a tree the folder is already on the row above, so only the name is worth repeating.
    path.append(span('path-name', label));
  }

  el.append(path);

  el.addEventListener('click', () => selectFile(el, index));
  el.addEventListener('dblclick', () => vscode.postMessage({ type: 'openDiff', sha, index }));

  return el;
}

interface TreeNode {
  /** Display name; a compacted chain keeps its slashes, e.g. `GitFlick/ViewModels`. */
  name: string;
  /** Full path, used as the collapse key. */
  path: string;
  dirs: Map<string, TreeNode>;
  files: { file: FileChange; index: number }[];
}

function newNode(name: string, path: string): TreeNode {
  return { name, path, dirs: new Map(), files: [] };
}

/**
 * Fold a flat path list into directories, then collapse any chain of folders that holds nothing but
 * one more folder - `GitFlick/ViewModels/x.cs` is three rows of almost no information otherwise.
 * VS Code's own explorer does the same thing and calls it compact folders.
 */
function buildTree(files: readonly FileChange[]): TreeNode {
  const root = newNode('', '');

  files.forEach((file, index) => {
    const parts = file.path.split('/');
    const name = parts.pop() ?? file.path;
    let node = root;
    let acc = '';

    for (const part of parts) {
      acc = acc.length === 0 ? part : `${acc}/${part}`;
      let next = node.dirs.get(part);

      if (next === undefined) {
        next = newNode(part, acc);
        node.dirs.set(part, next);
      }

      node = next;
    }

    node.files.push({ file, index });
  });

  compact(root);
  return root;
}

function compact(node: TreeNode): void {
  for (const [key, child] of [...node.dirs]) {
    let merged = child;

    while (merged.dirs.size === 1 && merged.files.length === 0) {
      const only = [...merged.dirs.values()][0] as TreeNode;
      merged = {
        name: `${merged.name}/${only.name}`,
        path: only.path,
        dirs: only.dirs,
        files: only.files,
      };
    }

    compact(merged);
    node.dirs.set(key, merged);
  }
}

function renderTree(sha: string, node: TreeNode, depth: number, out: DocumentFragment): void {
  const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));

  for (const dir of dirs) {
    const isCollapsed = collapsedDirs.has(dir.path);

    const row = document.createElement('div');
    row.className = 'folder';
    row.style.paddingLeft = `${depth * 14 + 4}px`;
    row.append(span('chevron', isCollapsed ? '▸' : '▾'), span('folder-name', dir.name));
    row.addEventListener('click', () => {
      if (isCollapsed) {
        collapsedDirs.delete(dir.path);
      } else {
        collapsedDirs.add(dir.path);
      }

      renderFiles();
    });

    out.append(row);

    if (!isCollapsed) {
      renderTree(sha, dir, depth + 1, out);
    }
  }

  for (const { file, index } of node.files) {
    const name = file.path.split('/').pop() ?? file.path;
    out.append(fileRow(sha, file, index, depth, name));
  }
}

/** Redraw the changed-file list in whichever shape is currently selected. */
function renderFiles(): void {
  const details = currentDetails;

  if (details === null) {
    detailFilesEl.replaceChildren();
    return;
  }

  const out = document.createDocumentFragment();

  // Every row is about to be rebuilt, so the old element reference is stale; fileRow picks the new
  // one up again when it reaches the selected index.
  selectedFileEl = null;

  const heading = document.createElement('div');
  heading.className = 'files-heading';
  heading.append(
    span(
      'files-count',
      details.files.length === 1 ? '1 file changed' : `${details.files.length} files changed`,
    ),
  );

  const toggle = document.createElement('span');
  toggle.className = 'view-toggle';

  for (const mode of ['tree', 'flat'] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = mode;
    button.className = fileView === mode ? 'active' : '';
    button.addEventListener('click', () => {
      fileView = mode;
      saveViewState();
      renderFiles();
    });

    toggle.append(button);
  }

  heading.append(toggle);
  out.append(heading);

  if (fileView === 'tree') {
    renderTree(details.sha, buildTree(details.files), 0, out);
  } else {
    details.files.forEach((file, index) => {
      out.append(fileRow(details.sha, file, index, 0, file.path));
    });
  }

  detailFilesEl.replaceChildren(out);
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
  splitter.hidden = true;
  currentDetails = null;
  collapsedDirs.clear();
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
      document.body.classList.toggle('author-tint', message.authorColors);
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

    case 'menu':
      renderMenu(message.target, message.items, message.x, message.y);
      break;

    case 'operation':
      renderOperation(message.operation, message.description, message.conflicted, message.controls);
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

viewport.addEventListener('scroll', () => {
  closeMenu();
  schedule();
}, { passive: true });

window.addEventListener('blur', closeMenu);
document.addEventListener('mousedown', (event) => {
  if (menuEl !== null && !menuEl.contains(event.target as Node)) {
    closeMenu();
  }
});
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

  if (event.key === 'Escape') {
    // Innermost first: the menu, then the pane. Closing both at once would be one keystroke doing
    // two things the user did not ask for.
    if (menuEl !== null) {
      closeMenu();
      event.preventDefault();
      return;
    }

    if (!detailsEl.hidden) {
      closeDetails();
      event.preventDefault();
      return;
    }
  }

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

restoreViewState();
vscode.postMessage({ type: 'ready' });
