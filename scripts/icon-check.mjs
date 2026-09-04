/**
 * Renders an SVG the way the Activity Bar does, at the size it actually appears.
 *
 * An icon that looks fine at 96px can collapse into a smudge at 24, and the difference is invisible
 * in a design tool that keeps everything comfortably large. This rasterises at the real size and
 * then magnifies with smoothing off, so what you judge is the pixels VS Code will draw.
 *
 * VS Code uses the SVG as a CSS mask - only the alpha channel survives - so the preview throws the
 * colours away too and shows the silhouette alone.
 *
 *   npm run build && node scripts/icon-check.mjs && node scripts/serve.mjs
 *   # then open http://localhost:4173/icon-check.html
 */
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const source = process.argv[2] ?? 'media';
const outDir = 'dist/icons';

mkdirSync(outDir, { recursive: true });

const icons = readdirSync(source).filter((name) => name.endsWith('.svg'));

for (const icon of icons) {
  copyFileSync(join(source, icon), join(outDir, icon));
}

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Icon check</title>
<style>
 body{background:#1f1f1f;color:#bbb;font:12px system-ui;margin:0;padding:20px}
 .row{display:flex;gap:22px;flex-wrap:wrap}
 .col{text-align:center}
 canvas{background:#181818;border-radius:3px;display:block;image-rendering:pixelated}
 .lbl{margin-top:6px;color:#7a7a7a}
 h3{color:#888;font-weight:500;margin:0 0 12px}
</style></head><body>
<h3>Rasterised at 24&times;24, magnified 6&times; with smoothing off &mdash; the pixels the Activity Bar draws</h3>
<div class="row" id="out"></div>
<script>
const names = ${JSON.stringify(icons)};
const out = document.getElementById('out');
let done = 0;

for (const name of names) {
  const col = document.createElement('div');
  col.className = 'col';

  const canvas = document.createElement('canvas');
  canvas.width = 144;
  canvas.height = 144;

  const label = document.createElement('div');
  label.className = 'lbl';
  label.textContent = name;

  col.append(canvas, label);
  out.append(col);

  const img = new Image();
  img.onload = () => {
    const small = document.createElement('canvas');
    small.width = 24;
    small.height = 24;

    const s = small.getContext('2d');
    s.drawImage(img, 0, 0, 24, 24);

    // Flatten every pixel to one colour so only the alpha - the mask - is being judged.
    const data = s.getImageData(0, 0, 24, 24);
    for (let i = 0; i < data.data.length; i += 4) {
      data.data[i] = 210;
      data.data[i + 1] = 210;
      data.data[i + 2] = 210;
    }
    s.putImageData(data, 0, 0);

    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, 144, 144);

    if (++done === names.length) {
      document.title = 'ready';
    }
  };

  img.src = 'icons/' + name;
}
</script>
</body></html>
`;

writeFileSync('dist/icon-check.html', html);
console.log(`dist/icon-check.html  <- ${icons.length} icon(s) from ${source}/`);
