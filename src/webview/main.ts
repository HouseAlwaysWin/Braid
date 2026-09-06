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
import type { CommitInfo, CommitOrder, RefEntry } from '../protocol.ts';
import type { DateRange } from '../git/dates.ts';
import type { Upstream } from '../git/repoState.ts';
import type { Search, SearchMode, SearchToggle } from '../git/search.ts';
import { TOGGLES, looksLikeCommitId } from '../git/search.ts';
import type { MenuItem, Target } from '../actions/registry.ts';
import type { HostMessage, Row, WebviewMessage } from '../protocol.ts';
import { authorHue } from './authorColor.ts';
import type { Sort, SortColumn } from './sort.ts';
import { FIRST_DIRECTION, sortRows } from './sort.ts';

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
const columnsEl = document.getElementById('columns') as HTMLElement;
const clearSortEl = document.getElementById('clear-sort') as HTMLButtonElement;
const clearFiltersEl = document.getElementById('clear-filters') as HTMLButtonElement;
const compareMarkEl = document.getElementById('compare-mark') as HTMLButtonElement;
const upstreamEl = document.getElementById('upstream') as HTMLElement;
const branchButton = document.getElementById('branch-button') as HTMLButtonElement;
const branchCurrent = document.getElementById('branch-current') as HTMLElement;
const branchList = document.getElementById('branch-list') as HTMLElement;
const branchFilter = document.getElementById('branch-filter') as HTMLInputElement;
const branchRows = document.getElementById('branch-rows') as HTMLElement;
const branchEmpty = document.getElementById('branch-empty') as HTMLElement;
const firstParentEl = document.getElementById('first-parent') as HTMLButtonElement;
const commitOrderEl = document.getElementById('commit-order') as HTMLSelectElement;
const viewport = document.getElementById('viewport') as HTMLElement;
const spacer = document.getElementById('spacer') as HTMLElement;
const rowsEl = document.getElementById('rows') as HTMLElement;
const canvas = document.getElementById('graph') as HTMLCanvasElement;
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
const detailsEl = document.getElementById('details') as HTMLElement;
const detailMetaEl = document.getElementById('detail-meta') as HTMLElement;
const detailBodyEl = document.getElementById('detail-body') as HTMLElement;
const splitter = document.getElementById('splitter') as HTMLElement;

interface ViewState {
  readonly detailsHeight?: number;
  readonly sort?: Sort | null;
  readonly searchOptions?: Record<SearchToggle, boolean>;
  /*
   * The filters, so that hiding the tab does not quietly drop them. The date range is kept as the
   * *choice* rather than as the days it works out to - "today" has to still mean today tomorrow.
   */
  readonly query?: string;
  readonly mode?: SearchMode;
  readonly dateChoice?: string;
  readonly dateSince?: string;
  readonly dateUntil?: string;
  readonly firstParent?: boolean;
  readonly order?: CommitOrder;
  /** Which groups of the branch menu are rolled up. Worth keeping: a repository with two hundred
      remote branches is one you collapse once and want to stay collapsed. */
  readonly branchGroupsClosed?: readonly string[];
  /** Column widths in pixels and which are switched off. Absent width means the default. */
  readonly columns?: Record<string, { readonly width?: number; readonly hidden?: boolean }>;
}

/*
 * The metadata lines plus the first paragraph of a message, which is now the whole job: the changed
 * files moved to Source Control, and the 260 they needed left the pane mostly empty without them.
 */
let detailsHeight = 200;
let currentDetails: CommitInfo | null = null;

/*
 * The panel is created with `retainContextWhenHidden: false`, so hiding the tab destroys this
 * webview and showing it again builds a new one. Layout choices would evaporate every time without
 * somewhere to put them - `setState` is that somewhere, and it costs nothing to keep warm.
 */
function saveViewState(): void {
  vscode.setState({
    detailsHeight,
    sort,
    searchOptions,
    query: searchInput.value,
    mode: currentMode(),
    dateChoice: dateRange.value,
    dateSince: dateSince.value,
    dateUntil: dateUntil.value,
    firstParent,
    order: commitOrder,
    branchGroupsClosed: [...branchGroupsClosed],
    columns: Object.fromEntries(
      FIXED_COLUMNS.map((column) => [column.key, { ...columnState[column.key] }]),
    ),
  } satisfies ViewState);
}

function restoreViewState(): void {
  const state = vscode.getState() as ViewState | undefined;

  if (state?.detailsHeight !== undefined) {
    detailsHeight = state.detailsHeight;
  }

  if (state?.sort !== undefined) {
    sort = state.sort;
  }

  if (state?.searchOptions !== undefined) {
    Object.assign(searchOptions, state.searchOptions);
  }

  branchGroupsClosed = new Set(state?.branchGroupsClosed ?? []);

  for (const column of FIXED_COLUMNS) {
    const saved = state?.columns?.[column.key];

    if (saved !== undefined) {
      // Assigned rather than spread: an explicit `width: undefined` is a different thing from no
      // width at all, and only the second means "follow the font".
      const restored: { width?: number; hidden: boolean } = { hidden: saved.hidden === true };

      if (typeof saved.width === 'number') {
        restored.width = saved.width;
      }

      columnState[column.key] = restored;
    }
  }

  applyColumns();
  firstParent = state?.firstParent ?? false;
  commitOrder = state?.order ?? 'date';
  commitOrderEl.value = commitOrder;
  searchInput.value = state?.query ?? '';
  searchMode.value = state?.mode ?? 'message';
  dateRange.value = state?.dateChoice ?? '';
  dateSince.value = state?.dateSince ?? '';
  dateUntil.value = state?.dateUntil ?? '';
  dateCustom.hidden = dateRange.value !== 'custom';
}

/** What the grips were last placed against, so they are only re-measured when it moves. */
let columnGeometry = '';

let rowHeight = 24;
let graphWidth = 0;

/**
 * The history in git's order - the order the lanes were laid out in, and the order `paths` and
 * `dots` are indexed by. Nothing ever reorders this.
 */
let rows: Row[] = [];

/**
 * The order on screen. The same array as `rows` while the graph is showing, a sorted copy while it
 * is not, so every index the view deals in - the selection, the keyboard, the scroll position -
 * means one thing regardless of which of the two is on screen.
 */
let view: Row[] = rows;

/**
 * The column the user sorted by, or null for git's order. It outlives a reload, because it is a
 * property of the view rather than of the history: a refresh should not silently undo it.
 */
let sort: Sort | null = null;

/** Whether the last page has landed. Sorting half a history reorders it under the reader. */
let complete = false;

/**
 * What to mark inside the rows, or null for nothing. Built from the search box, never from the
 * host: git has already narrowed the walk, so this is only about showing *where* a row matched.
 */
let highlight: RegExp | null = null;

/**
 * The working tree as the host last described it. `total` of zero means there is nothing to show a
 * row for, which is the ordinary state of a repository nobody is halfway through editing.
 */
let working = { total: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, branch: null as string | null };

/** The last thing the host said about the remote, kept so the age beside it can keep counting. */
let remote: { upstream: Upstream | null; branch: string | null; fetchedAt: number | null } = {
  upstream: null,
  branch: null,
  fetchedAt: null,
};

/**
 * Walk only the mainline.
 *
 * A filter, for all that it is spelled as a walk option: it decides which commits are on screen, so
 * it counts towards "something is narrowing this" and the button that drops everything drops it.
 */
let firstParent = false;

/*
 * How git is asked to order the walk.
 *
 * Not a filter and not the column sort: it hides nothing and the graph stays a graph. The column
 * sort flattens - a lane point's Y is a row index, so any order git did not produce makes the lanes
 * meaningless and they are dropped. These are still git walking, so the lanes still mean something.
 * What changes is the shape the history is drawn in.
 */
let commitOrder: CommitOrder = 'date';

