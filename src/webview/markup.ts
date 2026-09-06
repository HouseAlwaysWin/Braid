/**
 * The webview's body markup, in one place.
 *
 * Both the real panel and the offline preview harness render this, so the thing being previewed
 * cannot quietly drift away from the thing that ships.
 *
 * The nesting matters: the canvas is a sibling of the scroller, not a child of it. Inside the
 * scroller it would need to be as tall as the whole history - which no browser will allocate at
 * 100k rows - so instead one viewport-sized canvas is overlaid and redrawn per frame with the
 * scroll offset folded into the Y coordinate.
 *
 * The column header is a sibling of the scroller too, for the same reason in reverse: it must not
 * move when the rows do. It carries the same grid template as a row, so a label sits over its own
 * column without either side knowing the other's widths.
 *
 * The search switches sit inside the input rather than beside it - the way VS Code's own find box
 * does - so that a box wide enough to type in stays wide enough to type in.
 *
 * The custom date range sits beside the dropdown that summons it, which is the only place it reads
 * as belonging to it. Two date pickers are a lot of bar, so the header wraps rather than squeezing
 * the query box: on a narrow panel the search moves to a second line instead of shrinking.
 */
export const BODY_MARKUP = `<header id="header">
  <span id="title">Weft</span>
  <span id="upstream" hidden></span>
  <span id="status">loading…</span>
  <button id="compare-mark" type="button" hidden></button>
  <button id="clear-filters" type="button" hidden
    title="Drop the search, the date range, and the branch and author filters in Source Control. The sort is left alone.">clear filters</button>
  <button id="clear-sort" type="button" hidden
    title="A sorted list is flat: the lanes only mean anything in the order git walked them. Click to go back.">graph order</button>
  <span id="search-box">
    <button class="toggle" id="first-parent" type="button"
      title="Walk only the first parent of every merge: the mainline, without the commits that were merged into it.">first parent</button>
    <select id="date-range" title="Limit the walk to a stretch of time. git compares the committer date, which the Date column does not show - identical for ordinary history, different for anything rebased.">
      <option value="">any time</option>
      <option value="today">today</option>
      <option value="7">last 7 days</option>
      <option value="30">last 30 days</option>
      <option value="365">last 12 months</option>
      <option value="custom">custom…</option>
    </select>
    <span id="date-custom" hidden>
      <input id="date-since" type="date" title="From this day. Leave empty for no lower bound.">
      <span class="date-arrow">→</span>
      <input id="date-until" type="date" title="Up to and including this day. Leave empty for no upper bound.">
      <button id="date-close" type="button" title="No date filter" aria-label="Clear the date range">✕</button>
    </span>
    <select id="search-mode" title="What to search">
      <option value="message">message</option>
      <option value="author">author</option>
      <option value="committer">committer</option>
      <option value="content">content</option>
      <option value="path">path</option>
    </select>
    <span id="search-field">
      <input id="search-input" type="search" placeholder="Search or paste a hash" spellcheck="false">
      <span id="search-toggles">
        <button class="toggle" type="button" data-toggle="caseSensitive" title="Match case">Aa</button>
        <button class="toggle" type="button" data-toggle="regex" title="Read the query as a regular expression">.*</button>
        <button class="toggle" type="button" data-toggle="allTerms" title="Require every word, not any one of them">all</button>
        <button class="toggle" type="button" data-toggle="invert" title="Show the commits that do not match">not</button>
        <button class="toggle" type="button" data-toggle="follow" title="Follow the file through renames, so its history does not stop where it was moved. git will not take a case-insensitive path this way, so matching becomes exact.">follow</button>
      </span>
    </span>
  </span>
</header>
<section id="operation" hidden></section>
<div id="columns">
  <button class="col" type="button" data-sort="subject">Description<span class="sort-arrow"></span></button>
  <button class="col" type="button" data-sort="author">Author<span class="sort-arrow"></span></button>
  <button class="col" type="button" data-sort="date">Date<span class="sort-arrow"></span></button>
  <button class="col" type="button" data-sort="sha">Commit<span class="sort-arrow"></span></button>
</div>
<main id="main">
  <div id="viewport"><div id="spacer"></div><div id="rows"></div></div>
  <canvas id="graph"></canvas>
</main>
<div id="splitter" hidden role="separator" aria-orientation="horizontal" title="Drag to resize"></div>
<section id="details" hidden>
  <button id="detail-close" type="button" title="Close (Esc)" aria-label="Close details">✕</button>
  <div id="detail-meta"></div>
  <pre id="detail-body"></pre>
</section>`;
