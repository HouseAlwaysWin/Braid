// Static server for dist/, so the preview harness can be opened in a browser.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../dist/', import.meta.url)));

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
};

createServer(async (req, res) => {
  const requested = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
  const name = requested === '/' ? 'preview.html' : requested.replace(/^\/+/, '');
  const file = resolve(join(root, name));

  // Refuse anything that escapes dist/.
  if (!file.startsWith(root)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(4173, () => console.log('braid preview on http://localhost:4173/'));