/**
 * The HEAD commit's dot, kept as it arrives rather than searched for.
 *
 * The working-tree row hangs off it by a dashed line, and looking it up per frame would be a walk
 * of every dot in the history sixty times a second to find one that never moves.
 */
let headDot: GraphDot | null = null;

let selected = -1;

/**
 * The commit a comparison is measured from, by sha, or null for none.
 *
 * Deliberately not the selection. Selecting is how you read a commit - its message, its files - and
 * borrowing that to mean "and this is what I want to compare against" made the other end of every
 * comparison whichever row had last been read, which is not a choice anybody made.
 *
 * By sha rather than by row, because a row number is only true until the next sort, filter or
 * reload - and the way to reach a commit a thousand rows away is to search for it, which is exactly
 * the act that would have thrown the mark away.
 */
let compareFrom: string | null = null;

/** The other end, while a comparison is on screen. */
let comparedTo: string | null = null;
const paths = new Map<number, { color: number; points: Point[] }>();
let dots: GraphDot[] = [];
let palette: string[] = [];
let pending = false;

function readPalette(): string[] {
  const style = getComputedStyle(document.documentElement);
  const out: string[] = [];

  for (let i = 0; i < LANE_COLORS; i++) {
    out.push(style.getPropertyValue(`--weft-lane-${i}`).trim() || '#888');
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

/** True when the rows are in an order the lanes cannot express, so the graph is switched off. */
function isFlat(): boolean {
  return sort !== null && complete;
}

/**
 * The row that stands for the working tree.
 *
 * It is built here rather than sent by the host, and deliberately kept out of the layout: lane
 * points are indexed by commit row, so a row that appears and disappears as files are saved would
 * renumber every one of them. Instead it takes display position 0 and the canvas shifts by one.
 */
function uncommittedRow(): Row {
  return {
    sha: '',
    subject: 'Uncommitted Changes',
    author: '',
    date: '',
    refs: [],
    isHead: false,
    uncommitted: true,
  };
}

/** How many display rows sit above the history. One, or none. */
function rowOffset(): number {
  return view.length - rows.length;
}

function render(): void {
  // The one measurement the stylesheet cannot hold: how wide the lanes are is a property of the
  // repository. Flat, there are no lanes, so the rows reclaim the space.
  const indent = (isFlat() ? 0 : graphWidth) + 8;

  /*
   * The header is outside the scroller, so it is as wide as the scrollbar is - and its columns
   * would sit that far right of the rows'. Padding the difference back is the only way to hold the
   * two in step, because the width is the browser's to decide: a classic scrollbar takes sixteen
   * pixels, an overlay one takes none, and a history short enough not to scroll takes none either.
   */
  columnsEl.style.paddingLeft = `${indent}px`;
  columnsEl.style.paddingRight = `${12 + viewport.offsetWidth - viewport.clientWidth}px`;

  /*
   * The grips are measured, so they have to be re-measured whenever the boundaries could have
   * moved - the panel resizing, the lanes widening, a scrollbar arriving. Only when the geometry
   * actually changed: this runs every frame, and four rect reads per frame during a scroll is the
   * kind of thing that turns a smooth list into a stuttering one.
   */
  const geometry = `${indent}:${columnsEl.clientWidth}`;

  if (geometry !== columnGeometry) {
    columnGeometry = geometry;
    placeGrips();
  }

  renderRows(indent);
  drawGraph();
}

/** Rebuild only the row elements the viewport can actually show. */
function renderRows(indent: number): void {
  const scrollTop = viewport.scrollTop;
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - 1);
  const visible = Math.ceil(viewport.clientHeight / rowHeight) + 2;
  const last = Math.min(view.length, first + visible);

  const frag = document.createDocumentFragment();

  for (let i = first; i < last; i++) {
    const row = view[i];
    if (row === undefined) {
      continue;
    }

    const el = document.createElement('div');
    const isEnd = row.sha === compareFrom || row.sha === comparedTo;
    const inComparison = comparedTo !== null && isEnd;

    el.className = [
      'row',
      i === selected ? 'selected' : '',
      inComparison ? 'compared' : row.sha === compareFrom ? 'compare-anchor' : '',
    ]
      .filter((name) => name.length > 0)
      .join(' ');
    el.style.top = `${i * rowHeight}px`;
    el.style.paddingLeft = `${indent}px`;

    if (row.uncommitted === true) {
      el.classList.add('uncommitted');
      el.title = 'The working tree. Click to see what has changed.';

      const label = span('cell-subject', '');
      label.append(span('subject', row.subject), span('working-count', describeWorking()));

      // The same four cells as every other row, so the columns still line up over their contents.
      el.append(label, span('author', ''), span('date', ''), span('sha', '*'));
      el.addEventListener('click', () => select(i));
      frag.append(el);
      continue;
    }

    // Refs and subject share the first grid column: a commit carries however many badges it
    // carries, and a grid column cannot hold a variable number of cells.
    const description = document.createElement('span');
    description.className = 'cell-subject';

    if (row.stash !== undefined) {
      const badge = span('ref stash', row.stash);
      badge.title = `${row.stash}: ${row.subject}`;
      description.append(badge);
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

      description.append(badge);
    }

    const subject = document.createElement('span');
    subject.className = 'subject';
    subject.title = row.subject;
    appendMarked(subject, row.subject, searchMode.value === 'message' ? highlight : null);
    description.append(subject);
    el.append(description);

    const author = document.createElement('span');
    author.className = 'author';
    author.title = row.author;
    appendMarked(author, row.author, searchMode.value === 'author' ? highlight : null);
    // Only the hue: the stylesheet holds the lightness, so the tint follows the theme.
    author.style.setProperty('--weft-author-hue', `${authorHue(row.author)}`);
    el.append(author);

    const date = document.createElement('span');
    date.className = 'date';
    date.textContent = row.date.slice(0, 10);
    el.append(date);

    const sha = document.createElement('span');
    sha.className = 'sha';
    sha.textContent = row.sha.slice(0, 8);
    el.append(sha);

    el.addEventListener('click', (event) => {
      // Ctrl anywhere, Cmd on a Mac: the same two steps as the menu, without the menu.
      if (event.ctrlKey || event.metaKey) {
        if (compareFrom === null || compareFrom === row.sha) {
          markForCompare(row.sha);
        } else {
          compareWith(row.sha);
        }

        return;
      }

      select(i);
    });

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

/** Bring a display row into view, moving as little as possible to get it there. */
function scrollRowIntoView(index: number): void {
  const top = index * rowHeight;
  const bottom = top + rowHeight;

  if (top < viewport.scrollTop) {
    viewport.scrollTop = top;
  } else if (bottom > viewport.scrollTop + viewport.clientHeight) {
    viewport.scrollTop = bottom - viewport.clientHeight;
  }
}

/** Mark a commit as the one to measure from. Nothing is compared yet; this is half a question. */
function markForCompare(sha: string): void {
  if (sha.length === 0) {
    return;
  }

  compareFrom = sha;
  comparedTo = null;
  updateCompareMark();
  schedule();
}

/**
 * The marked commit, said somewhere that is always on screen.
 *
 * A mark drawn only on its own row is a mark you lose the moment you scroll past it - and the two
 * commits worth comparing are rarely both on screen at once, which is the whole reason the mark
 * exists. Clicking goes back to it.
 */
function updateCompareMark(): void {
  if (compareFrom === null) {
    compareMarkEl.hidden = true;
    return;
  }

  const short = compareFrom.slice(0, 8);

  compareMarkEl.textContent =
    comparedTo === null ? `compare from ${short}` : `${short} → ${comparedTo.slice(0, 8)}`;

  compareMarkEl.title =
    comparedTo === null
      ? `Marked to compare from. Right-click another commit for "Compare with ${short}", or click here to go back to it. Escape drops the mark.`
      : `Comparing ${compareFrom} with ${comparedTo}. Click to go back to the first. Escape drops both.`;

  compareMarkEl.hidden = false;
}

compareMarkEl.addEventListener('click', () => {
  if (compareFrom !== null) {
    jumpTo(compareFrom);
  }
});

/**
 * Compare the marked commit with another one.
 *
 * The order is the order of the two picks - marked first, compared second - and the pane says so
 * rather than leaving it to be inferred. Guessing from row position would be worse than arbitrary:
 * two commits on different branches have no order between them, and the graph's own is only the
 * order git happened to walk them in.
 */
function compareWith(sha: string): void {
  if (compareFrom === null || sha.length === 0 || sha === compareFrom) {
    return;
  }

  comparedTo = sha;
  vscode.postMessage({ type: 'compare', from: compareFrom, to: sha });
  updateCompareMark();
  schedule();
}

/** Back to a single commit, and to no commit marked. */
function clearComparison(): void {
  if (comparedTo === null && compareFrom === null) {
    return;
  }

  const wasComparing = comparedTo !== null;

  compareFrom = null;
  comparedTo = null;
  updateCompareMark();

  if (!wasComparing) {
    // Only a mark was dropped; the pane is showing whatever it was showing, and still should be.
    schedule();
    return;
  }

  const row = view[selected];

  if (row !== undefined && row.uncommitted !== true) {
    vscode.postMessage({ type: 'selectCommit', sha: row.sha });
  }

  schedule();
}

/** Move the selection, keep it on screen, and ask the host for that commit's details. */
function select(index: number): void {
  if (index < 0 || index >= view.length) {
    return;
  }

  /*
   * A new pick ends the comparison but keeps the mark: reading another commit is not a change of
   * mind about what you wanted to measure from, and having to re-mark it after every glance would
   * make the two-step worse than the accident it replaced.
   */
  comparedTo = null;
  updateCompareMark();

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
  const row = view[index];

  if (row?.uncommitted === true) {
    // Nothing to load: there is no commit. The files go to Source Control, and the pane describes
    // the working tree from what the host already told us about it.
    vscode.postMessage({ type: 'selectUncommitted' });
    renderWorking();
  } else if (row !== undefined) {
    vscode.postMessage({ type: 'selectCommit', sha: row.sha });
  }

  scrollRowIntoView(index);
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
 * Conflicted files are listed and clickable. Weft does not resolve them - VS Code's merge editor
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

/*
 * The branch menu in the header.
 *
 * Every ref the sidebar knows about, with the tick that decides whether the graph draws it and a
 * name that checks it out. Both were already possible - the ticks in Branches & Tags, and Checkout
 * from a badge - but both needed the sidebar open, or the branch to be sitting on a row that
 * happens to be on screen. Neither is true when the branch you want is the one you cannot see.
 *
 * The list is whatever the host last sent. Nothing is cached across repositories and nothing is
 * computed here: the ticks are the sidebar's state, and a toggle goes straight back to it.
 */
let refEntries: readonly RefEntry[] = [];
let headBranch: string | null = null;
let branchGroupsClosed = new Set<string>();

function branchMenuOpen(): boolean {
  return !branchList.hidden;
}

/**
 * Straight to the host, which owns the one hidden set.
 *
 * One message however many refs it is: the reload that follows sends the list back, so nothing here
 * has to guess what the new state is, and a group of fifty costs one walk rather than fifty.
 */
function setRefsDrawn(refNames: readonly string[], visible: boolean): void {
  if (refNames.length > 0) {
    vscode.postMessage({ type: 'setRefsVisible', refNames, visible });
  }
}

function closeBranchMenu(): void {
  branchList.hidden = true;
  branchButton.setAttribute('aria-expanded', 'false');
}

/** One row: a tick that hides, and a name that checks out. */
function branchRow(entry: RefEntry): HTMLElement {
  const row = document.createElement('div');
  const here = entry.kind === 'local' && entry.label === headBranch;

  row.className = `branch-row${here ? ' current' : ''}${entry.visible ? '' : ' off'}`;

  const draw = document.createElement('input');
  draw.type = 'checkbox';
  draw.className = 'branch-draw';
  draw.checked = entry.visible;
  draw.title = entry.visible ? `Stop drawing ${entry.label}` : `Draw ${entry.label}`;
  draw.setAttribute('aria-label', draw.title);
  draw.addEventListener('change', () => {
    setRefsDrawn([entry.refName], draw.checked);
  });

  const name = document.createElement('button');
  name.type = 'button';
  name.className = 'branch-name';
  name.textContent = entry.label;
  name.title = entry.refName;

  if (here) {
    // Checking out the branch you are on does nothing, and offering it suggests otherwise.
    name.disabled = true;
  } else {
    name.addEventListener('click', () => {
      closeBranchMenu();
      vscode.postMessage({
        type: 'runAction',
        id: entry.kind === 'remote' ? 'weft.checkoutRemoteBranch' : 'weft.checkoutBranch',
        target: { kind: 'ref', refName: entry.refName, label: entry.label, refKind: entry.kind },
      });
    });
  }

  row.append(draw, name);

  if (here) {
    row.append(span('branch-here', 'here'));
  }

  return row;
}

/**
 * A group heading: a tick for all of them, a label that rolls the group up.
 *
 * The tick acts on what is *listed*, not on everything of that kind, so it composes with the filter
 * above it - type `claude`, untick Local, and the eight branches you can see are the eight that
 * stop being drawn. Acting on the hidden ones too would make the same click mean something
 * different depending on a box the user can see the contents of.
 */
function branchGroupHeader(kind: string, label: string, listed: readonly RefEntry[]): HTMLElement {
  const row = document.createElement('div');
  const closed = branchGroupsClosed.has(kind);
  const drawn = listed.filter((entry) => entry.visible).length;

  row.className = 'branch-group';

  const all = document.createElement('input');
  all.type = 'checkbox';
  all.className = 'branch-draw';
  all.checked = drawn === listed.length;
  // Neither on nor off: some of what is listed is drawn. Clicking from here draws all of them,
  // which is the half of the answer that loses nothing.
  all.indeterminate = drawn > 0 && drawn < listed.length;
  all.title = all.checked ? `Stop drawing all ${listed.length}` : `Draw all ${listed.length}`;
  all.setAttribute('aria-label', all.title);
  all.addEventListener('change', () => {
    setRefsDrawn(
      listed.filter((entry) => entry.visible === !all.checked).map((entry) => entry.refName),
      all.checked,
    );
  });

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'branch-group-toggle';
  toggle.setAttribute('aria-expanded', closed ? 'false' : 'true');
  toggle.title = closed ? `Show the ${listed.length}` : 'Roll this group up';
  toggle.append(
    span('chevron', closed ? '\u25B8' : '\u25BE'),
    span('branch-group-label', label),
    span('branch-group-count', String(listed.length)),
  );

  toggle.addEventListener('click', () => {
    if (closed) {
      branchGroupsClosed.delete(kind);
    } else {
      branchGroupsClosed.add(kind);
    }

    saveViewState();
    renderBranchMenu();
  });

  row.append(all, toggle);
  return row;
}

function renderBranchMenu(): void {
  const needle = branchFilter.value.trim().toLowerCase();
  const matches = refEntries.filter(
    (entry) => entry.kind !== 'tag' && entry.label.toLowerCase().includes(needle),
  );

  branchRows.replaceChildren();
  branchEmpty.hidden = matches.length > 0;

  // Local first: it is the half you check out. Remote branches are listed under their own heading
  // rather than mixed in, because `origin/main` and `main` are different things to switch to.
  for (const kind of ['local', 'remote'] as const) {
    const group = matches.filter((entry) => entry.kind === kind);

    if (group.length === 0) {
      continue;
    }

    branchRows.append(branchGroupHeader(kind, kind === 'local' ? 'Local' : 'Remote', group));

    // Rolled up hides the branches, never the heading: the tick and the count stay reachable, so a
    // collapsed group is still one click from being switched off entirely.
    if (branchGroupsClosed.has(kind)) {
      continue;
    }

    for (const entry of group) {
      branchRows.append(branchRow(entry));
    }
  }
}

function openBranchMenu(): void {
  branchFilter.value = '';
  renderBranchMenu();
  branchList.hidden = false;
  branchButton.setAttribute('aria-expanded', 'true');
  branchFilter.focus();
}

/** What the button says: the branch HEAD is on, or that there is not one. */
function renderBranchButton(): void {
  branchCurrent.textContent = headBranch ?? 'detached';
  branchButton.classList.toggle('detached', headBranch === null);
  branchButton.title =
    headBranch === null
      ? 'HEAD is not on a branch. Pick one to check out, or tick which branches the graph draws.'
      : `On ${headBranch}. Pick another to check it out, or tick which branches the graph draws.`;
}

branchButton.addEventListener('click', () => {
  if (branchMenuOpen()) {
    closeBranchMenu();
  } else {
    openBranchMenu();
  }
});

branchFilter.addEventListener('input', renderBranchMenu);

branchFilter.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    // Handled here so it closes the menu rather than reaching the document handler, which would
    // read Escape as "clear the selection" and leave the menu open.
    event.stopPropagation();
    closeBranchMenu();
    branchButton.focus();
  }
});

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

/** A menu entry the view answers itself, grouped like the host's so the rules land in the same places. */
interface LocalItem {
  readonly label: string;
  readonly group: string;
  readonly run: () => void;
}

/** Put text on the clipboard. The host owns the clipboard; the view knows what is worth putting on it. */
function copyItem(label: string, text: string): LocalItem {
  return { label, group: 'copy', run: () => vscode.postMessage({ type: 'copy', text }) };
}

/**
 * The menu items the view answers itself.
 *
 * Neither comparing nor copying is a repository action: no git runs, nothing changes, and what they
 * act on - what is selected, what is on the row - is the view's business rather than the host's.
 * They still belong on the menu. Ctrl-clicking a second commit is not something anybody discovers
 * by trying, and a hash you cannot copy from the thing displaying it is a hash you retype.
 */
function localMenuItems(target: Target): LocalItem[] {
  if (target.kind === 'ref') {
    const what = target.refKind === 'tag' ? 'Tag' : 'Branch';

    return [
      copyItem(`Copy ${what} Name`, target.label),
      // The full name as git spells it, which is what a command line wants and the label is not:
      // `origin/main` is a branch to read and `refs/remotes/origin/main` is one to pass to git.
      copyItem('Copy Full Ref Name', target.refName),
    ];
  }

  if (target.kind === 'stash') {
    return [
      copyItem('Copy Stash Name', target.name),
      copyItem('Copy Stash Hash', target.sha),
    ];
  }

  if (target.kind !== 'commit') {
    return [];
  }

  const sha = target.sha;

  const copies = [copyItem('Copy Commit Hash', sha), copyItem('Copy Commit Subject', target.subject)];

  // Nothing marked yet: this is the first of the two steps.
  if (compareFrom === null) {
    return [{ label: 'Select for Compare', group: 'compare', run: () => markForCompare(sha) }, ...copies];
  }

  // Right-clicking the marked commit itself: the only useful thing to offer is letting it go.
  if (sha === compareFrom) {
    return [
      { label: 'Clear Compare Selection', group: 'compare', run: () => clearComparison() },
      ...copies,
    ];
  }

  return [
    {
      label: `Compare with ${compareFrom.slice(0, 8)}`,
      group: 'compare',
      run: () => compareWith(sha),
    },
    { label: 'Select for Compare', group: 'compare', run: () => markForCompare(sha) },
    ...copies,
  ];
}

function renderMenu(target: Target, items: readonly MenuItem[], x: number, y: number): void {
  closeMenu();

  const local = localMenuItems(target);

  if (items.length === 0 && local.length === 0) {
    return;
  }

  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');

  let localGroup: string | null = null;

  for (const item of local) {
    if (localGroup !== null && item.group !== localGroup) {
      const rule = document.createElement('div');

      rule.className = 'menu-separator';
      menu.append(rule);
    }

    localGroup = item.group;

    const el = document.createElement('div');

    el.className = 'menu-item';
    el.setAttribute('role', 'menuitem');
    // textContent, like the host's own items: `menu-label` is not a class this stylesheet has.
    el.textContent = item.label;
    el.addEventListener('click', () => {
      closeMenu();
      item.run();
    });

    menu.append(el);
  }

  if (local.length > 0 && items.length > 0) {
    const rule = document.createElement('div');

    rule.className = 'menu-separator';
    menu.append(rule);
  }

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

  showMenuAt(menu, x, y);
}

/** Put a built menu on screen at the pointer, pulled back inside the window if it would hang off. */
function showMenuAt(menu: HTMLElement, x: number, y: number): void {
  document.body.append(menu);
  menuEl = menu;

  const box = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - box.width - 4);
  const top = Math.min(y, window.innerHeight - box.height - 4);
  menu.style.left = `${Math.max(4, left)}px`;
  menu.style.top = `${Math.max(4, top)}px`;
}

