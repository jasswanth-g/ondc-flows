import * as R from './requests.js';
import { RETAILERS, NEW_RETAILER, WALK_IN_RETAILER } from './retailers.js';

const [SHARMA, LAKSHMI] = RETAILERS;
// Lakshmi ordering for a shop outside P2's pincode range (Devanahalli).
const LAKSHMI_OUT_OF_AREA = {
  ...LAKSHMI,
  address: { ...LAKSHMI.address, locality: 'Devanahalli', area_code: '562110' },
  gps: '13.2437,77.7172',
};

// ---- reading replies ------------------------------------------------------------------------
const cbBody = (reply, i = 0) => reply.callbacks[i]?.body;
const order = (reply) => cbBody(reply)?.message?.order;
const errorCode = (reply) => cbBody(reply)?.error?.code;
const breakup = (reply) => order(reply)?.quote?.breakup ?? [];
const itemCount = (reply, id) => breakup(reply).find((b) => b['@ondc/org/title_type'] === 'item' && b['@ondc/org/item_id'] === id)?.['@ondc/org/item_quantity'].count;
const offerLine = (reply, id) => breakup(reply).find((b) => b['@ondc/org/title_type'] === 'offer' && b['@ondc/org/item_id'] === id);
const tagVal = (tags, code, key) => tags?.find((t) => t.code === code)?.list.find((e) => e.code === key)?.value;
const fail = (cond, msg) => (cond ? null : msg);
const all = (...checks) => checks.find(Boolean) ?? null;
const noError = (reply) => fail(!cbBody(reply)?.error, `unexpected error ${JSON.stringify(cbBody(reply)?.error)}`);
// Sum of item, tax and delivery lines plus the applied offers must equal quote.price.
const appliedOffers = (reply) => (order(reply)?.offers ?? []).map((o) => o.id);
// on_select lists every eligible offer, so it is checked separately; init/confirm list only applied ones.
const quoteAddsUp = (reply) => {
  const q = order(reply)?.quote;
  if (!q) return 'no quote';
  const sum = q.breakup.reduce((s, b) => s + Number(b.price.value), 0).toFixed(2);
  return fail(sum === q.price.value, `breakup sums to ${sum}, quote.price is ${q.price.value}`);
};

// ---- steps ----------------------------------------------------------------------------------
// A step: { name, action, expect, build(env, state), absorb(state, reply), check(reply, state) }.
// `action` is the ONDC endpoint, or 'push' for the mock seller acting on its own.

const searchStep = () => ({
  name: 'search → on_search', action: 'search',
  expect: 'Full catalogue (header full): 3 providers with locations, items, variant groups, offers, serviceability and retailer_info_required.',
  build: ({ bap }) => R.searchBroadcast({ bap }),
  absorb: (s, reply) => (s.catalog = cbBody(reply).message.catalog['bpp/providers']),
  check: (reply) => fail(reply.callbacks[0]?.headers?.['X-ONDC-Search-Response'] === 'full' && cbBody(reply).message.catalog['bpp/providers'].length === 3, 'expected a full catalogue with 3 providers'),
});

const incrementalStep = () => ({
  name: 'search (incremental) → on_search', action: 'search',
  expect: 'Header inc. I8 Yippee arrives with time.label "disable": the buyer must mark it inactive in its catalogue.',
  build: ({ bap }) => R.searchIncrementalPull({ bap }),
  check: (reply) => {
    const p1 = cbBody(reply).message.catalog['bpp/providers'].find((p) => p.id === 'P1');
    return fail(p1?.items.find((i) => i.id === 'I8')?.time.label === 'disable', 'expected I8 disabled');
  },
});

