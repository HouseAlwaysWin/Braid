# Contributing

```bash
npm install
npm run build      # or: npm run watch
npm test           # build, unit tests, then a full end-to-end run against a throwaway repo
npm run typecheck
npm run color-check  # contrast and separation of the author tints, in both themes
npm run column-check # the column controls against the stylesheet that has to read them
npm run icon-check   # renders the icons at the size they are actually drawn
```

`media/icon.png` is the marketplace icon and is committed rather than built: it has to be a PNG,
none of the five devDependencies can draw one, and a rasteriser for a single file that changes about
never would be the largest dependency here by an order of magnitude. It is rendered from
`media/icon.svg`, which is the source. To redo it, serve the SVG and let a browser rasterise it:

```bash
npm run icon-check && node scripts/serve.mjs   # then, in the page's console:
```

```js
const svg = await (await fetch('/icons/icon.svg')).text();
const img = new Image();
img.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
await img.decode();
const c = Object.assign(document.createElement('canvas'), { width: 128, height: 128 });
c.getContext('2d').drawImage(img, 0, 0, 128, 128);
copy(c.toDataURL('image/png').split(',')[1]); // then base64 -d > media/icon.png
```

`npm test` checks the result is a square PNG of at least 128px, so a stale or broken one fails the
build rather than the upload.

Press <kbd>F5</kbd> to launch an Extension Development Host.

To look at the view without VS Code — it renders the real webview with real repository data:

```bash
npm run build && node scripts/preview.mjs <repo> --max=20000 && node scripts/serve.mjs
```

To build a large repository to test against:

```bash
node scripts/make-fixture.mjs /tmp/weft-100k 100000
```

Tests run on Node's built-in runner with native TypeScript type stripping, so there is no test
framework dependency. `erasableSyntaxOnly` is on in `tsconfig.json` to keep it that way — no
`enum`, no namespaces, no parameter properties.