/**
 * Append text with the search's matches marked.
 *
 * Every row on screen matched - git only walked the ones that did - so this is not about *whether*
 * a row matched but about where, which is the question a forty-character subject actually raises.
 */
function appendMarked(target: HTMLElement, text: string, pattern: RegExp | null): void {
  if (pattern === null) {
    target.textContent = text;
    return;
  }

  pattern.lastIndex = 0;
  let cut = 0;

  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined || match[0].length === 0) {
      continue;
    }

    if (match.index > cut) {
      target.append(text.slice(cut, match.index));
    }

    target.append(span('hit', match[0]));
    cut = match.index + match[0].length;
  }

  if (cut === 0) {
    // No match here after all: a pattern JavaScript reads differently from git, or a hit in the
    // body rather than the subject. Either way the plain text is the honest answer.
    target.textContent = text;
    return;
  }

  if (cut < text.length) {
    target.append(text.slice(cut));
  }
}

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

/** Follow a parent link. The commit may not be loaded if a search is narrowing the view. */
function jumpTo(sha: string): void {
  const index = view.findIndex((row) => row.sha === sha);

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

/** `3 staged, 2 unstaged, 1 untracked` - only the parts that are not zero. */
function describeWorking(): string {
  const parts = [
    working.conflicted > 0 ? `${working.conflicted} conflicted` : '',
    working.staged > 0 ? `${working.staged} staged` : '',
    working.unstaged > 0 ? `${working.unstaged} unstaged` : '',
    working.untracked > 0 ? `${working.untracked} untracked` : '',
  ].filter((part) => part.length > 0);

  return parts.join(', ');
}

/**
 * The details pane for the working tree.
 *
 * No hash, no author, no message - none of them exist yet. What it can say is what is in the tree
 * and where it would land, and saying only that is more honest than a card of empty fields.
 */
function renderWorking(): void {
  currentDetails = null;
  detailsEl.hidden = false;
  splitter.hidden = false;
  applyDetailsHeight(detailsHeight);

  const meta = document.createDocumentFragment();
  const line = (label: string, value: string): void => {
    const wrap = document.createElement('div');
    const text = span('meta-value', value);

    wrap.append(span('meta-key', label), text);
    meta.append(wrap);
  };

  line('changes', describeWorking());

  if (working.branch !== null) {
    line('branch', working.branch);
  }

  detailMetaEl.replaceChildren(meta);
  detailBodyEl.replaceChildren();
  detailBodyEl.hidden = true;
}

/**
 * The pane for a comparison.
 *
 * Two counts rather than one, because two commits picked off a graph are not always one behind the
 * other - a single "N commits" would have to pick a side, and picking the wrong one is worse than
 * spending a line saying both.
 */
function renderComparison(message: {
  from: string;
  to: string;
  files: number;
  onlyFrom: number;
  onlyTo: number;
}): void {
  currentDetails = null;
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

  // `.sha-full` carries a pointer cursor, so it has to actually do the thing it looks like it does.
  const hash = (sha: string): HTMLElement => {
    const el = span('sha-full', sha.slice(0, 8));

    el.title = `${sha}
Click to copy`;
    el.addEventListener('click', () => vscode.postMessage({ type: 'copy', text: sha }));

    return el;
  };

  line('comparing', hash(message.from), span('range-arrow', '→'), hash(message.to));

  line(
    'changed',
    span('person', message.files === 1 ? '1 file' : `${message.files} files`),
  );

  line(
    'apart',
    span(
      'when',
      message.onlyFrom === 0 && message.onlyTo === 0
        ? 'the same commit content on both sides'
        : `${message.onlyFrom} commit${message.onlyFrom === 1 ? '' : 's'} only on the left, ` +
          `${message.onlyTo} only on the right`,
    ),
  );

  detailMetaEl.replaceChildren(meta);
  detailBodyEl.replaceChildren();
  detailBodyEl.hidden = true;
}

function renderDetails(details: CommitInfo): void {
  currentDetails = details;
  detailBodyEl.hidden = false;
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
}

function drawGraph(): void {
  // The canvas is hidden in flat mode; sizing and stroking it anyway would be work nobody sees.
  if (isFlat()) {
    return;
  }

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
  // Lane coordinates are in commit rows; the working-tree row sits above all of them, so every
  // line and dot moves down by however many rows are not part of the history.
  const shift = rowOffset();
  const topRow = scrollTop / rowHeight - shift;
  const bottomRow = (scrollTop + height) / rowHeight - shift;
  const y = (row: number): number => (row + shift) * rowHeight - scrollTop;

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
        .getPropertyValue('--weft-bg')
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

  drawWorkingTree(y);
}

/**
 * The working tree, hanging off HEAD by a dashed line.
 *
 * Dashed rather than solid because it is not history: nothing here is reachable, and drawing it
 * like a commit would be claiming otherwise. It is skipped when HEAD is not on screen at all - a
 * filter can leave the row with nothing to hang from, and a line to nowhere is worse than none.
 */
function drawWorkingTree(y: (row: number) => number): void {
  if (rowOffset() === 0 || headDot === null) {
    return;
  }

  const color = palette[headDot.color % LANE_COLORS] ?? '#888';
  const top = y(-0.5);
  const x = headDot.center.x;

  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, top);
  ctx.lineTo(x, y(headDot.center.y));
  ctx.stroke();

  // Hollow, like a merge dot: the shape says "this is not a commit" before any of the text does.
  ctx.beginPath();
  ctx.arc(x, top, DOT_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--weft-bg').trim();
  ctx.fill();
  ctx.stroke();
  ctx.setLineDash([]);
}

function applyDelta(delta: GraphDelta): void {
  graphWidth = Math.max(graphWidth, delta.width);
  dots.push(...delta.dots);

  for (const dot of delta.dots) {
    if (dot.kind === DotKind.Head) {
      headDot = dot;
    }
  }

  for (const p of delta.paths as readonly PathDelta[]) {
    const existing = paths.get(p.id);
    if (existing === undefined) {
      paths.set(p.id, { color: p.color, points: [...p.points] });
    } else {
      existing.points.push(...p.points);
    }
  }
}

/**
 * Put the rows in the order the header asks for, and tell the rest of the view about it.
 *
 * Every index the view holds - the selection above all - belongs to the *previous* order, so the
 * selected commit is followed by identity rather than by position. Losing it would be a real loss:
 * the details pane below is showing it.
 */
function applyView(): void {
  const keepUncommitted = selected >= 0 && view[selected]?.uncommitted === true;
  const keep = selected < 0 ? undefined : view[selected]?.sha;
  const history = sort !== null && complete ? sortRows(rows, sort) : rows;

  // Always at the top, whatever the sort: it has no date and no author to be ordered by, and it is
  // the one row that is about now rather than about the past.
  view = working.total === 0 ? history : [uncommittedRow(), ...history];

  // Nothing to do: the mark is a sha, so it survives a sort, a filter and the reload after one -
  // which is the only way to reach a commit far enough away to be worth marking one for.

  selected = keepUncommitted
    ? 0
    : keep === undefined || keep === ''
      ? -1
      : view.findIndex((row) => row.sha === keep);

  document.body.classList.toggle('flat', isFlat());
  spacer.style.height = `${view.length * rowHeight}px`;
  updateColumns();

  if (selected >= 0) {
    scrollRowIntoView(selected);
  }

  schedule();
}

/**
 * Click a column: sort by it, reverse it, then give it up.
 *
 * The third state is not decoration. Sorting turns the graph off, and a two-state header would
 * leave no way back to it short of reloading - so the cycle returns to git's order rather than
 * bouncing between two sorts forever.
 */
function cycleSort(column: SortColumn): void {
  if (sort === null || sort.column !== column) {
    sort = { column, direction: FIRST_DIRECTION[column] };
  } else if (sort.direction === FIRST_DIRECTION[column]) {
    sort = { column, direction: sort.direction === 'asc' ? 'desc' : 'asc' };
  } else {
    sort = null;
  }

  saveViewState();
  applyView();
}

/*
 * The three columns that can be resized and switched off.
 *
 * Description is not among them on purpose. It is the `1fr` that absorbs whatever the other three
 * leave, so it has no width of its own to drag, and it is the column people came to read - a header
 * menu that offers to hide it is offering a graph with no subjects in it.
 *
 * Defaults stay in `ch` rather than pixels so they follow the editor's font. A width only becomes a
 * number once somebody drags one, and only that column stops adapting.
 */
const FIXED_COLUMNS = [
  { key: 'author', label: 'Author', fallback: '16ch' },
  { key: 'date', label: 'Date', fallback: '10ch' },
  { key: 'sha', label: 'Commit', fallback: '9ch' },
] as const;

type ColumnKey = (typeof FIXED_COLUMNS)[number]['key'];

const columnState: Record<string, { width?: number; hidden: boolean }> = {
  author: { hidden: false },
  date: { hidden: false },
  sha: { hidden: false },
};

/** The narrowest a column may be dragged - below this the header text is gone and so is the grip. */
const MIN_COLUMN = 36;

/**
 * Push the column layout onto the root, where the stylesheet reads it.
 *
 * Custom properties rather than a generated stylesheet: the content security policy has no
 * `unsafe-inline` for styles, and setting a property through the CSSOM is not what that forbids.
 */
function applyColumns(): void {
  const root = document.documentElement;
  const tracks = ['minmax(6ch, 1fr)'];
  let track = 1;

  for (const column of FIXED_COLUMNS) {
    const state = columnState[column.key] ?? { hidden: false };

    if (state.hidden) {
      root.style.setProperty(`--weft-col-${column.key}-show`, 'none');
      continue;
    }

    root.style.removeProperty(`--weft-col-${column.key}-show`);
    track += 1;
    tracks.push(state.width === undefined ? column.fallback : `${state.width}px`);
    root.style.setProperty(`--weft-col-${column.key}`, String(track));
  }

  root.style.setProperty('--weft-columns', tracks.join(' '));
  placeGrips();
  schedule();
}

/**
 * Put each grip on its column's left edge.
 *
 * Measured rather than computed: the tracks can be `ch`, the gap is its own value, and the header
 * carries a left padding that follows the graph's width. Reading the boxes back is the one way to
 * be right about all three at once.
 */
function placeGrips(): void {
  const bar = columnsEl.getBoundingClientRect();

  for (const column of FIXED_COLUMNS) {
    const grip = columnsEl.querySelector<HTMLElement>(`.col-grip[data-grip='${column.key}']`);
    const cell = columnsEl.querySelector<HTMLElement>(`.col[data-sort='${column.key}']`);

    if (grip === null || cell === null) {
      continue;
    }

    const state = columnState[column.key] ?? { hidden: false };
    grip.hidden = state.hidden;

    if (!state.hidden) {
      // Half the gap to the left of the cell, so the line sits between the two columns rather than
      // against the text of one of them.
      grip.style.left = `${cell.getBoundingClientRect().left - bar.left - 8}px`;
    }
  }
}

function setColumnWidth(key: ColumnKey, width: number): void {
  const state = columnState[key];

  if (state === undefined) {
    return;
  }

  // Leave the subject something to be. Without a ceiling a determined drag can take every pixel,
  // and the column that matters most is the one with no minimum of its own to defend it.
  const ceiling = Math.max(MIN_COLUMN, columnsEl.clientWidth - 120);

  state.width = Math.round(Math.min(Math.max(width, MIN_COLUMN), ceiling));
  applyColumns();
}

columnsEl.addEventListener('pointerdown', (event: PointerEvent) => {
  const grip = (event.target as HTMLElement).closest('.col-grip') as HTMLElement | null;

  if (grip === null) {
    return;
  }

  const key = grip.dataset['grip'] as ColumnKey;
  const cell = columnsEl.querySelector<HTMLElement>(`.col[data-sort='${key}']`);

  if (cell === null) {
    return;
  }

  const startX = event.clientX;
  const startWidth = cell.getBoundingClientRect().width;

  grip.setPointerCapture(event.pointerId);
  grip.classList.add('dragging');
  event.preventDefault();

  // The fixed columns are anchored to the right, so the boundary moving left is the column growing.
  const onMove = (move: PointerEvent): void => setColumnWidth(key, startWidth - (move.clientX - startX));

  const onUp = (): void => {
    grip.classList.remove('dragging');
    grip.removeEventListener('pointermove', onMove);
    grip.removeEventListener('pointerup', onUp);
    grip.removeEventListener('pointercancel', onUp);
    saveViewState();
  };

  grip.addEventListener('pointermove', onMove);
  grip.addEventListener('pointerup', onUp);
  grip.addEventListener('pointercancel', onUp);
});

// Double-clicking a sash to reset it is the convention everywhere else in VS Code.
columnsEl.addEventListener('dblclick', (event) => {
  const grip = (event.target as HTMLElement).closest('.col-grip') as HTMLElement | null;

  if (grip === null) {
    return;
  }

  const state = columnState[grip.dataset['grip'] as ColumnKey];

  if (state !== undefined) {
    // Back to the `ch` default, which means back to following the font rather than to a number
    // that happened to be right once.
    delete state.width;
    applyColumns();
    saveViewState();
  }
});

/** Right-clicking the header offers the columns; Description is listed but never switchable. */
function openColumnMenu(event: MouseEvent): void {
  closeMenu();

  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');

  const entry = (label: string, on: boolean, run: (() => void) | null): void => {
    const el = document.createElement('div');

    el.className = `menu-item${run === null ? ' disabled' : ''}`;
    el.setAttribute('role', 'menuitemcheckbox');
    el.setAttribute('aria-checked', String(on));
    el.append(span('menu-tick', on ? '\u2713' : '\u00A0'), span('menu-label-text', label));

    if (run !== null) {
      el.addEventListener('click', () => {
        closeMenu();
        run();
      });
    }

    menu.append(el);
  };

  // Listed and greyed rather than left out: its absence would read as a bug of its own, and the
  // reason it cannot be switched off is that it is the column people came to read.
  entry('Description', true, null);

  for (const column of FIXED_COLUMNS) {
    const state = columnState[column.key] ?? { hidden: false };

    entry(column.label, !state.hidden, () => {
      state.hidden = !state.hidden;
      applyColumns();
      saveViewState();
    });
  }

  const rule = document.createElement('div');
  rule.className = 'menu-separator';
  menu.append(rule);

  const reset = document.createElement('div');
  reset.className = 'menu-item';
  reset.setAttribute('role', 'menuitem');
  reset.textContent = 'Reset columns';
  reset.addEventListener('click', () => {
    closeMenu();

    for (const column of FIXED_COLUMNS) {
      columnState[column.key] = { hidden: false };
    }

    applyColumns();
    saveViewState();
  });

  menu.append(reset);
  showMenuAt(menu, event.clientX, event.clientY);
}

columnsEl.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  openColumnMenu(event);
});

