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
- A row for the working tree when there is one, above the history and hanging off HEAD by a dashed
  line, with what is staged, unstaged and untracked. Click it and the same **Commit Files** section
  lists them; click a file and the diff is HEAD against the file as it is on disk. It keeps up with
  the tree as you save, without re-walking the history to do it
- Where the branch stands against the one it tracks, and how old that answer is:
  `main ↑2 ↓1 fetched 3h ago` beside the title. The age is not decoration - see the design note
- Fetch on a timer if you want one (`braid.autoFetchMinutes`, off by default). Braid also picks up
  fetches it did not run, including VS Code's own `git.autofetch`: the watcher sees the refs move
- Click or arrow-key a commit for its message and metadata; what it changed lands in the **Commit
  Files** section in Source Control, as a folded tree or a flat list
- Ctrl-click a second commit to compare the two: the same section fills with what they differ by,
  and the pane says how far apart they are - a count for each side, because two commits picked off a
  graph are not always one behind the other. Escape puts it back
- Click a file there to open it in VS Code's own diff editor, renames included
- Search by message, author, committer, diff content (`-G`) or path, pushed down into `git log`.
  Match case, regular expression, all-words and invert are switches inside the box, each offered
  only in the modes where git can honour it - and text is the default, so `v0.4.1` no longer
  quietly also matches `v0X4Y1`. Paste a hash instead and it selects that commit rather than
  grepping for it, and whatever matched is marked in the row
- A **first parent** switch: walk the mainline and leave out what was merged into it, which also
  takes the merge arcs with it rather than leaving them pointing at rows that are no longer there
- A date filter beside the search: today, the last 7, 30 or 365 days, or a custom range. It narrows
  the walk like every other filter here, and combines with them - "what did Ada touch today" is one
  question. It compares git's committer date rather than the author date the column shows, which is
  the same thing except for rewritten history
- One button drops every filter at once - the search, the date range, and the branch and author
  ticks in Source Control - and it is on screen only while there is something to drop. The sort is
  left alone: it hides nothing, and it has a way back of its own
- Auto-refresh: commit from a terminal and the graph reloads itself
- Right-click to act: checkout (branch, remote branch, or a commit detached), create and rename
  branches, create lightweight or annotated tags, delete branches and tags
- Merge and rebase, with a banner while either is unfinished: Continue, Skip, Abort, and the
  conflicted files as links into VS Code's merge editor
- Cherry-pick, revert, and reset (soft, mixed or hard) from any commit
- Stashes appear in the graph, with apply, pop and drop on the row and a Stash Changes command
- Column headers, and a click on one sorts by description, author, date or commit. A sorted list is
  flat: a lane's Y coordinate is a row index, so in any order but git's the lines would join commits
  that are no longer neighbours. A third click puts the graph back
- Two filters in the Source Control sidebar: untick branches, remotes or tags to keep them out of
  the walk, and tick authors to show only theirs. Both narrow what `git log` walks rather than
  hiding rows
- Right-click a branch there to check it out, or to **Show Only This** - unticking narrows the tips
  git walks *from*, so hiding one branch changes nothing while its commits are still reachable from
  another, which for a merged branch is always
- The text filter over that list is a way to find a ref, not a way to filter the graph, and the
  message under it says so with the numbers: `Listing 1 of 24 refs matching "claude/". Nothing is
  unticked, so the graph still walks all 24.` One button applies the listing to the graph when that
  is what you meant
- A text filter for the branch list itself, for repositories with more refs than fit on screen
- Each author gets their own colour, derived from the name so it never shifts as pages stream in
- Fetch, pull and push, using whatever credential helper is already set up - Braid never asks for
  a password and never stores one. Pull asks whether to merge or rebase only when the histories
  have actually diverged, and force push is `--force-with-lease` after a fetch, never `--force`
- Draggable split between the graph and the details pane, remembered across panel reloads

Anything that could destroy uncommitted work names the files it would destroy before asking, and
nothing passes `--force` by default. Still to come: following one file through history.

## Where to find it

The graph opens as an editor tab. Three ways in:

- The **Braid** button in the status bar (hidden when the workspace has no repository)
- The branch icon in the **Source Control** title bar
- **Braid: Open Git Graph** in the command palette

Braid has no Activity Bar icon of its own. Its three sections - **Commit Files**, **Branches &
Tags** and **Authors** - live in **Source Control**, under the changes list: collapsed until you
want them, and absent altogether in a workspace with no repository. Unticking a ref there narrows
what `git log` walks, so a repository carrying two hundred `origin/dependabot/*` branches stops
paying for them.

## Design notes

