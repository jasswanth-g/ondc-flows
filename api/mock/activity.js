import { listActivity, listOrders } from '../../lib/activity.js';

// GET /api/mock/activity?bap_id=...  -> { activity, orders }
// Every request the buyer NP sent, the mock's reply, each callback and the buyer NP's answer to it,
// plus the orders it confirmed (for seller actions). Newest first. Not part of ONDC.
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const bapId = new URL(req.url, 'http://x').searchParams.get('bap_id');
  if (!bapId) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'bap_id is required' }));
  }
  const [activity, orders] = await Promise.all([listActivity(bapId), listOrders(bapId)]);
  res.end(JSON.stringify({ bap_id: bapId, activity, orders }));
}
