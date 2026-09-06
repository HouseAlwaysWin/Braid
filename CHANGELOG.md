# Changelog

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
