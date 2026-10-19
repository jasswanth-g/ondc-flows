import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { handle, handlePush } from '../lib/handler.js';
import { deliver } from '../lib/transport.js';
import { authorizationHeader, signingConfig } from '../lib/signing.js';
import { offerLines } from '../lib/offers.js';
import { PROVIDERS } from '../lib/data.js';
import { SCENARIOS, runScenario, trackLive } from '../public/shared/scenarios.js';
import * as R from '../public/shared/requests.js';

const cfg = {
  baseUrl: 'https://mock.test',
  bppId: 'mock.test',
  bppUri: 'https://mock.test/ondc',
  finderFeeType: 'percent',
  finderFeeAmount: '3.54',
  creationDelayMs: 0,
  pushDelayMs: 0,
  now: () => new Date().toISOString(),
  signing: null,
};
const env = { bap: R.BAP, bpp: { id: cfg.bppId, uri: cfg.bppUri } };
// `mode` plays the role of the X-Mock-Mode / X-Mock-Mode-Items headers.
const send = async (action, body, mode) => {
  const c = { ...cfg, mode: mode ?? null };
  const out = action === 'push' ? await handlePush(body, c) : await handle(action, body, c);
  return { response: out.response, callbacks: out.callbacks.map((cb) => ({ headers: cb.headers, body: cb.body })) };
};

// Every scenario runs end to end; each step's own expectation (step.check) must hold.
for (const s of SCENARIOS) {
  test(`scenario ${s.group} / ${s.title}`, async () => {
    const seen = [];
    await runScenario(s, { ...env, send, onStep: ({ step, request, reply }) => seen.push({ step, request, reply }) });
    for (const { request, reply } of seen) {
      for (const c of reply.callbacks) {
        // Solicited callbacks echo the request ids; seller pushes reuse the order's transaction.
        if (request.context) assert.equal(c.body.context.transaction_id, request.context.transaction_id);
        assert.equal(c.body.context.bpp_id, cfg.bppId);
        assert.equal(c.body.context.ttl, undefined);
      }
    }
  });
}

// Any-items scenarios pick a random cart each run; every draw must still give the expected flow.
test('any-items scenarios hold for random carts', async () => {
  for (const sc of SCENARIOS.filter((x) => x.anyItems)) {
    for (let i = 0; i < 15; i++) {
      const state = await runScenario(sc, { ...env, send });
      assert.ok(state.cart.length > 0, sc.id);
    }
  }
});

test('every scenario is covered by at least one step check', () => {
  for (const s of SCENARIOS) assert.ok(s.steps.every((st) => st.check), s.id);
});

test('quotes carry no tax and no delivery charge', async () => {
  const s = SCENARIOS.find((x) => x.id === 'place-order');
  const state = await runScenario(s, { ...env, send });
  const lines = state.onConfirm.message.order.quote.breakup.filter((b) => ['tax', 'delivery'].includes(b['@ondc/org/title_type']));
  assert.ok(lines.length > 0);
  assert.ok(lines.every((b) => b.price.value === '0.00'));
  // Items only: the sum of the item lines (after any applied offer) is the total.
  const q = state.onConfirm.message.order.quote;
  const itemsAndOffers = q.breakup.filter((b) => ['item', 'offer'].includes(b['@ondc/org/title_type'])).reduce((t, b) => t + Number(b.price.value), 0);
  assert.equal(q.price.value, itemsAndOffers.toFixed(2));
});

test('full catalogue: offers published, no retailer_info_required, pan-India serviceability', async () => {
  const { callbacks: [cb] } = await send('search', R.searchBroadcast(env));
  const providers = cb.body.message.catalog['bpp/providers'];
  assert.deepEqual(providers.map((p) => [p.id, p.items.length]), [['P1', 8], ['P2', 7], ['P3', 5]]);
  const types = new Set(providers.flatMap((p) => p.offers.map((o) => o.descriptor.code)));
  assert.deepEqual([...types].sort(), ['buyXgetY', 'combo', 'discount', 'freebie', 'slab']);
  for (const p of providers) {
    assert.ok(!p.tags.some((t) => t.code === 'retailer_info_required'), `${p.id} publishes retailer_info_required`);
    const svc = p.tags.filter((t) => t.code === 'serviceability');
    assert.equal(svc.length, p.locations.length);
    for (const t of svc) assert.deepEqual(['type', 'val', 'unit'].map((k) => t.list.find((e) => e.code === k).value), ['12', 'IND', 'country']);
  }
});

