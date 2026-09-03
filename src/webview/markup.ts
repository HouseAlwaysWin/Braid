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
 */
export const BODY_MARKUP = `<header id="header">
  <span id="title">Braid</span>
  <span id="status">loading…</span>
  <span id="search-box">
    <select id="search-mode" title="What to search">
      <option value="message">message</option>
      <option value="author">author</option>
      <option value="content">content</option>
      <option value="path">path</option>
    </select>
    <input id="search-input" type="search" placeholder="Search commits…" spellcheck="false">
  </span>
</header>
<main id="main">
  <div id="viewport"><div id="spacer"></div><div id="rows"></div></div>
  <canvas id="graph"></canvas>
</main>
<section id="details" hidden>
  <div id="detail-meta"></div>
  <pre id="detail-body"></pre>
  <div id="detail-files"></div>
</section>`;
