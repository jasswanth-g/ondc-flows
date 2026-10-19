import crypto from 'node:crypto';
import { pushList, getList, getOrder } from './store.js';

// What happened between a buyer NP and the mock: each request it sent (or each seller action), the
// mock's ACK/NACK, every callback and what the buyer NP answered to it. Kept per bap_id, newest first.

export async function recordActivity(bapId, entry) {
  if (!bapId) return;
  await pushList(`activity:${bapId}`, { id: crypto.randomUUID(), at: new Date().toISOString(), ...entry });
}

export const listActivity = (bapId) => getList(`activity:${bapId}`);

// Orders a buyer NP confirmed through the mock, newest first.
export async function rememberOrder(bapId, orderId) {
  if (bapId) await pushList(`orders:${bapId}`, orderId, 50);
}

export async function listOrders(bapId) {
  const ids = [...new Set(await getList(`orders:${bapId}`))];
  const records = await Promise.all(ids.map((id) => getOrder(id)));
  return records.filter(Boolean).map(({ order, context }) => ({
    id: order.id,
    state: order.state,
    fulfillment_state: order.fulfillments?.[0]?.state?.descriptor?.code,
    provider: order.provider?.id,
    total: order.quote?.price?.value,
    transaction_id: context.transaction_id,
    updated_at: order.updated_at,
  }));
}