test('offers: /select applies only auto offers; /init applies exactly the valid buyer selection', () => {
  const p1 = PROVIDERS[0];
  const line = (id, count) => ({ item: p1.items.find((i) => i.id === id), count, unitPrice: Number(p1.items.find((i) => i.id === id).price) });
  const cart = [line('I2', 20), line('I6', 10)];
  const ids = (ls) => ls.map((l) => l['@ondc/org/item_id']);
  assert.deepEqual(ids(offerLines('P1', cart, { stage: 'select' }).eligible), ['discp10', 'slab2', 'freebie1']);
  assert.deepEqual(ids(offerLines('P1', cart, { stage: 'select' }).applied), ['slab2'], 'opt-in discp10 not applied at select');
  assert.deepEqual(ids(offerLines('P1', cart, { stage: 'order', selectedIds: ['freebie1', 'discp10'] }).applied), ['discp10', 'freebie1']);
  assert.deepEqual(ids(offerLines('P1', cart, { stage: 'order', selectedIds: [] }).applied), [], 'nothing selected, nothing applied');
  assert.deepEqual(ids(offerLines('P1', cart, { stage: 'order', selectedIds: ['slab1', 'combo1', 'discp10'] }).applied), ['discp10'], 'ineligible offers dropped');
  assert.deepEqual(ids(offerLines('P1', cart, { stage: 'order', selectedIds: ['slab2', 'freebie1'] }).applied), ['slab2'], 'two non-additive offers never stack');
});

test('/select ignores offers the buyer sends; /init echoes the applied selection', async () => {
  const s = SCENARIOS.find((x) => x.id === 'offer-discount');
  const state = await runScenario(s, { ...env, send });
  const sel = await send('select', R.select({ ...env, catalogProvider: state.catalog[0], retailer: state.retailer, lines: [{ id: 'I1', count: 20 }], offers: ['discp10'] }));
  assert.equal(sel.callbacks[0].body.message.order.quote.price.value, '1040.00', 'opt-in offer not applied at select');
  assert.deepEqual(state.onInit.message.order.offers, [{ id: 'discp10' }]);
  assert.deepEqual(state.onConfirm.message.order.offers, [{ id: 'discp10' }]);
});

// The mode acts on whatever items are in the cart - here other carts and other affected items.
for (const [id, cart, target] of [
  ['out-of-stock', [{ id: 'I9', count: 20 }, { id: 'I12', count: 10 }], 'I12'],
  ['partial-quantity', [{ id: 'I3', count: 6 }, { id: 'I4', count: 8 }], 'I4'],
  ['item-inactive', [{ id: 'I5', count: 4 }, { id: 'I1', count: 20 }], undefined],
  ['price-changed', [{ id: 'I12', count: 10 }], undefined],
  ['init-qty-reduced', [{ id: 'I9', count: 40 }], undefined],
]) {
  test(`mode ${id} acts on the chosen items (${cart.map((l) => l.id).join(', ')}; affected ${target ?? 'first item'})`, async () => {
    await runScenario(SCENARIOS.find((x) => x.id === id), { ...env, send, cart, target });
  });
}

test('without a mode the same carts go through untouched', async () => {
  const state = await runScenario(SCENARIOS.find((x) => x.id === 'place-order'), { ...env, send, cart: [{ id: 'I3', count: 6 }, { id: 'I4', count: 8 }] });
  assert.equal(state.onConfirm.message.order.state, 'Accepted');
});

test('a mode armed for a bap_id applies to requests without the header', async () => {
  const { setMode } = await import('../lib/modes.js');
  const bap = { id: 'armed-bap.test', uri: 'https://armed-bap.test/ondc' };
  await setMode(bap.id, { mode: 'out_of_stock', items: ['I12'] });
  const catalog = (await send('search', R.searchBroadcast({ bap }))).callbacks[0].body.message.catalog['bpp/providers'];
  const reply = await send('select', R.select({ bap, bpp: env.bpp, catalogProvider: catalog[1], retailer: SCENARIOS[1].retailer, lines: [{ id: 'I9', count: 10 }, { id: 'I12', count: 10 }] }));
  const q = reply.callbacks[0].body.message.order.quote.breakup;
  assert.equal(reply.callbacks[0].body.error.code, '40002');
  assert.equal(q.find((b) => b['@ondc/org/item_id'] === 'I12')['@ondc/org/item_quantity'].count, 0);
  assert.equal(q.find((b) => b['@ondc/org/item_id'] === 'I9')['@ondc/org/item_quantity'].count, 10);
  await setMode(bap.id, { mode: 'normal' });
});

test('post-order on an unknown order is NACK 30018', async () => {
  const fake = { context: { transaction_id: 't' }, message: { order: { id: 'NOPE' } } };
  const { response } = await send('status', R.status({ ...env, onConfirm: fake }));
  assert.equal(response.error.code, '30018');
});

test('a cancelled order cannot be cancelled again', async () => {
  const s = SCENARIOS.find((x) => x.id === 'buyer-cancel');
  const state = await runScenario(s, { ...env, send });
  const again = await send('cancel', R.cancel({ ...env, onConfirm: state.onConfirm }));
  assert.equal(again.response.error.code, '50001');
});