/** The header's arrows, emphasis and enabled state - everything that reports the current order. */
function updateColumns(): void {
  columnsEl.querySelectorAll<HTMLButtonElement>('.col').forEach((button) => {
    const column = button.dataset['sort'] as SortColumn;
    const active = sort?.column === column;
    const arrow = button.querySelector('.sort-arrow');
    // The label is the leading text node; `textContent` would drag the arrow into the tooltip.
    const label = button.firstChild?.textContent?.trim() ?? column;

    button.classList.toggle('sorted', active);
    button.disabled = !complete;
    button.title = complete
      ? `Sort by ${label}`
      : 'Sorting waits for the history to finish loading';

    if (arrow !== null) {
      arrow.textContent = active ? (sort?.direction === 'asc' ? '▲' : '▼') : '';
    }
  });

  clearSortEl.hidden = !isFlat();
}

columnsEl.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest('.col') as HTMLButtonElement | null;

  if (button !== null && !button.disabled) {
    cycleSort(button.dataset['sort'] as SortColumn);
  }
});

clearSortEl.addEventListener('click', () => {
  sort = null;
  saveViewState();
  applyView();
});

function reset(): void {
  rows = [];
  view = rows;
  complete = false;
  working = { total: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, branch: null };
  headDot = null;
  remote = { upstream: null, branch: null, fetchedAt: null };
  upstreamEl.hidden = true;
  dots = [];
  paths.clear();
  graphWidth = 0;
  selected = -1;
  spacer.style.height = '0px';
  rowsEl.replaceChildren();
  detailsEl.hidden = true;
  splitter.hidden = true;
  currentDetails = null;
  header.classList.remove('error');
  statusEl.textContent = 'loading…';
  document.body.classList.remove('flat');
  updateColumns();
}

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const message = event.data;

  switch (message.type) {
    case 'init':
      rowHeight = message.rowHeight;
      document.documentElement.style.setProperty('--weft-row-height', `${rowHeight}px`);
      titleEl.textContent = message.kind === null
        ? message.repoName
        : `${message.repoName}  (${message.kind})`;
      titleEl.title = message.repoRoot;
      document.body.classList.toggle('author-tint', message.authorColors);
      palette = readPalette();
      break;

    case 'reset':
      reset();
      // Only the host can see all four sources at once - two of them live in Source Control.
      clearFiltersEl.hidden = !message.filtered;
      break;

    case 'filtersCleared':
      clearFilterControls();
      break;

    case 'page':
      rows.push(...message.rows);

      // `view` is `rows` itself unless the working-tree row is in front of it, in which case it is
      // a second array that has to grow too. Pushing beats rebuilding: a page arrives every 500
      // commits, and rebuilding would copy the whole history each time.
      if (view !== rows) {
        view.push(...message.rows);
      }

      applyDelta(message.delta);
      spacer.style.height = `${view.length * rowHeight}px`;
      statusEl.textContent = `${rows.length.toLocaleString()} commits…`;
      schedule();
      break;

    case 'working':
      working = {
        total: message.total,
        staged: message.staged,
        unstaged: message.unstaged,
        untracked: message.untracked,
        conflicted: message.conflicted,
        branch: message.branch,
      };

      remote = { upstream: message.upstream, branch: message.branch, fetchedAt: message.fetchedAt };
      renderRemote();
      applyView();
      break;

    case 'done':
      // An empty result is a real answer, not a blank screen waiting for more.
      statusEl.textContent =
        message.total === 0
          ? 'no matching commits'
          : `${message.total.toLocaleString()} commits in ${message.elapsedMs} ms`;

      // The whole history is here, so a sort the user chose before - or one that outlived a
      // reload - can finally be applied to all of it rather than to whatever had arrived.
      complete = true;
      applyView();
      break;

    case 'details':
      renderDetails(message.details);
      break;

    case 'comparison':
      renderComparison(message);
      break;

    case 'showHistory':
      showHistory(message.path);
      break;

    case 'refs':
      refEntries = message.refs;
      headBranch = message.branch;
      renderBranchButton();

      // Only while it is open: rebuilding a closed menu is work nobody asked for, and rebuilding an
      // open one is the point - a checkout or a tick lands here as the next list.
      if (branchMenuOpen()) {
        renderBranchMenu();
      }

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

  const target = event.target as Node;

  if (branchMenuOpen() && !branchList.contains(target) && !branchButton.contains(target)) {
    closeBranchMenu();
  }
});