**The layout is resumable.** Lane assignment is a single forward pass, so its entire continuation is
`{open lanes, colour queue, row index}`. Holding that in a `LayoutState` means page N+1 is laid out
without touching a row of pages 1..N — which is what makes a large repository viable, and has the
side effect that a commit's colour never changes once assigned.

**Lanes are polylines that only turn.** A lane running straight for a thousand rows costs two
points. Measured on a 100k-commit repository: 100,000 rows of graph, 7,998 points.

**The network actions are not the ones Source Control already has.** They look like duplicates and
are not: `git.fetchOnPull` is off by default, so the built-in pull fetches only the branch it is
about to merge and leaves the rest of the graph as stale as it found it. Braid's fetches the whole
remote, then re-reads the counts before deciding anything. `git.rebaseWhenSync` is off too, so a
divergence becomes a merge commit without being mentioned; Braid asks, and says what rebase does to
the hashes before it does it. Behind but not ahead is `merge --ff-only`, so there is no accidental
merge commit at all. The buttons are the duplication; the behaviour is the reason.

**A remote-tracking ref is a local pointer.** `origin/main` moves when something fetches and at no
other time, so every ahead/behind count is a statement about the last fetch rather than about now.
Three hours offline and `↓0` still means "nothing had arrived three hours ago" - which read without
a timestamp means "you are up to date", and that is the whole way a graph misleads about a remote.
So the age travels with the counts and stays on screen when they are zero, because zero is the
number most likely to be believed. `FETCH_HEAD`'s mtime is the answer, and costs one `stat`.

Acting on those counts is a separate problem, and solved separately: pull fetches the whole remote
first and then *re-reads* the counts before deciding anything, because the ones it was given are
stale by definition.

**The working tree is watched by someone else.** `RepoWatcher` watches `.git`, which is where a ref
moving shows up and is deliberately not where a file being saved does - watching a whole worktree
means an event per keystroke of an editor's autosave. So the working-tree row listens to the
built-in git extension instead, which is already running `git status` on its own debounce. What it
triggers is one `git status`, not a reload: saving a file changes nothing a walk would produce
differently, and re-walking would be paying for the whole graph to move one row's worth of text.

**The working tree is a row, not a commit.** It is built in the view rather than sent by the host,
and deliberately kept out of the lane layout: a lane point's Y *is* a commit's row index, so a row
that appears and disappears as files are saved would renumber every one of them and force a
re-layout of the whole history. Instead it takes display position zero and the canvas shifts down
by one - one number, no re-layout, and a dashed line to say that nothing up there is reachable yet.

**The pane is for the commit, the sidebar is for its files.** The details pane is wide and short;
a file list is narrow and tall. Ten files in a 200px strip under a 20,000-row history was the wrong
shape for both, so the list is a tree view now - which also means folding, status colours and
one-click opening come from VS Code rather than from three hundred lines of webview.

**The checkboxes are Braid's, not VS Code's.** A tree view manages checkbox state itself unless
told otherwise, and what it means by a ticked parent is "every child is ticked" - which it will
enforce at the next render. Braid means something else by a ticked group: "some of these are
showing". The two disagreeing looked like unticking a branch putting its own tick straight back on,
and the fix is one flag saying who owns them.

**git's date flags need spelling out.** A bare `--since=2026-07-24` is not midnight: approxidate
fills the unspecified fields from the current clock, so run at 20:08 it means that evening - and
answers differently an hour later. Measured, it returned one commit from a day that held twelve.
`--until=<day>` likewise means *before* that day. Both bounds are sent with an explicit time, and
the lower one as `--since-as-filter` where git is new enough (2.37): plain `--since` stops walking
at the first commit older than the cutoff, which hides newer commits behind an older one in a
history whose dates are not monotonic. That gives up the early exit, which streaming makes
affordable - rows still appear as they are found.

**git's regexes are basic ones, not the ones you think in.** `--grep`, `--author` and `-G` are
POSIX *basic* regular expressions, where `+ ? ( ) { } |` are literal until you escape them - `\+`
is the one-or-more operator. Escaping a name the JavaScript way turns `C++` into a pattern meaning
something else and `A|B` into two different people, so the escape is one named function with the
dialect written down beside it. `--fixed-strings` would do the job, and is not used: it is a global
flag, so it would also reach the `--author` arguments the Authors sidebar contributes.

**Y is measured in rows, not pixels.** A point at `y` is drawn at `y * rowHeight - scrollTop`, so
the canvas stays locked to the row text and changing the row height needs no re-layout. It is also
why sorting hides the graph rather than redrawing it: reorder the rows and the text slides out from
under lines that are still where the layout put them.

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