const p2pStep = (name, build, expect, check) => ({
  name, action: 'search', expect, build,
  absorb: (s, reply) => {
    // The last callback carries the customer id (for a new retailer, the unsolicited "created" one).
    const p = cbBody(reply, reply.callbacks.length - 1).message.catalog['bpp/providers'].find((x) => x.id === s.providerId);
    const id = tagVal(p?.tags, 'customer', 'id');
    if (id) s.retailer.customer_id = id;
  },
  check: check ?? ((reply, s) => fail(s.retailer.customer_id, 'P2P search returned no customer id')),
});

// /select. `lines` is a list or a function of state (a re-select built from the seller's reply).
const selectStep = ({ name = 'select → on_select', lines, offers, expect, check, reselect = false }) => ({
  name: reselect ? name.replace(/^select/, 're-select') : name, action: 'select', expect, needsCatalog: true,
  build: (env, s) => {
    const provider = s.catalog.find((p) => p.id === s.providerId);
    const req = R.select({
      ...env, catalogProvider: provider, retailer: s.retailer,
      lines: typeof lines === 'function' ? lines(s) : lines,
      offers: typeof offers === 'function' ? offers(s) : offers,
      ...(reselect ? { transactionId: s.selectRequest.context.transaction_id } : {}),
    });
    s.selectRequest = req;
    return req;
  },
  absorb: (s, reply) => (s.onSelect = cbBody(reply)),
  check: check ?? noError,
});

const initStep = ({ name = 'init → on_init', fulfillmentId, paymentType, expect = 'Quote, payment and settlement terms, bpp_terms and (for a known retailer) credit.', check } = {}) => ({
  name, action: 'init', expect,
  build: (env, s) => R.init({ ...env, selectRequest: s.selectRequest, onSelect: s.onSelect, retailer: s.retailer, paymentType, fulfillmentId }),
  absorb: (s, reply) => (s.onInit = cbBody(reply)),
  check: check ?? ((reply) => all(noError(reply), quoteAddsUp(reply))),
});

const confirmStep = ({ expect = 'Order Accepted, fulfillment Pending, same quote as on_init.', check } = {}) => ({
  name: 'confirm → on_confirm', action: 'confirm', expect,
  build: (env, s) => R.confirm({ ...env, onInit: s.onInit, onSelect: s.onSelect, retailer: s.retailer }),
  absorb: (s, reply) => (s.onConfirm = cbBody(reply)),
  check: check ?? ((reply, s) => all(noError(reply), quoteAddsUp(reply), fail(order(reply).state === 'Accepted', `state ${order(reply).state}`),
    fail(order(reply).quote.price.value === s.onInit.message.order.quote.price.value, 'quote changed between on_init and on_confirm'))),
});

const statusStep = () => ({
  name: 'status → on_status', action: 'status',
  expect: 'The confirmed order as the seller holds it: state Accepted, fulfillment Pending.',
  build: (env, s) => R.status({ ...env, onConfirm: s.onConfirm }),
  check: (reply) => fail(order(reply)?.state === 'Accepted', `state ${order(reply)?.state}`),
});

const pushStep = (event, name, expect, [orderState, fulfillmentState]) => ({
  name, action: 'push', expect,
  build: (env, s) => R.sellerPush({ onConfirm: s.onConfirm, event }),
  check: (reply) => fail(order(reply)?.state === orderState && order(reply)?.fulfillments[0].state.descriptor.code === fulfillmentState,
    `expected ${orderState} / ${fulfillmentState}, got ${order(reply)?.state} / ${order(reply)?.fulfillments?.[0]?.state?.descriptor?.code}`),
});

const cancelStep = () => ({
  name: 'cancel → on_cancel', action: 'cancel',
  expect: 'Order Cancelled, cancellation.reason.id 053 (buyer) - pre-order-service records it as cancelled by the CUSTOMER.',
  build: (env, s) => R.cancel({ ...env, onConfirm: s.onConfirm }),
  check: (reply) => fail(order(reply)?.state === 'Cancelled' && order(reply)?.cancellation?.reason?.id === '053', 'expected Cancelled with reason 053'),
});