window.addEventListener('blur', closeBranchMenu);
window.addEventListener('resize', schedule);

/*
 * Search is debounced and pushed down to git: every keystroke would otherwise start a fresh walk of
 * the history. 300ms is long enough that typing a word costs one query, short enough to feel live.
 */
const searchInput = document.getElementById('search-input') as HTMLInputElement;
const searchMode = document.getElementById('search-mode') as HTMLSelectElement;
const searchToggles = document.getElementById('search-toggles') as HTMLElement;
let searchTimer: number | undefined;

/*
 * All four off by default, which makes the plain case the honest one: what you typed is what git
 * looks for. It used to be a case-insensitive regex whether you wanted one or not, so `v0.4.1`
 * quietly also matched `v0X4Y1`; `.*` turns that back on when it is what you meant.
 */
const searchOptions: Record<SearchToggle, boolean> = {
  caseSensitive: false,
  regex: false,
  allTerms: false,
  invert: false,
  follow: false,
};

function currentMode(): SearchMode {
  return searchMode.value as SearchMode;
}

/** The switches this mode honours; the rest are not shown, because they would do nothing. */
function applicable(): readonly SearchToggle[] {
  return TOGGLES[currentMode()] ?? [];
}

/** What the search box currently asks for, or null when it asks for nothing. */
function currentSearch(): Search | null {
  const query = searchInput.value.trim();

  return query.length === 0 ? null : { query, mode: currentMode(), ...searchOptions };
}

