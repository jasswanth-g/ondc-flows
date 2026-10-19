import { waitUntil } from '@vercel/functions';
import { nack } from './handler.js';
import { config, deliver, syncView } from './transport.js';
import { recordActivity, newActivityId } from './activity.js';

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

// Runs `run(body, cfg) -> { response, callbacks, scenario, bapUri?, bapId? }` and answers in one of three modes:
//   default : ACK now, then POST each callback to bap_uri/<on_action> (the real ONDC async contract)
//   sync    : "X-Mock-Sync: true" or ?sync=1 -> ACK plus every callback inline, nothing is POSTed
//   wait    : "X-Mock-Deliver: wait" -> POST the callbacks now, wait, and return each with the buyer app's reply
//             (used for seller actions, which the seller starts itself)
// Default and wait traffic is recorded in the bap_id's activity log; sync (simulation) is not.
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
  const { response, callbacks, scenario, bapUri = body.context?.bap_uri ?? '', bapId = body.context?.bap_id } = await run(body, cfg);
  const action = body.context?.action ?? scenario;
  const call = { id: newActivityId(), at: new Date().toISOString() };
  const log = (status, deliveries = []) => recordActivity({ bap_id: bapId, bap_uri: bapUri }, {
    ...call,
    status,
    kind: body.context ? 'request' : 'seller_action',
    action,
    transaction_id: body.context?.transaction_id ?? callbacks[0]?.body.context.transaction_id,
    scenario,
    request: body,
    response,
    callbacks: syncView(bapUri, callbacks).map((c, i) => ({ ...c, delivery: deliveries[i] })),
    ...(status === 'completed' ? { completed_at: new Date().toISOString() } : {}),
  }).catch((err) => console.error('[activity] record failed:', err.message));
  // Delivered callbacks first mark the call running, then completed.
  const deliverAndLog = async () => {
    if (callbacks.length) await log('running');
    const deliveries = callbacks.length ? await deliver(bapUri, callbacks, cfg) : [];
    await log('completed', deliveries);
    return deliveries;
  };
  const headers = scenario ? { 'X-Mock-Scenario': scenario } : {};
  const url = new URL(req.url, 'http://x');
  const header = (name) => String(req.headers[name] ?? '').toLowerCase();

  if (header('x-mock-sync') === 'true' || url.searchParams.get('sync') === '1') {
    return send(res, 200, { response, callbacks: syncView(bapUri, callbacks) }, headers);
  }
  if (header('x-mock-deliver') === 'wait') {
    const view = syncView(bapUri, callbacks);
    const deliveries = await deliverAndLog();
    view.forEach((v, i) => (v.delivery = deliveries[i]));
    return send(res, 200, { response, callbacks: view }, headers);
  }
  send(res, 200, response, headers);
  waitUntil(deliverAndLog());
}