const placeOrder = (lines) => [selectStep({ lines, expect: 'Serviceable quote.' }), initStep(), confirmStep()];

// ---- scenarios ------------------------------------------------------------------------------
// { id, group, title, summary, providerId, retailer, steps }

export const SCENARIOS = [
  // Pre-order
  {
    id: 'search', group: 'Pre-order', title: 'Search', providerId: 'P1', retailer: SHARMA,
    summary: 'Broadcast /search and the full catalogue on_search.',
    steps: [searchStep()],
  },
  {
    id: 'place-order', group: 'Pre-order', title: 'Place order (positive)', providerId: 'P1', retailer: SHARMA,
    summary: `Sharma Kirana (${SHARMA.customer_id}) orders from P1: select → init (pay on fulfillment, credit) → confirm.`,
    steps: [
      selectStep({ lines: [{ id: 'I1', count: 20 }, { id: 'I6', count: 5 }], expect: 'Serviceable. Two delivery options: F1 Standard Delivery (beat, P2D) and F2 Immediate Delivery (tomorrow, P1D).',
        check: (r) => all(noError(r), fail(order(r).fulfillments.length === 2, 'expected 2 delivery options')) }),
      initStep(),
      confirmStep(),
    ],
  },
  {
    id: 'delivery-tomorrow', group: 'Pre-order', title: 'Place order - tomorrow delivery', providerId: 'P1', retailer: SHARMA,
    summary: 'The buyer picks F2 (Immediate Delivery) from on_select instead of the beat day.',
    steps: [
      selectStep({ lines: [{ id: 'I1', count: 20 }], expect: 'F1 Standard Delivery and F2 Immediate Delivery offered.' }),
      initStep({ fulfillmentId: 'F2', expect: 'Fulfillment F2 (Immediate Delivery), TAT P1D.',
        check: (r) => all(noError(r), fail(order(r).fulfillments[0].id === 'F2' && order(r).fulfillments[0]['@ondc/org/TAT'] === 'P1D', 'expected F2 / P1D')) }),
      confirmStep(),
    ],
  },
  {
    id: 'place-order-p2', group: 'Pre-order', title: 'Place order - registered-only distributor (P2)', providerId: 'P2', retailer: LAKSHMI,
    summary: `Lakshmi Stores (${LAKSHMI.customer_id}) orders from P2, which serves identified retailers only.`,
    steps: placeOrder([{ id: 'I9', count: 10 }, { id: 'I12', count: 10 }]),
  },
  {
    id: 'place-order-prepaid', group: 'Pre-order', title: 'Place order - walk-in, prepaid (P3)', providerId: 'P3', retailer: WALK_IN_RETAILER,
    summary: 'P3 publishes no retailer_info_required: no P2P, no customer_id. Payment ON-ORDER.',
    steps: [
      selectStep({ lines: [{ id: 'I18', count: 5 }, { id: 'I20', count: 10 }], expect: 'Serviceable (inside P3\'s polygon).' }),
      initStep({ paymentType: 'ON-ORDER', expect: 'payments[0].type ON-ORDER with the seller\'s payment link (uri); no credit tag.',
        check: (r) => all(noError(r), fail(order(r).payments[0].uri, 'expected a payment uri')) }),
      confirmStep(),
    ],
  },
  {
    id: 'item-inactive', group: 'Pre-order', title: 'Item inactive', providerId: 'P1', retailer: SHARMA,
    summary: 'The seller disables I8 Yippee after the full catalogue. A cart that still holds it gets it back with qty 0; the buyer drops it and re-selects.',
    steps: [
      incrementalStep(),
      selectStep({ lines: [{ id: 'I1', count: 20 }, { id: 'I8', count: 2 }], expect: 'Error 40002, message [{"item_id":"I8","error":"40002"}]; I8 quantity 0 in the quote.',
        check: (r) => fail(errorCode(r) === '40002' && itemCount(r, 'I8') === 0, 'expected 40002 with I8 at 0') }),
      selectStep({ reselect: true, lines: (s) => R.linesFromQuote(s.onSelect.message.order.quote), expect: 'Without I8: no error.' }),
      initStep(),
      confirmStep(),
    ],
  },
  {
    id: 'out-of-stock', group: 'Pre-order', title: 'Item out of stock', providerId: 'P2', retailer: LAKSHMI,
    summary: 'I13 Bru shows available in the catalogue, but the seller has none left.',
    steps: [
      selectStep({ lines: [{ id: 'I12', count: 10 }, { id: 'I13', count: 10 }], expect: 'Error 40002 for I13, quantity 0.',
        check: (r) => fail(errorCode(r) === '40002' && itemCount(r, 'I13') === 0, 'expected 40002 with I13 at 0') }),
      selectStep({ reselect: true, lines: (s) => R.linesFromQuote(s.onSelect.message.order.quote), expect: 'Without I13: no error.' }),
      initStep(),
      confirmStep(),
    ],
  },
  {
    id: 'partial-quantity', group: 'Pre-order', title: 'Partial quantity available', providerId: 'P1', retailer: SHARMA,
    summary: 'Only 8 of the 20 packs of I7 Bingo are in stock.',
    steps: [
      selectStep({ lines: [{ id: 'I1', count: 20 }, { id: 'I7', count: 20 }], expect: 'Error 40002 for I7; quote carries the 8 the seller can supply.',
        check: (r) => fail(errorCode(r) === '40002' && itemCount(r, 'I7') === 8, 'expected 40002 with I7 at 8') }),
      selectStep({ reselect: true, lines: (s) => R.linesFromQuote(s.onSelect.message.order.quote), expect: 'I7 at 8: no error.' }),
      initStep(),
      confirmStep(),
    ],
  },
  {
    id: 'price-changed', group: 'Pre-order', title: 'Price changed', providerId: 'P2', retailer: LAKSHMI,
    summary: 'I14 Kissan is ₹135.00 in the catalogue, but the seller now charges ₹139.00.',
    steps: [
      selectStep({ lines: [{ id: 'I12', count: 10 }, { id: 'I14', count: 12 }], expect: 'No error; I14 item.price 139.00 (line 1668.00). The buyer must show the new price.',
        check: (r) => all(noError(r), fail(breakup(r).find((b) => b['@ondc/org/item_id'] === 'I14').item.price.value === '139.00', 'expected 139.00')) }),
      initStep(),
      confirmStep(),
    ],
  },
  {
    id: 'min-order-value', group: 'Pre-order', title: 'Minimum order value not met', providerId: 'P2', retailer: LAKSHMI,
    summary: 'P2 publishes order_value.min_value 2000.00. A ₹1300 cart is rejected; the buyer adds items and re-selects.',
    steps: [
      selectStep({ lines: [{ id: 'I9', count: 10 }], expect: 'Error 30023 with the quote still present (pre-order-service shows MOV_NOT_MET).',
        check: (r) => fail(errorCode(r) === '30023' && order(r)?.quote, 'expected 30023 with a quote') }),
      selectStep({ reselect: true, lines: [{ id: 'I9', count: 10 }, { id: 'I12', count: 10 }], expect: 'Cart ₹3900: no error.' }),
      initStep(),
      confirmStep(),
    ],
  },
  {
    id: 'not-serviceable', group: 'Pre-order', title: 'Location not serviceable', providerId: 'P2', retailer: LAKSHMI_OUT_OF_AREA,
    summary: 'Delivery to PIN 562110, outside P2\'s published range 560001-560100.',
    steps: [
      selectStep({ lines: [{ id: 'I9', count: 10 }, { id: 'I12', count: 10 }], expect: 'Fulfillment state Non-serviceable, error 30009, no delivery charge in the quote.',
        check: (r) => fail(errorCode(r) === '30009' && order(r).fulfillments[0].state.descriptor.code === 'Non-serviceable', 'expected Non-serviceable / 30009') }),
    ],
  },
  {
    id: 'init-qty-reduced', group: 'Pre-order', title: 'Quantity reduced at init', providerId: 'P2', retailer: LAKSHMI,
    summary: 'Stock of I15 Knorr drops to 2 between select and init. on_init returns the lower quantity; the buyer must select again.',
    steps: [
      selectStep({ lines: [{ id: 'I12', count: 10 }, { id: 'I15', count: 10 }], expect: 'All 10 of I15 available.' }),
      initStep({ expect: 'No error, but I15 comes back at 2 (pre-order-service: CART_UPDATED → re-select).',
        check: (r) => all(noError(r), fail(itemCount(r, 'I15') === 2, 'expected I15 at 2')) }),
      selectStep({ reselect: true, lines: (s) => R.linesFromQuote(s.onInit.message.order.quote), expect: 'I15 at 2: no error.' }),
      initStep({ name: 're-init → on_init' }),
      confirmStep(),
    ],
  },
  {
    id: 'confirm-rejected', group: 'Pre-order', title: 'Seller rejects confirm', providerId: 'P2', retailer: LAKSHMI,
    summary: 'I11 Vim is reserved for another order by the time of confirm.',
    steps: [
      ...placeOrder([{ id: 'I11', count: 20 }, { id: 'I12', count: 10 }]).slice(0, 2),
      confirmStep({ expect: 'on_confirm with error 30019 (pre-order-service marks the order Cancelled).', check: (r) => fail(errorCode(r) === '30019', 'expected 30019') }),
    ],
  },

  // Offers
  {
    id: 'offer-discount', group: 'Offers', title: 'Discount - opt-in (percent)', providerId: 'P1', retailer: SHARMA,
    summary: 'discp10: 10% off Atta (max ₹200), min ₹500, auto = no. Listed in on_select; applies only when the buyer chooses it.',
    steps: [
      selectStep({ lines: [{ id: 'I1', count: 20 }], expect: 'discp10 listed at -104.00 but not applied (total excludes it).',
        check: (r) => all(noError(r), fail(offerLine(r, 'discp10')?.price.value === '-104.00', 'expected discp10 -104.00')) }),
      selectStep({ reselect: true, lines: [{ id: 'I1', count: 20 }], offers: ['discp10'], expect: 'Buyer sends offers [discp10]: applied.' }),
      initStep({ check: (r) => all(noError(r), quoteAddsUp(r), fail(appliedOffers(r).includes('discp10'), 'discp10 not applied')) }),
      confirmStep(),
    ],
  },
  {
    id: 'offer-flat', group: 'Offers', title: 'Discount - flat amount', providerId: 'P2', retailer: LAKSHMI,
    summary: 'flat150: ₹150 off Tea & Coffee above ₹1000, auto + additive - applied without asking.',
    steps: [
      selectStep({ lines: [{ id: 'I9', count: 10 }, { id: 'I12', count: 10 }], expect: 'flat150 at -150.00.', check: (r) => all(noError(r), fail(offerLine(r, 'flat150')?.price.value === '-150.00', 'expected flat150')) }),
      initStep({ check: (r) => all(noError(r), quoteAddsUp(r), fail(appliedOffers(r).includes('flat150'), 'flat150 not applied')) }),
      confirmStep(),
    ],
  },
  {
    id: 'offer-slab-count', group: 'Offers', title: 'Slab - by quantity', providerId: 'P1', retailer: SHARMA,
    summary: 'Atta 5kg: slab1 5% for 10-19 units, slab2 10% for 20+ units.',
    steps: [
      selectStep({ lines: [{ id: 'I2', count: 10 }], expect: 'slab1 at -122.50.', check: (r) => fail(offerLine(r, 'slab1')?.price.value === '-122.50', 'expected slab1 -122.50') }),
      selectStep({ reselect: true, lines: [{ id: 'I2', count: 20 }], expect: '20 units: slab2 at -490.00 replaces slab1.', check: (r) => fail(offerLine(r, 'slab2')?.price.value === '-490.00' && !offerLine(r, 'slab1'), 'expected slab2 only') }),
      initStep({ check: (r) => all(quoteAddsUp(r), fail(appliedOffers(r).includes('slab2'), 'slab2 not applied')) }),
      confirmStep(),
    ],
  },
  {
    id: 'offer-slab-weight', group: 'Offers', title: 'Slab - by weight', providerId: 'P2', retailer: LAKSHMI,
    summary: 'Surf Excel: slabw1 4% for 20-49 kg, slabw2 8% for 50+ kg (weight = pack size x quantity).',
    steps: [
      selectStep({ lines: [{ id: 'I10', count: 5 }], expect: '20 kg: slabw1 at -99.00.', check: (r) => fail(offerLine(r, 'slabw1')?.price.value === '-99.00', 'expected slabw1 -99.00') }),
      selectStep({ reselect: true, lines: [{ id: 'I10', count: 13 }], expect: '52 kg: slabw2 at -514.80.', check: (r) => fail(offerLine(r, 'slabw2')?.price.value === '-514.80', 'expected slabw2 -514.80') }),
      initStep({ check: (r) => all(quoteAddsUp(r), fail(appliedOffers(r).includes('slabw2'), 'slabw2 not applied')) }),
      confirmStep(),
    ],
  },
  {
    id: 'offer-slab-value', group: 'Offers', title: 'Slab - by value', providerId: 'P3', retailer: WALK_IN_RETAILER,
    summary: 'slabv1: 3% off Appy Fizz worth ₹5000+ (max ₹1000), additive.',
    steps: [
      selectStep({ lines: [{ id: 'I19', count: 6 }], expect: '₹5040 of Appy Fizz: slabv1 at -151.20.', check: (r) => fail(offerLine(r, 'slabv1')?.price.value === '-151.20', 'expected slabv1 -151.20') }),
      initStep({ check: (r) => all(quoteAddsUp(r), fail(appliedOffers(r).includes('slabv1'), 'slabv1 not applied')) }),
      confirmStep(),
    ],
  },
  {
    id: 'offer-freebie', group: 'Offers', title: 'Freebie', providerId: 'P1', retailer: SHARMA,
    summary: 'freebie1: buy 10 Dark Fantasy, get 1 Bingo Mad Angles free.',
    steps: [
      selectStep({ lines: [{ id: 'I6', count: 10 }], expect: 'freebie1 line: price 0.00, item_quantity 1, offer tag item_id I7, item_count 1.',
        check: (r) => fail(tagVal(offerLine(r, 'freebie1')?.item.tags, 'offer', 'item_id') === 'I7', 'expected freebie1 with I7') }),
      initStep({ check: (r) => all(quoteAddsUp(r), fail(appliedOffers(r).includes('freebie1'), 'freebie1 not applied')) }),
      confirmStep(),
    ],
  },
  {
    id: 'offer-buyxgety', group: 'Offers', title: 'Buy X get Y', providerId: 'P3', retailer: WALK_IN_RETAILER,
    summary: 'buy2get1: every 2 cases of Frooti 200ml get 1 more free.',
    steps: [
      selectStep({ lines: [{ id: 'I16', count: 6 }], expect: '6 cases: buy2get1 with 3 free (item_id I16, item_count 3, item_value 0.00).',
        check: (r) => fail(tagVal(offerLine(r, 'buy2get1')?.item.tags, 'offer', 'item_count') === '3', 'expected 3 free') }),
      initStep({ check: (r) => all(quoteAddsUp(r), fail(appliedOffers(r).includes('buy2get1'), 'buy2get1 not applied')) }),
      confirmStep(),
    ],
  },
  {
    id: 'offer-combo', group: 'Offers', title: 'Combo', providerId: 'P1', retailer: SHARMA,
    summary: 'combo1: Atta (I1 or I2) + both B Natural packs (I4 and I5) → 50% off, max ₹200.',
    steps: [
      selectStep({ lines: [{ id: 'I1', count: 20 }, { id: 'I4', count: 5 }, { id: 'I5', count: 3 }], expect: 'combo1 at -200.00 (capped).',
        check: (r) => fail(offerLine(r, 'combo1')?.price.value === '-200.00', 'expected combo1 -200.00') }),
      initStep({ check: (r) => all(quoteAddsUp(r), fail(appliedOffers(r).includes('combo1'), 'combo1 not applied')) }),
      confirmStep(),
    ],
  },
  {
    id: 'offer-stacking', group: 'Offers', title: 'Stacking - exclusive vs additive', providerId: 'P1', retailer: SHARMA,
    summary: 'The cart qualifies for slab2 and freebie1 (both auto, non-additive) and discp10 (opt-in, additive). Only one non-additive offer may apply.',
    steps: [
      selectStep({ lines: [{ id: 'I2', count: 20 }, { id: 'I6', count: 10 }], expect: 'All three listed. By default the seller applies slab2 (first auto non-additive) only.',
        check: (r) => fail(['slab2', 'freebie1', 'discp10'].every((id) => offerLine(r, id)), 'expected slab2, freebie1 and discp10 listed') }),
      selectStep({ reselect: true, lines: [{ id: 'I2', count: 20 }, { id: 'I6', count: 10 }], offers: ['freebie1', 'discp10'], expect: 'Buyer chooses freebie1 + discp10.' }),
      initStep({ expect: 'Applied: discp10 and freebie1. slab2 is dropped (non-additive, not chosen).',
        check: (r) => all(quoteAddsUp(r), fail(appliedOffers(r).join() === 'discp10,freebie1', `applied ${appliedOffers(r).join()}`)) }),
      confirmStep(),
    ],
  },
  // Retailer identification (P2P)
  {
    id: 'p2p-customer-id', group: 'Retailer (P2P)', title: 'Existing retailer - customer_id', providerId: 'P1', retailer: SHARMA,
    summary: 'The buyer asks P1 for the retailer\'s terms by outlet code.',
    steps: [p2pStep('search (P2P) → on_search', (env) => R.searchP2PWithCustomerId({ ...env, providerId: 'P1', customerId: SHARMA.customer_id }),
      'Header p2p. P1 with credit 25000.00, POC, customer.id and offers with scheme_progress (discp10: target 100, remaining 35).',
      (r) => fail(cbBody(r).message.catalog['bpp/providers'][0].offers?.some((o) => o.id === 'discp10' && tagVal(o.tags, 'scheme_progress', 'remaining_quantity') === '35'), 'expected discp10 scheme progress'))],
  },
  {
    id: 'p2p-phone-pan', group: 'Retailer (P2P)', title: 'Existing retailer - phone + PAN', providerId: 'P2', retailer: { ...LAKSHMI, customer_id: undefined },
    summary: 'The retailer does not know their outlet code; P2 resolves them from its type=existing variant (phone_number + PAN).',
    steps: [p2pStep('search (P2P) → on_search', (env) => R.searchP2PWithoutCustomerId({ ...env, providerId: 'P2', phone: LAKSHMI.phone, pan: LAKSHMI.PAN, gstin: LAKSHMI.GSTIN }),
      `P2 returns customer.id ${LAKSHMI.customer_id}.`)],
  },
  {
    id: 'p2p-new-retailer', group: 'Retailer (P2P)', title: 'New retailer registration', providerId: 'P1', retailer: NEW_RETAILER,
    summary: 'Ravi Provision Store registers with P1, the only provider that publishes a type=new variant.',
    steps: [p2pStep('search (P2P, new retailer) → on_search', (env) => R.searchP2PNewRetailer({ ...env, providerId: 'P1', retailer: NEW_RETAILER }),
      'First callback: creation pending (POC only). Second, ~5s later and unsolicited: credit + customer.id CUST-NEW-122233.')],
  },

  // Post-order
  {
    id: 'post-order', group: 'Post-order', title: 'Post-order: status and delivery', providerId: 'P1', retailer: SHARMA,
    summary: 'After confirm: buyer /status, then the seller pushes Packed → Out-for-delivery → Order-delivered (unsolicited on_status).',
    steps: [
      ...placeOrder([{ id: 'I1', count: 20 }]),
      statusStep(),
      pushStep('packed', 'seller packs → on_status', 'Unsolicited: order In-progress, fulfillment Packed.', ['In-progress', 'Packed']),
      pushStep('out_for_delivery', 'seller dispatches → on_status', 'Unsolicited: order In-progress, fulfillment Out-for-delivery.', ['In-progress', 'Out-for-delivery']),
      pushStep('delivered', 'seller delivers → on_status', 'Unsolicited: order Completed, fulfillment Order-delivered.', ['Completed', 'Order-delivered']),
    ],
  },
  {
    id: 'buyer-cancel', group: 'Post-order', title: 'Buyer cancels order', providerId: 'P1', retailer: SHARMA,
    summary: 'The retailer cancels a confirmed order (reason 053, as pre-order-service sends).',
    steps: [...placeOrder([{ id: 'I1', count: 20 }]), cancelStep()],
  },
  {
    id: 'seller-cancel', group: 'Post-order', title: 'Seller cancels order', providerId: 'P1', retailer: SHARMA,
    summary: 'The distributor cancels a confirmed order on its own (unsolicited on_cancel, reason 005).',
    steps: [
      ...placeOrder([{ id: 'I1', count: 20 }]),
      pushStep('seller_cancel', 'seller cancels → on_cancel', 'Unsolicited: order Cancelled, reason 005 - pre-order-service records it as cancelled by the SELLER.', ['Cancelled', 'Cancelled']),
    ],
  },
];

