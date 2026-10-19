import crypto from 'node:crypto';
import { pushList, getList, getOrder } from './store.js';
import { appKey } from './modes.js';

// What happened between a buyer NP and the mock: each request it sent (or each seller action), the
// mock's ACK/NACK, every callback and what the buyer NP answered to it. Newest first.
//
// A buyer app is identified by its bap_id or its bap_uri (developers know one or the other), so
// everything is kept under both.
//
// A call is recorded twice under one id: status 'running' when it arrives (callbacks not delivered
// yet) and 'completed' once every callback has been delivered. Readers see the latest of the two.
const keysOf = (app) => [...new Set([appKey(app.bapId ?? app.bap_id), appKey(app.bapUri ?? app.bap_uri)].filter(Boolean))];

export const newActivityId = () => crypto.randomUUID();

export async function recordActivity(app, entry) {
  const keys = keysOf(app);
  if (!keys.length) return;
  const row = { id: entry.id ?? newActivityId(), at: entry.at ?? new Date().toISOString(), ...entry };
  await Promise.all(keys.map((k) => pushList(`activity:${k}`, row, 120)));
  if (entry.kind === 'request' && entry.status !== 'running') {
    await pushList('callers', { bap_id: app.bapId ?? app.bap_id, bap_uri: appKey(app.bapUri ?? app.bap_uri), at: row.at }, 100);
  }
}

// Newest first, one entry per call (its latest status).
export async function listActivity(key) {
  const seen = new Set();
  return (await getList(`activity:${appKey(key)}`, 120)).filter((a) => !seen.has(a.id) && seen.add(a.id));
}

// Buyer apps that called the mock recently, newest first, one entry per bap_id.
export async function listCallers() {
  const seen = new Map();
  for (const c of await getList('callers', 100)) if (c.bap_id && !seen.has(c.bap_id)) seen.set(c.bap_id, c);
  return [...seen.values()].slice(0, 10);
}

// Orders a buyer NP confirmed through the mock, newest first.
export async function rememberOrder(app, orderId) {
  await Promise.all(keysOf(app).map((k) => pushList(`orders:${k}`, orderId, 50)));
}

export async function listOrders(key) {
  const ids = [...new Set(await getList(`orders:${appKey(key)}`))];
  const records = await Promise.all(ids.map((id) => getOrder(id)));
  return records.filter(Boolean).map(({ order, context, history = [] }) => ({
    id: order.id,
    state: order.state,
    fulfillment_state: order.fulfillments?.[0]?.state?.descriptor?.code,
    provider: order.provider?.id,
    provider_name: order.provider?.descriptor?.name,
    retailer: order.billing?.name,
    total: order.quote?.price?.value,
    transaction_id: context.transaction_id,
    created_at: order.created_at,
    updated_at: order.updated_at,
    history,
    order,
  }));
}
