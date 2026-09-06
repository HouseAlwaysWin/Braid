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
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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

/*
 * And the marketplace icon, which is a different thing from the ones above.
 *
 * Those are drawn at 16px as CSS masks and only their alpha survives. This one is its own picture
 * on its own ground, seen at about 90px in the gallery, and the marketplace will not take an SVG -
 * so `media/icon.png` is committed, rasterised from `media/icon.svg` by a browser (this project has
 * five devDependencies and none of them can draw; adding a rasteriser for one file that changes
 * about never would be the largest of them by an order of magnitude).
 *
 * A committed binary is a thing that goes stale silently, so what can be checked here is checked:
 * that it is there, that it is a real PNG, and that it is the size the marketplace requires. A
 * missing or wrong-sized icon then fails the build rather than the upload.
 */
{
  const declared = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).icon;
  const problems = [];

  if (declared === undefined) {
    problems.push('package.json declares no icon, so the marketplace listing gets a placeholder');
  } else {
    let png;

    try {
      png = readFileSync(new URL(`../${declared}`, import.meta.url));
    } catch {
      problems.push(`package.json points at ${declared}, which is not there`);
    }

    if (png !== undefined) {
      const signature = png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
      const width = signature ? png.readUInt32BE(16) : 0;
      const height = signature ? png.readUInt32BE(20) : 0;

      console.log(`\nmarketplace    : ${declared} ${width}x${height}, ${png.length} bytes`);

      if (!signature) {
        problems.push(`${declared} is not a PNG - the marketplace will not take an SVG here`);
      } else if (width < 128 || height < 128) {
        problems.push(`${declared} is ${width}x${height}; the marketplace wants at least 128x128`);
      } else if (width !== height) {
        problems.push(`${declared} is ${width}x${height}, and a non-square icon is cropped`);
      }
    }
  }

  for (const problem of problems) {
    console.error(`  ! ${problem}`);
  }

  if (problems.length > 0) {
    console.log('FAILED');
    process.exit(1);
  }

  console.log('OK - the marketplace icon is a square PNG of the right size.');
}