export const newState = (scenario) => ({ providerId: scenario.providerId, retailer: { ...scenario.retailer } });

// The catalogue a buyer would already have cached: fetched once per scenario as a preview
// (sync mode, nothing is delivered), so order scenarios don't need a search step.
async function ensureCatalog(state, { bap, previewSend }) {
  if (state.catalog) return;
  const reply = await previewSend('search', R.searchBroadcast({ bap }));
  state.catalog = cbBody(reply).message.catalog['bpp/providers'];
}

// Runs one step: builds, sends, checks the ACK, absorbs, then evaluates the step's expectation.
// Returns { request, reply, problem } where problem is null when the outcome matched.
// `previewSend` (defaults to `send`) fetches the catalogue when a step needs it.
export async function runStep(step, state, { bap, bpp, send, previewSend = send }) {
  if (step.needsCatalog) await ensureCatalog(state, { bap, previewSend });
  const request = step.build({ bap, bpp }, state);
  const reply = await send(step.action, request);
  if (reply.response?.message?.ack?.status !== 'ACK') {
    throw Object.assign(new Error(`${step.name}: NACK ${JSON.stringify(reply.response?.error)}`), { request, reply });
  }
  step.absorb?.(state, reply);
  return { request, reply, problem: step.check ? step.check(reply, state) : null };
}

export async function runScenario(scenario, { bap, bpp, send, previewSend, onStep = () => {} }) {
  const state = newState(scenario);
  for (const step of scenario.steps) {
    const result = await runStep(step, state, { bap, bpp, send, previewSend });
    onStep({ step, ...result });
    if (result.problem) throw Object.assign(new Error(`${scenario.id} / ${step.name}: ${result.problem}`), result);
  }
  return state;
}