function submitSearch(): void {
  const query = searchInput.value.trim();

  /*
   * A hash is a destination, not a pattern.
   *
   * Only when it actually lands on a row, though: falling through to the search means `deadbeef` in
   * a commit message is still findable, and nothing is lost by trying the jump first.
   */
  if (query.length > 0 && looksLikeCommitId(query)) {
    const index = view.findIndex((row) => row.sha.startsWith(query.toLowerCase()));

    if (index >= 0) {
      select(index);
      statusEl.textContent = `jumped to ${query.slice(0, 8)}`;
      return;
    }
  }

  saveViewState();

  const next = JSON.stringify(currentSearch());

  if (next !== sentSearch) {
    sentSearch = next;
    vscode.postMessage({ type: 'search', search: currentSearch() });
  }
}

function queueSearch(): void {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(submitSearch, 300);
}

/**
 * The pattern to mark up inside the rows, or null when there is nothing to mark.
 *
 * Only for the two modes whose match is visible in a row: a `content` hit is inside a diff and a
 * `path` hit is inside a filename, and neither is on screen to highlight. Inverted search has
 * nothing to mark either - every row on screen is one that did *not* match.
 *
 * The dialect is a compromise. Text mode is exact, because the escape is ours on both sides; a
 * regular expression is git's BRE being read by JavaScript, which agrees on the common cases and
 * not on all of them. A highlight that misses is a hint that missed, so a pattern JavaScript
 * cannot parse simply turns the marking off rather than the search.
 */
