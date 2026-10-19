// Seller modes: what the seller does to the items the buyer actually ordered. A mode comes from the
// request header X-Mock-Mode (the playground), else from the mode armed for the buyer NP's bap_id
// (POST /api/mock/mode, for a real buyer app that cannot send headers).
//
// The affected items are the ones named for the mode (X-Mock-Mode-Items / items) that are in the
// cart, else the first item of the cart. A mode acts once per transaction and is remembered for it,
// so the re-select / re-init that follows sees the same seller state instead of a fresh reduction.

import { get, put } from './store.js';

export const MODES = {
  normal: 'Everything in stock at catalogue prices.',
  item_inactive: 'At /select the seller disables the affected item: an unsolicited incremental on_search (label disable) and on_select with qty 0 + 40002.',
  out_of_stock: 'At /select the affected item has no stock: qty 0 + 40002.',
  partial_quantity: 'At /select the affected item has half the ordered qty: reduced qty + 40002.',
  price_changed: 'At /select the affected item costs 5% more than the catalogue.',
  init_qty_reduced: 'At /init the affected item drops to half the ordered qty (no error): the buyer must re-select.',
  confirm_rejected: 'At /confirm the seller cannot confirm: on_confirm error 30019.',
  min_order_value: 'At /select the seller enforces its published order_value.min_value: a cart below it gets error 30023 with the quote.',
};

const parseItems = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((s) => s.trim()).filter(Boolean);

export function modeFromHeaders(headers) {
  const name = String(headers['x-mock-mode'] ?? '').trim();
  return name ? { name, items: parseItems(headers['x-mock-mode-items']) } : null;
}

// `scenario` is only a label (which playground scenario armed the mode), echoed back by getMode.
export async function setMode(bapId, { mode, items, scenario }) {
  if (!MODES[mode]) throw new Error(`mode must be one of ${Object.keys(MODES).join(', ')}`);
  const value = { name: mode, items: parseItems(items), ...(scenario ? { scenario: String(scenario) } : {}), at: new Date().toISOString() };
  await put(`mode:${appKey(bapId)}`, value, 24 * 3600);
  return value;
}

// A buyer app is identified by its bap_id or its bap_uri (the developer may know either).
export const appKey = (value) => String(value ?? '').trim().replace(/\/+$/, '');

export const getMode = async (app) => (await get(`mode:${appKey(app)}`)) ?? { name: 'normal', items: [] };

// The mode for a request: the X-Mock-Mode header, else the mode armed for its bap_id, else for its bap_uri.
// An armed mode carries `at` (when the flow was started) - the seller's state is kept per flow run.
export async function resolveMode(cfg, ctx) {
  const mode = cfg.mode ?? (await get(`mode:${appKey(ctx.bap_id)}`)) ?? (await get(`mode:${appKey(ctx.bap_uri)}`)) ?? { name: 'normal', items: [] };
  return MODES[mode.name] ? mode : { name: 'normal', items: [] };
}

// The seller's state for one flow run: { items: { [id]: { available?, price?, inactive? } }, applied: [stages], reject? }.
// A run is a mode armed for the app (from ▶ until Restart / Stop), so a re-select or re-init keeps
// seeing the same seller even with a new transaction_id / message_id. A mode sent per request (the
// X-Mock-Mode header) has no run; its state is kept per transaction instead.
export const runKey = (mode, ctx) => (mode.at ? `run:${appKey(ctx.bap_id || ctx.bap_uri)}:${mode.at}` : `txn:${ctx.transaction_id}`);
const effectsKey = (key) => `effects:${key}`;
export const getEffects = async (key) => (await get(effectsKey(key))) ?? { items: {}, applied: [] };
export const saveEffects = (key, effects) => put(effectsKey(key), effects, 24 * 3600);

const targets = (mode, reqItems) => {
  const ids = reqItems.map((i) => i.id);
  const named = mode.items.filter((id) => ids.includes(id));
  return named.length ? named : ids.slice(0, 1);
};
const half = (n) => Math.max(1, Math.floor(n / 2));

// Applies the mode for this stage once per transaction and returns the transaction's effects.
// `catalogPrice(id)` gives an item's catalogue price.
export function applyMode(mode, stage, effects, reqItems, catalogPrice) {
  const key = `${mode.name}:${stage}`;
  if (effects.applied.includes(key)) return effects;
  const qty = (id) => Number(reqItems.find((i) => i.id === id)?.quantity?.count ?? 1);
  const set = (id, patch) => (effects.items[id] = { ...effects.items[id], ...patch });

  if (stage === 'select') {
    for (const id of targets(mode, reqItems)) {
      if (mode.name === 'item_inactive') set(id, { available: 0, inactive: true });
      if (mode.name === 'out_of_stock') set(id, { available: 0 });
      if (mode.name === 'partial_quantity') set(id, { available: half(qty(id)) });
      if (mode.name === 'price_changed') set(id, { price: (Math.round(catalogPrice(id) * 105) / 100).toFixed(2) });
    }
  }
  if (stage === 'init' && mode.name === 'init_qty_reduced') for (const id of targets(mode, reqItems)) set(id, { available: half(qty(id)) });
  if (stage === 'confirm' && mode.name === 'confirm_rejected') effects.reject = true;

  const acts = { select: ['item_inactive', 'out_of_stock', 'partial_quantity', 'price_changed'], init: ['init_qty_reduced'], confirm: ['confirm_rejected'] };
  if (acts[stage]?.includes(mode.name)) effects.applied.push(key);
  return effects;
}
