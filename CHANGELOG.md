# Changelog

## 0.2.0

- **The lanes no longer take the whole panel.** They are capped at a third of it by default and
  have a grip of their own, and when given less room than they want they are drawn closer together
  rather than cut off.

- **More than one repository in a workspace.** Opening the graph asks which one; each gets its own
  tab, and the sidebar follows whichever is in front while remembering what you ticked in the
  others. Filters are answered per repository - before this, unticking a branch in one graph
  reloaded every other open graph with a list of ref names that do not exist in it.

- **Authors** can be filtered by text, the way branches and tags already could - typing narrows who
  is listed without changing what the graph walks, and **Show Only Who Is Listed** applies the
  listing to it in one click.
- Merging now asks whether to fast-forward or record a merge commit - but only when the branch is
  strictly behind, which is the only case where both are possible.
- **Squash** a branch into the working tree, as its own action. It stages the changes without
  committing, and warns that git will still consider the branch unmerged afterwards.
- A staged squash is recognised as an operation in progress. It leaves no `MERGE_HEAD`, so
  `git merge --abort` refuses it; the banner offers `reset --merge`, which is what actually
  undoes one.

## 0.1.2

- The marketplace description said "read-only", which stopped being true several milestones ago.
  The README was corrected at the time and the manifest was not, so the one line every visitor
  reads first was the one line still claiming the extension only looks.
- Moved building and testing out of the README and into `CONTRIBUTING.md`. The marketplace renders
  the whole README, so the extension's own page was opening on `npm install` - instructions for
  working on it, shown to everyone deciding whether to use it.

0.1.1 was tagged with the first of these and superseded before it was uploaded.

## 0.1.0

The first published version. Everything below is what it does; nothing has shipped before this, so
there is nothing to have changed.

### Reading

- A commit graph with branches, merges, tags, remotes, stashes and HEAD, over ordinary clones, bare
  repositories, linked worktrees and submodules
- Streaming load: the first rows paint while git is still walking. On a 100,000-commit repository
  the first page is on screen in 622 ms and the whole history is laid out in 1.1 s
- Virtualized rendering, so a 20,000-row history keeps 31 row elements in the DOM
- A row for the working tree above the history, hanging off HEAD by a dashed line, that keeps up as
  files are saved without re-walking anything
- Where the branch stands against the one it tracks, and how old that answer is
- Commit details, and what a commit changed in the **Commit Files** section - as a folded tree or a
  flat list, with the diff a click away
- One file's history, with renames followed
- Search by message, author, committer, content or path, with case, regex, all-terms and invert
- A date range, a first-parent walk, and a choice of commit ordering: by commit date, by author
  date, or topological
- Comparing two commits, either through the menu or by ctrl-clicking the second one

### Writing

- Checkout a branch, a remote branch, or a commit
- Create, rename and delete branches; create and delete tags
- Stash, apply, pop and drop
- Merge, rebase, cherry-pick and revert, with a banner for whatever is unfinished and a way out of
  it
- Reset, in all three of its forms, each labelled by what survives rather than by its flag
- Fetch, pull and push, using whatever credential helper is already configured. Pull asks whether to
  merge or rebase only when the histories have actually diverged
- Force push as `--force-with-lease` after a fetch, never `--force`
- Delete a branch on a remote, which is a push and says so
- Add, rename, repoint and remove remotes

Anything that could destroy uncommitted work names the files it would destroy before asking.

### Getting around

- Branches and tags in Source Control, with a tick each for whether the graph draws them
- A branch menu in the header: the same ticks, and a click to check one out
- Author colours derived from the name, so they never shift as pages stream in
- Columns that resize and hide, a draggable split above the details pane, and a filter state that
  survives the tab being hidden