function highlightPattern(): RegExp | null {
  const mode = currentMode();
  const query = searchInput.value.trim();

  if (query.length === 0 || searchOptions.invert) {
    return null;
  }

  if (mode !== 'message' && mode !== 'author') {
    return null;
  }

  const terms = searchOptions.allTerms ? query.split(/\s+/).filter((t) => t.length > 0) : [query];

  if (terms.length === 0) {
    return null;
  }

  const source = terms
    .map((term) => (searchOptions.regex ? term : term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('|');

  try {
    return new RegExp(source, searchOptions.caseSensitive ? 'g' : 'gi');
  } catch {
    return null;
  }
}

/** Re-read the search box into the row markup, without asking git for anything. */
function refreshHighlight(): void {
  const next = highlightPattern();
  const changed = next?.source !== highlight?.source || next?.flags !== highlight?.flags;

  highlight = next;

  if (changed) {
    schedule();
  }
}

function updateSearchToggles(): void {
  const supported = applicable();

  /*
   * `--follow` refuses a pathspec with magic in it: `git log --follow -- ':(icase)x'` is a fatal
   * error rather than a quieter answer. So following renames means matching the path exactly, and
   * the case switch is shown locked on instead of offering to turn off something that git was
   * never going to do.
   */
  const exact = currentMode() === 'path' && searchOptions.follow;

  searchToggles.querySelectorAll<HTMLButtonElement>('.toggle').forEach((button) => {
    const toggle = button.dataset['toggle'] as SearchToggle;
    const shown = supported.includes(toggle);
    const locked = exact && toggle === 'caseSensitive';

    button.hidden = !shown;
    button.disabled = locked;
    button.classList.toggle('on', shown && (locked || searchOptions[toggle]));

    if (locked) {
      button.title = 'Following renames matches the path exactly: git will not follow a case-insensitive pathspec.';
    }
  });
}

searchToggles.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest('.toggle') as HTMLButtonElement | null;

  if (button === null || button.disabled) {
    return;
  }

  const toggle = button.dataset['toggle'] as SearchToggle;
  searchOptions[toggle] = !searchOptions[toggle];

  updateSearchToggles();
  saveViewState();
  refreshHighlight();

  // A click is a decision, not a keystroke: there is nothing to wait for.
  if (searchInput.value.trim().length > 0) {
    window.clearTimeout(searchTimer);
    submitSearch();
  }
});

searchInput.addEventListener('input', () => {
  refreshHighlight();
  queueSearch();
});

searchMode.addEventListener('change', () => {
  updateSearchToggles();
  refreshHighlight();

  if (searchInput.value.trim().length > 0) {
    submitSearch();
  }
});

/** `3h`, `12m`, `just now` - short enough to sit next to two numbers without becoming a sentence. */
function ago(since: number): string {
  const minutes = Math.floor((Date.now() - since) / 60_000);

  if (minutes < 1) {
    return 'just now';
  }

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);

  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/**
 * Where the branch stands against the one it tracks, and how old that answer is.
 *
 * The age is not decoration. `origin/main` is a local pointer that only a fetch moves, so every
 * count here is a statement about the last fetch rather than about now - `↓0` after three hours
 * offline means "nothing had arrived three hours ago", and read without the timestamp it means
 * "you are up to date". That is the whole way a graph misleads about a remote, and it is why this
 * stays on screen when the counts are zero: the zero is the number most likely to be believed.
 */
