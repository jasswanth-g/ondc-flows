import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { handle, handlePush } from '../lib/handler.js';
import { deliver } from '../lib/transport.js';
import { authorizationHeader, signingConfig } from '../lib/signing.js';
import { offerLines } from '../lib/offers.js';
import { PROVIDERS } from '../lib/data.js';
import { SCENARIOS, runScenario } from '../public/shared/scenarios.js';
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
const send = async (action, body) => {
  const out = action === 'push' ? await handlePush(body, cfg) : await handle(action, body, cfg);
  return { response: out.response, callbacks: out.callbacks.map((c) => ({ headers: c.headers, body: c.body })) };
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

test('every scenario is covered by at least one step check', () => {
  for (const s of SCENARIOS) assert.ok(s.steps.every((st) => st.check), s.id);
});

test('quotes carry no tax and no delivery charge', async () => {
  const s = SCENARIOS.find((x) => x.id === 'place-order');
  const state = await runScenario(s, { ...env, send });
  const lines = state.onConfirm.message.order.quote.breakup.filter((b) => ['tax', 'delivery'].includes(b['@ondc/org/title_type']));
  assert.ok(lines.length > 0);
  assert.ok(lines.every((b) => b.price.value === '0.00'));
  // 20 x I1 @ 52 + 5 x I6 @ 360, nothing else added.
  assert.equal(state.onConfirm.message.order.quote.price.value, '2840.00');
});

test('broadcast: 3 providers, one per visibility rule, offers published', async () => {
  const { callbacks: [cb] } = await send('search', R.searchBroadcast(env));
  const providers = cb.body.message.catalog['bpp/providers'];
  assert.deepEqual(providers.map((p) => [p.id, p.items.length]), [['P1', 8], ['P2', 7], ['P3', 5]]);
  const variants = (p) => p.tags.filter((t) => t.code === 'retailer_info_required').map((t) => t.list.find((e) => e.code === 'type').value);
  assert.deepEqual(providers.map(variants), [['new', 'existing', 'existing'], ['existing', 'existing'], []]);
  const types = new Set(providers.flatMap((p) => p.offers.map((o) => o.descriptor.code)));
  assert.deepEqual([...types].sort(), ['buyXgetY', 'combo', 'discount', 'freebie', 'slab']);
  assert.equal(providers[0].fulfillments.length, 2);
});

test('offer rules: opt-in needs choosing, non-additive offers are exclusive', () => {
  const p1 = PROVIDERS[0];
  const line = (id, count) => ({ item: p1.items.find((i) => i.id === id), count, unitPrice: Number(p1.items.find((i) => i.id === id).price) });
  const cart = [line('I2', 20), line('I6', 10)];
  const ids = (ls) => ls.map((l) => l['@ondc/org/item_id']);
  assert.deepEqual(ids(offerLines('P1', cart).eligible), ['discp10', 'slab2', 'freebie1']);
  assert.deepEqual(ids(offerLines('P1', cart).applied), ['slab2']);
  assert.deepEqual(ids(offerLines('P1', cart, ['freebie1', 'discp10']).applied), ['discp10', 'freebie1']);
  assert.deepEqual(ids(offerLines('P1', cart, ['slab2', 'freebie1']).applied), ['slab2'], 'two non-additive offers never stack');
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
