import * as esbuild from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// The package is ESM (its .ts sources and this script are), but VS Code `require()`s the extension
// entry point. Marking dist/ as CommonJS lets both be true without renaming the bundle to .cjs.
mkdirSync('dist', { recursive: true });
writeFileSync('dist/package.json', JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');

/** The extension host half: Node, CommonJS, and `vscode` is provided by the host. */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

/** The webview half: browser, IIFE, no module loader available inside the webview. */
const webviewConfig = {
  entryPoints: ['src/webview/main.ts', 'src/webview/style.css'],
  outdir: 'dist',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const configs = [extensionConfig, webviewConfig];

if (watch) {
  const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('[weft] watching…');
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
  console.log(`[weft] built${production ? ' (production)' : ''}`);
}