test('many-retailer and customer together is NACK 30000', async () => {
  const req = R.searchRetailerMapping({ ...env, retailers: [{ customer_id: 'X' }] });
  req.message.intent.fulfillment = { customer: { id: 'X' } };
  assert.equal((await send('search', req)).response.error.code, '30000');
});

test('async delivery POSTs signed callback with search header to bap_uri', async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c)).on('end', () => {
      received.push({ url: req.url, headers: req.headers, body: data });
      res.end('{"message":{"ack":{"status":"ACK"}}}');
    });
  });
  await new Promise((r) => server.listen(0, r));
  const bapUri = `http://127.0.0.1:${server.address().port}/ondc`;
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const signing = { key: privateKey, subscriberId: 'mock.test', uniqueKeyId: 'k1' };
  const { callbacks } = await handle('search', R.searchBroadcast({ bap: { id: 'b', uri: bapUri } }), cfg);
  const results = await deliver(bapUri, callbacks, { ...cfg, signing });
  server.close();

  assert.equal(results[0].status, 200);
  assert.equal(received[0].url, '/ondc/on_search');
  assert.equal(received[0].headers['x-ondc-search-response'], 'full');
  const auth = received[0].headers.authorization;
  const field = (k) => auth.match(new RegExp(`${k}="([^"]+)"`))[1];
  const digest = crypto.createHash('blake2b512').update(received[0].body).digest('base64');
  const signed = `(created): ${field('created')}\n(expires): ${field('expires')}\ndigest: BLAKE-512=${digest}`;
  assert.ok(crypto.verify(null, Buffer.from(signed), publicKey, Buffer.from(field('signature'), 'base64')));
});

test('signing accepts a raw base64 libsodium key', () => {
  const s = signingConfig({ SIGNING_PRIVATE_KEY: crypto.randomBytes(64).toString('base64'), BPP_ID: 'x', BPP_UNIQUE_KEY_ID: 'k' });
  assert.match(authorizationHeader('{}', s), /^Signature keyId="x\|k\|ed25519"/);
});

// The live tracker reads activity entries; build them from calls a buyer app would make, with an
// unrelated catalogue search first, and the seller mode armed (no header) as for a real app.
test('live tracking matches a buyer app\'s real calls to the scenario steps', async () => {
  const { setMode } = await import('../lib/modes.js');
  const bap = { id: 'live-bap.test', uri: 'https://live-bap.test/ondc' };
  await setMode(bap.id, { mode: 'out_of_stock', items: ['I12'] });
  const entries = [];
  const call = async (action, request) => {
    const out = await handle(action, request, cfg);
    entries.push({ kind: 'request', action, request, response: out.response, callbacks: out.callbacks.map((c) => ({ headers: c.headers, body: c.body })) });
    return out.callbacks.at(-1).body;
  };
  const catalog = (await call('search', R.searchBroadcast({ bap }))).message.catalog['bpp/providers'];
  const retailer = SCENARIOS.find((x) => x.id === 'out-of-stock').retailer;
  const p2 = catalog.find((p) => p.id === 'P2');
  const sel = R.select({ bap, bpp: env.bpp, catalogProvider: p2, retailer, lines: [{ id: 'I9', count: 20 }, { id: 'I12', count: 10 }] });
  const onSelect = await call('select', sel);
  const resel = R.select({ bap, bpp: env.bpp, catalogProvider: p2, retailer, lines: R.linesFromQuote(onSelect.message.order.quote), transactionId: sel.context.transaction_id });
  const onSelect2 = await call('select', resel);
  const onInit = await call('init', R.init({ bap, bpp: env.bpp, selectRequest: resel, onSelect: onSelect2, retailer }));
  await call('confirm', R.confirm({ bap, bpp: env.bpp, onInit, onSelect: onSelect2, retailer }));

  const sc = SCENARIOS.find((x) => x.id === 'out-of-stock');
  const live = trackLive(sc, entries, { catalog, modeItems: ['I12'] });
  assert.deepEqual(live.map((l) => [l.step.name, l.phase, l.problem]), [
    ['search → on_search', 'completed', null], ['select → on_select', 'completed', null], ['re-select → on_select', 'completed', null],
    ['init → on_init', 'completed', null], ['confirm → on_confirm', 'completed', null],
  ]);
  assert.match(live[1].expect, /I12 at qty 0/);

  // An app with a cached catalogue goes straight to /select: the search is skipped, not awaited.
  const noSearch = trackLive(sc, entries.slice(1), { catalog, modeItems: ['I12'] });
  assert.equal(noSearch[0].phase, 'skipped');
  assert.equal(noSearch[1].phase, 'completed');
  // A call still delivering its callback is running; the steps after it are waiting.
  const inFlight = trackLive(sc, [entries[0], { ...entries[1], status: 'running' }], { catalog, modeItems: ['I12'] });
  assert.deepEqual(inFlight.map((l) => l.phase), ['completed', 'running', 'waiting', 'waiting', 'waiting']);
  await setMode(bap.id, { mode: 'normal' });
});
