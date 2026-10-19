import { MODES, getMode, setMode } from '../../lib/modes.js';

// Seller mode armed for a buyer NP, so a real buyer app (which cannot send X-Mock-Mode) gets the
// scenario on whatever items it orders. Not part of ONDC.
//   GET  /api/mock/mode?bap_id=...                          -> { bap_id, mode, items, scenario, modes }
//   POST /api/mock/mode { bap_id, mode, items?, scenario? }  -> { bap_id, mode, items, scenario }
// Lasts 24h; set mode "normal" to switch it off.
async function readJson(req) {
  if (req.body !== undefined) return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  try {
    if (req.method === 'GET') {
      const bapId = new URL(req.url, 'http://x').searchParams.get('bap_id');
      if (!bapId) return send(res, 400, { error: 'bap_id is required' });
      const mode = await getMode(bapId);
      return send(res, 200, { bap_id: bapId, mode: mode.name, items: mode.items, scenario: mode.scenario, modes: MODES });
    }
    if (req.method === 'POST') {
      const { bap_id: bapId, mode, items, scenario } = await readJson(req);
      if (!bapId) return send(res, 400, { error: 'bap_id is required' });
      const saved = await setMode(bapId, { mode, items, scenario });
      return send(res, 200, { bap_id: bapId, mode: saved.name, items: saved.items, scenario: saved.scenario });
    }
    return send(res, 405, { error: 'Use GET or POST' });
  } catch (err) {
    return send(res, 400, { error: err.message });
  }
}