function renderRemote(): void {
  const { upstream, branch, fetchedAt } = remote;

  if (upstream === null && fetchedAt === null) {
    upstreamEl.hidden = true;
    return;
  }

  // Not the branch name: the button beside this says it, and on `claude/changelog-v0.52.0` having
  // it twice was most of why the row would not fit. (It was also picking up `.branch-name` from the
  // menu rows, `flex: 1 1 auto` and all, and growing to fill whatever was left.)
  const parts: HTMLElement[] = [];

  if (upstream?.gone === true) {
    // The ref's name is in the tooltip; on the line it would only push the branch out of sight.
    parts.push(span('gone', 'upstream gone'));
  } else if (upstream !== null) {
    if (upstream.ahead > 0) {
      parts.push(span('ahead', `↑${upstream.ahead}`));
    }

    if (upstream.behind > 0) {
      parts.push(span('behind', `↓${upstream.behind}`));
    }
  }

  parts.push(span('fetched', fetchedAt === null ? 'never fetched' : `fetched ${ago(fetchedAt)}`));

  upstreamEl.replaceChildren(...parts);

  const standing =
    upstream === null
      ? 'This branch tracks nothing.'
      : upstream.gone
        ? `${branch ?? 'HEAD'} tracks ${upstream.ref}, which no longer exists on the remote.`
        : `${branch ?? 'HEAD'} is ${upstream.ahead} ahead of and ${upstream.behind} behind ${upstream.ref}.`;

  upstreamEl.title =
    fetchedAt === null
      ? `${standing}\n\nNothing has been fetched yet, so the remote's position is unknown.`
      : `${standing}\n\nTrue as of the last fetch, ${ago(fetchedAt)}. A remote-tracking ref only moves when something fetches.`;

  upstreamEl.hidden = false;
}

// The age has to keep counting on its own: with no fetch and no reload, nothing else would ever
// come along to correct "just now" into the hour it has since become.
window.setInterval(() => {
  if (!upstreamEl.hidden) {
    renderRemote();
  }
}, 30_000);

function updateFirstParent(): void {
  firstParentEl.classList.toggle('on', firstParent);
}

commitOrderEl.addEventListener('change', () => {
  commitOrder = commitOrderEl.value as CommitOrder;
  saveViewState();
  vscode.postMessage({ type: 'order', order: commitOrder });
});

firstParentEl.addEventListener('click', () => {
  firstParent = !firstParent;
  updateFirstParent();
  saveViewState();
  vscode.postMessage({ type: 'firstParent', on: firstParent });
});

/**
 * Put every control in this view back to "no filter", without asking for anything.
 *
 * Silent on purpose: this runs *because* the host has already dropped the filters and is reloading,
 * so a `search` or `dates` message from here would be a second walk saying the same thing.
 */
function clearFilterControls(): void {
  searchInput.value = '';
  searchMode.value = 'message';
  dateRange.value = '';
  dateSince.value = '';
  dateUntil.value = '';
  dateCustom.hidden = true;

  for (const toggle of Object.keys(searchOptions) as SearchToggle[]) {
    searchOptions[toggle] = false;
  }

  window.clearTimeout(searchTimer);
  sentSearch = 'null';
  sentDates = 'null';
  firstParent = false;
  updateFirstParent();
  updateSearchToggles();
  refreshHighlight();
  saveViewState();
}

clearFiltersEl.addEventListener('click', () => vscode.postMessage({ type: 'clearFilters' }));

/*
 * The date filter. A separate message from the search rather than a mode of it, because the two
 * combine: "what did Ada touch today" is one question, not two that cancel each other out.
 */
const dateRange = document.getElementById('date-range') as HTMLSelectElement;
const dateCustom = document.getElementById('date-custom') as HTMLElement;
const dateSince = document.getElementById('date-since') as HTMLInputElement;
const dateUntil = document.getElementById('date-until') as HTMLInputElement;
const dateClose = document.getElementById('date-close') as HTMLButtonElement;

/*
 * What the host was last told, so that telling it again can be skipped.
 *
 * Every one of these messages costs a full walk of the history, and the ways to ask for a walk that
 * is already on screen are not exotic: type a word and delete it, open the custom range and close
 * it again, pick `any time` when there was never a date filter.
 */
let sentSearch = 'null';
let sentDates = 'null';

/**
 * A day, `YYYY-MM-DD`, in the reader's own timezone.
 *
 * `toISOString` would be UTC, which is the wrong day for anyone far enough east or west of it -
 * "today" would start in the middle of the afternoon, or yesterday.
 */
function day(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The range the controls are currently describing, or null for the whole history. */
function currentRange(): DateRange | null {
  const choice = dateRange.value;

  if (choice === '') {
    return null;
  }

  if (choice === 'custom') {
    const since = dateSince.value === '' ? null : dateSince.value;
    const until = dateUntil.value === '' ? null : dateUntil.value;

    return since === null && until === null ? null : { since, until };
  }

  // The presets are all "the last N days, today included", and today is N = 0.
  const back = choice === 'today' ? 0 : Number(choice);
  const from = new Date();

  from.setDate(from.getDate() - back);

  return { since: day(from), until: null };
}

/**
 * Ask for one file's history: the path search, with renames followed.
 *
 * Driven from the changed-file list rather than typed, so the path is git's own spelling of it -
 * which matters more than usual here, because following renames is the one path search that cannot
 * be case-insensitive.
 */
function showHistory(path: string): void {
  searchMode.value = 'path';
  searchInput.value = path;

  for (const toggle of Object.keys(searchOptions) as SearchToggle[]) {
    searchOptions[toggle] = toggle === 'follow';
  }

  dateRange.value = '';
  dateSince.value = '';
  dateUntil.value = '';
  dateCustom.hidden = true;

  updateSearchToggles();
  refreshHighlight();
  submitDates();
  window.clearTimeout(searchTimer);
  submitSearch();
}

function submitDates(): void {
  dateCustom.hidden = dateRange.value !== 'custom';
  saveViewState();

  const range = currentRange();
  const next = JSON.stringify(range);

  if (next !== sentDates) {
    sentDates = next;
    vscode.postMessage({ type: 'dates', range });
  }
}

dateRange.addEventListener('change', () => {
  /*
   * Opening the custom row is not itself a filter: with both boxes empty there is no range to ask
   * for, and reloading the graph to show what it already shows is a walk nobody asked for.
   */
  const opening = dateRange.value === 'custom' && currentRange() === null;

  dateCustom.hidden = dateRange.value !== 'custom';

  if (opening) {
    dateSince.focus();
    return;
  }

  submitDates();
});

dateSince.addEventListener('change', submitDates);
dateUntil.addEventListener('change', submitDates);

dateClose.addEventListener('click', () => {
  dateRange.value = '';
  dateSince.value = '';
  dateUntil.value = '';
  submitDates();
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
    // Innermost first: the menu, then the comparison, then the pane. Closing more than one of them
    // at a time would be one keystroke doing something the user did not ask for.
    if (branchMenuOpen()) {
      closeBranchMenu();
      return;
    }

    if (menuEl !== null) {
      closeMenu();
      event.preventDefault();
      return;
    }

    if (comparedTo !== null || compareFrom !== null) {
      clearComparison();
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
      select(Math.min(view.length - 1, from + page));
      break;
    case 'PageUp':
      select(Math.max(0, from - page));
      break;
    case 'Home':
      select(0);
      break;
    case 'End':
      select(view.length - 1);
      break;
    default:
      return;
  }

  event.preventDefault();
});

restoreViewState();

// Before anything has loaded the header still has to say something true: no history yet, so no
// sorting yet, and whichever column survived in the view state showing dimmed as what is queued.
updateColumns();
updateSearchToggles();
updateFirstParent();
updateCompareMark();
refreshHighlight();

// The filters go out with the handshake rather than as a second message, so the host walks the
// history once - with the filters the boxes are showing rather than with whatever it still held.
sentSearch = JSON.stringify(currentSearch());
sentDates = JSON.stringify(currentRange());

vscode.postMessage({
  type: 'ready',
  search: currentSearch(),
  dates: currentRange(),
  firstParent,
  order: commitOrder,
});
