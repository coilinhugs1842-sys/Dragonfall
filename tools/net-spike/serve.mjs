// T-2.1 spike: tiny static server for index.html, bound to every interface so the page can be
// opened as http://<lan-ip>:<port>/ (a plain-HTTP, non-localhost origin).
// Usage: node tools/net-spike/serve.mjs [port=4180]
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? 4180);
const files = {
  '/': [resolve(here, 'index.html'), 'text/html; charset=utf-8'],
  '/peerjs.min.js': [
    resolve(here, '../../node_modules/peerjs/dist/peerjs.min.js'),
    'text/javascript; charset=utf-8',
  ],
};

createServer((req, res) => {
  const entry = files[new URL(req.url ?? '/', 'http://x').pathname];
  if (!entry) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': entry[1], 'cache-control': 'no-store' });
  res.end(readFileSync(entry[0]));
}).listen(port, '0.0.0.0', () => console.log(`net-spike on http://0.0.0.0:${port}/`));
