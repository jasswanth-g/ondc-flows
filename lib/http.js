import { waitUntil } from '@vercel/functions';
import { nack } from './handler.js';
import { config, deliver, syncView } from './transport.js';

async function readBody(req) {
  if (req.body !== undefined) return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

// Runs `run(body, cfg) -> { response, callbacks, scenario, bapUri? }` and answers in one of three modes:
//   default : ACK now, then POST each callback to bap_uri/<on_action> (the real ONDC async contract)
//   sync    : "X-Mock-Sync: true" or ?sync=1 -> ACK plus every callback inline, nothing is POSTed
//   play    : "X-Mock-Deliver: wait" -> POST the callbacks now, wait, and return each with the buyer app's reply
export async function serve(req, res, run) {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method !== 'POST') return send(res, 405, nack('10000', 'Use POST', 'CONTEXT-ERROR'));

  let body;
  try {
    body = await readBody(req);
  } catch {
    return send(res, 400, nack('10000', 'Body is not valid JSON', 'JSON-SCHEMA-ERROR'));
  }

  const cfg = config(req);
  const { response, callbacks, scenario, bapUri = body.context?.bap_uri ?? '' } = await run(body, cfg);
  const headers = scenario ? { 'X-Mock-Scenario': scenario } : {};
  const url = new URL(req.url, 'http://x');
  const header = (name) => String(req.headers[name] ?? '').toLowerCase();

  if (header('x-mock-sync') === 'true' || url.searchParams.get('sync') === '1') {
    return send(res, 200, { response, callbacks: syncView(bapUri, callbacks) }, headers);
  }
  if (header('x-mock-deliver') === 'wait') {
    const view = syncView(bapUri, callbacks);
    const deliveries = callbacks.length ? await deliver(bapUri, callbacks, cfg) : [];
    view.forEach((v, i) => (v.delivery = deliveries[i]));
    return send(res, 200, { response, callbacks: view }, headers);
  }
  send(res, 200, response, headers);
  if (callbacks.length) waitUntil(deliver(bapUri, callbacks, cfg));
}
