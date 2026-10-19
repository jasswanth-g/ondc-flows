// Local server that mirrors vercel.json routing, so the mock runs without the Vercel CLI.
// Also exposes a throwaway buyer-side inbox at /local-bap/* for trying the async callbacks:
//   set context.bap_uri to http://localhost:3000/local-bap and read GET /local-bap/inbox.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ondc from '../api/ondc/[action].js';
import img from '../api/img.js';
import push from '../api/mock/push.js';
import mode from '../api/mock/mode.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const port = Number(process.env.PORT ?? 3000);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const inbox = [];

async function serveStatic(req, res, pathname) {
  const file = path.join(root, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(root)) return void res.writeHead(403).end();
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
}

async function localBap(req, res, pathname) {
  if (req.method === 'GET') return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(inbox, null, 2));
  const chunks = [];
  for await (const c of req) chunks.push(c);
  inbox.push({ received_at: new Date().toISOString(), path: pathname, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') });
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: { ack: { status: 'ACK' } } }));
}

http
  .createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Mock-Sync, X-Mock-Deliver, X-Mock-Mode, X-Mock-Mode-Items');
    res.setHeader('Access-Control-Expose-Headers', 'X-ONDC-Search-Response');
    try {
      if (/^\/(api\/)?ondc\/[a-z_]+$/.test(pathname)) return await ondc(req, res);
      if (pathname === '/api/mock/push') return await push(req, res);
      if (pathname === '/api/mock/mode') return await mode(req, res);
      const m = pathname.match(/^\/img\/(.+)$/);
      if (m) {
        req.url = `/api/img?name=${m[1]}`;
        return img(req, res);
      }
      if (pathname.startsWith('/local-bap')) return await localBap(req, res, pathname);
      return await serveStatic(req, res, decodeURIComponent(pathname));
    } catch (err) {
      console.error(err);
      res.writeHead(500).end(String(err));
    }
  })
  .listen(port, () => console.log(`Mock Seller NP on http://localhost:${port}  (bpp_uri http://localhost:${port}/ondc)`));
