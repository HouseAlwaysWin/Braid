# Braid

A Git commit graph for VS Code, fast on large repositories.

Braid is an independent extension, written from scratch. It is not a fork of, and shares no code
with, any other graph extension.

## Status

Early, but in daily use. Reading is complete; writing is arriving one tier at a time.

Working:

- Commit graph with branches, merges, tags, remotes and HEAD
- Ordinary clones, bare repositories, linked worktrees and submodules
- Streaming load: the first rows paint while git is still walking
- Virtualized rendering: a 20,000-row history keeps 31 row elements in the DOM
- Click or arrow-key a commit for its message, metadata and changed files
- Double-click a file to open it in VS Code's own diff editor, renames included
- Search by message, author, diff content (`-G`) or path, pushed down into `git log`
- Auto-refresh: commit from a terminal and the graph reloads itself
- Right-click to act: checkout (branch, remote branch, or a commit detached), create and rename
  branches, create lightweight or annotated tags, delete branches and tags
- Merge and rebase, with a banner while either is unfinished: Continue, Skip, Abort, and the
  conflicted files as links into VS Code's merge editor
- Cherry-pick, revert, and reset (soft, mixed or hard) from any commit
- Stashes appear in the graph, with apply, pop and drop on the row and a Stash Changes command
- Two sidebar filters: untick branches, remotes or tags to keep them out of the walk, and tick
  authors to show only theirs. Both narrow what `git log` walks rather than hiding rows
- A text filter for the branch list itself, for repositories with more refs than fit on screen
- Each author gets their own colour, derived from the name so it never shifts as pages stream in
- Draggable split between the graph and the details pane, and a tree/flat toggle for the
  changed-file list - both remembered across panel reloads

Write operations are arriving one tier at a time. Anything that could destroy uncommitted work
names the files it would destroy before asking; nothing passes `--force` by default. Still to come: fetch, pull and push.

## Where to find it

The graph opens as an editor tab. Three ways in:

- The **Braid** button in the status bar (hidden when the workspace has no repository)
- The branch icon in the **Source Control** title bar
- **Braid: Open Git Graph** in the command palette

The Activity Bar icon opens the **Branches & Tags** sidebar rather than the graph - VS Code puts
view containers there, not commands. Unticking a ref there narrows what `git log` walks, so a
repository carrying two hundred `origin/dependabot/*` branches stops paying for them.

## Design notes

**The layout is resumable.** Lane assignment is a single forward pass, so its entire continuation is
`{open lanes, colour queue, row index}`. Holding that in a `LayoutState` means page N+1 is laid out
without touching a row of pages 1..N — which is what makes a large repository viable, and has the
side effect that a commit's colour never changes once assigned.

**Lanes are polylines that only turn.** A lane running straight for a thousand rows costs two
points. Measured on a 100k-commit repository: 100,000 rows of graph, 7,998 points.

**Y is measured in rows, not pixels.** A point at `y` is drawn at `y * rowHeight - scrollTop`, so
the canvas stays locked to the row text and changing the row height needs no re-layout.

**One streaming `git log`, not paged calls.** Paging with `--skip=N` makes git re-walk N commits per
page, which is quadratic across a full scroll; separate calls can also straddle a ref update and
produce a history that contradicts itself. One long-lived process walks a single consistent
snapshot and the graph paints as records arrive.

## Measurements

On a synthetic 100,000-commit repository (`scripts/make-fixture.mjs`), Windows 11, git 2.55:

| | |
| --- | --- |
| First page on screen | 622 ms |
| Full history walked and laid out | 1.1 s |
| Throughput | ~90,000 commits/sec |
| Graph points for 100k rows | 7,998 |
| Parsed history in memory | 68 MB |

Memory is the number that still needs work: 68 MB of commit objects is more than an extension host
should hold, and the next optimisation is a columnar store rather than one object per commit.

## Development

```bash
npm install
npm run build      # or: npm run watch
npm test           # build, unit tests, then a full end-to-end run against a throwaway repo
npm run typecheck
npm run color-check  # contrast and separation of the author tints, in both themes
```

Press <kbd>F5</kbd> to launch an Extension Development Host.

To look at the view without VS Code — it renders the real webview with real repository data:

```bash
npm run build && node scripts/preview.mjs <repo> --max=20000 && node scripts/serve.mjs
```

To build a large repository to test against:

```bash
node scripts/make-fixture.mjs /tmp/braid-100k 100000
```

Tests run on Node's built-in runner with native TypeScript type stripping, so there is no test
framework dependency. `erasableSyntaxOnly` is on in `tsconfig.json` to keep it that way — no
`enum`, no namespaces, no parameter properties.

## Licence

MIT. See [LICENSE](LICENSE), and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for the lane
layout algorithm's attribution.
