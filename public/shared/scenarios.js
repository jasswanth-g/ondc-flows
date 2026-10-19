import * as R from './requests.js';
import { RETAILERS, NEW_RETAILER, WALK_IN_RETAILER } from './retailers.js';

const [SHARMA, LAKSHMI] = RETAILERS;

// ---- reading replies ------------------------------------------------------------------------
// The callback a step is about is the last one (a select can be preceded by an incremental on_search).
const cbBody = (reply, i = reply.callbacks.length - 1) => reply.callbacks[i]?.body;
const order = (reply) => cbBody(reply)?.message?.order;
const errorCode = (reply) => cbBody(reply)?.error?.code;
const breakup = (reply) => order(reply)?.quote?.breakup ?? [];
const itemLine = (reply, id) => breakup(reply).find((b) => b['@ondc/org/title_type'] === 'item' && b['@ondc/org/item_id'] === id);
const itemCount = (reply, id) => itemLine(reply, id)?.['@ondc/org/item_quantity'].count;
const offerLine = (reply, id) => breakup(reply).find((b) => b['@ondc/org/title_type'] === 'offer' && b['@ondc/org/item_id'] === id);
const tagVal = (tags, code, key) => tags?.find((t) => t.code === code)?.list.find((e) => e.code === key)?.value;
const fail = (cond, msg) => (cond ? null : msg);
const all = (...checks) => checks.find(Boolean) ?? null;
const noError = (reply) => fail(!cbBody(reply)?.error, `unexpected error ${JSON.stringify(cbBody(reply)?.error)}`);
const appliedOffers = (reply) => (order(reply)?.offers ?? []).map((o) => o.id);
// Sum of the breakup must equal quote.price (on_init / on_confirm carry only the applied offers).
const quoteAddsUp = (reply) => {
  const q = order(reply)?.quote;
  if (!q) return 'no quote';
  const sum = q.breakup.reduce((s, b) => s + Number(b.price.value), 0).toFixed(2);
  return fail(sum === q.price.value, `breakup sums to ${sum}, quote.price is ${q.price.value}`);
};

// ---- state helpers --------------------------------------------------------------------------
const providerOf = (s) => s.catalog.find((p) => p.id === s.providerId);
const catalogItem = (s, id) => providerOf(s).items.find((i) => i.id === id);
const qtyOf = (s, id) => s.cart.find((l) => l.id === id)?.count ?? 0;
const half = (n) => Math.max(1, Math.floor(n / 2));
const minOrderValue = (s) => Number(tagVal(providerOf(s).tags, 'order_value', 'min_value'));
const cartValue = (s, lines) => lines.reduce((sum, l) => sum + Number(catalogItem(s, l.id).price.value) * l.count, 0);
// The buyer tops the cart up to the provider's published minimum order value.
const scaleToMov = (s) => {
  const factor = Math.ceil(minOrderValue(s) / cartValue(s, s.cart));
  return s.cart.map((l) => ({ ...l, count: l.count * factor }));
};

const cartText = (s, lines) => lines.map((l) => `${l.id} ${catalogItem(s, l.id)?.descriptor.name ?? ''} × ${l.count}`).join(', ');

// ---- steps ----------------------------------------------------------------------------------
// A step: { name, action, buyer(state), expect, build(env, state), absorb(state, reply), check(reply, state) }.
// `action` is the ONDC endpoint the buyer app calls, or 'push' for a seller action. `buyer` says what
// to do in the buyer app to make that call. `expect` may be a function of state (it names the
// affected item). build/absorb/check drive the simulation and the tests.

const searchStep = () => ({
  name: 'search → on_search', action: 'search',
  buyer: () => 'Open the catalogue: the app sends a broadcast /search.',
  expect: 'Full catalogue (header full): providers with locations, items, variant groups, offers and pan-India serviceability.',
  build: ({ bap }) => R.searchBroadcast({ bap }),
  absorb: (s, reply) => (s.catalog = cbBody(reply).message.catalog['bpp/providers']),
  check: (reply) => fail(reply.callbacks[0]?.headers?.['X-ONDC-Search-Response'] === 'full' && cbBody(reply).message.catalog['bpp/providers'].length > 0, 'expected a full catalogue'),
});

const p2pStep = (name, build, expect, check) => ({
  name, action: 'search', p2p: true, expect, build,
  buyer: () => 'Identify the retailer: the app sends a P2P /search (bpp_id set, fulfillment.customer).',
  absorb: (s, reply) => {
    // The last callback carries the customer id (for a new retailer, the unsolicited "created" one).
    const p = cbBody(reply).message.catalog['bpp/providers'].find((x) => x.id === s.providerId);
    const id = tagVal(p?.tags, 'customer', 'id');
    if (id) s.retailer.customer_id = id;
  },
  check: check ?? ((reply, s) => fail(s.retailer.customer_id, 'P2P search returned no customer id')),
});

// /select. `lines` defaults to the scenario's cart; it can be a function of state (a re-select built
// from the seller's reply).
const selectStep = ({ lines, expect = 'Serviceable quote.', check, reselect = false, buyer } = {}) => ({
  name: reselect ? 're-select → on_select' : 'select → on_select', action: 'select', expect, needsCatalog: true,
  buyer: buyer ?? ((s) => (reselect
    ? (Array.isArray(lines) ? `Change the cart to ${cartText(s, lines)}: the app sends /select again.` : 'Accept the seller\'s changes to the cart: the app sends /select again.')
    : s.anyItems
      ? `Add any items to the cart${s.mode !== 'normal' ? ` (the seller mode hits ${s.modeItems?.length ? s.modeItems.join(', ') : 'the first item in the cart'})` : ''} and open it: the app sends /select.`
      : `Add ${cartText(s, lines ?? s.cart)} from ${s.providerId} and open the cart: the app sends /select.`)),
  build: (env, s) => {
    const req = R.select({
      ...env, catalogProvider: providerOf(s), retailer: s.retailer,
      lines: typeof lines === 'function' ? lines(s) : lines ?? s.cart,
      ...(reselect ? { transactionId: s.selectRequest.context.transaction_id } : {}),
    });
    s.selectRequest = req;
    return req;
  },
  absorb: (s, reply) => (s.onSelect = cbBody(reply)),
  check: check ?? noError,
});

// `offers`: the buyer's offer selection; omitted, the buyer keeps what on_select applied.
const initStep = ({ name = 'init → on_init', fulfillmentId, paymentType, offers, expect = 'Quote, payment and settlement terms, bpp_terms and (for a known retailer) credit.', check } = {}) => ({
  name, action: 'init', expect,
  buyer: () => ['Go to checkout: the app sends /init',
    fulfillmentId ? ` with delivery option ${fulfillmentId}` : '',
    paymentType === 'ON-ORDER' ? ', paying online (ON-ORDER)' : '',
    offers ? ` with the offers ${offers.join(' + ')} selected` : ' keeping the offers on_select applied',
    '.'].join(''),
  build: (env, s) => R.init({ ...env, selectRequest: s.selectRequest, onSelect: s.onSelect, retailer: s.retailer, paymentType, fulfillmentId, offers }),
  absorb: (s, reply) => (s.onInit = cbBody(reply)),
  check: check ?? ((reply) => all(noError(reply), quoteAddsUp(reply))),
});

const confirmStep = ({ expect = 'Order Accepted, fulfillment Pending, same quote as on_init.', check } = {}) => ({
  name: 'confirm → on_confirm', action: 'confirm', expect,
  buyer: () => 'Place the order: the app sends /confirm.',
  build: (env, s) => R.confirm({ ...env, onInit: s.onInit, onSelect: s.onSelect, retailer: s.retailer }),
  absorb: (s, reply) => (s.onConfirm = cbBody(reply)),
  check: check ?? ((reply, s) => all(noError(reply), quoteAddsUp(reply), fail(order(reply).state === 'Accepted', `state ${order(reply).state}`),
    fail(order(reply).quote.price.value === s.onInit.message.order.quote.price.value, 'quote changed between on_init and on_confirm'))),
});

const statusStep = () => ({
  name: 'status → on_status', action: 'status',
  buyer: () => 'Open / refresh the order: the app sends /status.',
  expect: 'The confirmed order as the seller holds it: state Accepted, fulfillment Pending.',
  build: (env, s) => R.status({ ...env, onConfirm: s.onConfirm }),
  check: (reply) => fail(order(reply)?.state === 'Accepted', `state ${order(reply)?.state}`),
});

const PUSH_LABELS = { packed: 'Packed', out_for_delivery: 'Out for delivery', delivered: 'Delivered', seller_cancel: 'Seller cancels' };
const pushStep = (event, name, expect, [orderState, fulfillmentState]) => ({
  name, action: 'push', expect, event, callback: event === 'seller_cancel' ? 'on_cancel' : 'on_status',
  buyer: () => `Nothing to do in the app: the seller sends this on its own (${PUSH_LABELS[event]}) once the previous step completes. The app receives it.`,
  build: (env, s) => R.sellerPush({ onConfirm: s.onConfirm, event }),
  check: (reply) => fail(order(reply)?.state === orderState && order(reply)?.fulfillments[0].state.descriptor.code === fulfillmentState,
    `expected ${orderState} / ${fulfillmentState}, got ${order(reply)?.state} / ${order(reply)?.fulfillments?.[0]?.state?.descriptor?.code}`),
});

const cancelStep = () => ({
  name: 'cancel → on_cancel', action: 'cancel',
  buyer: () => 'Cancel the order from the app: it sends /cancel (reason 053).',
  expect: 'Order Cancelled, cancellation.reason.id 053 (buyer) - pre-order-service records it as cancelled by the CUSTOMER.',
  build: (env, s) => R.cancel({ ...env, onConfirm: s.onConfirm }),
  check: (reply) => fail(order(reply)?.state === 'Cancelled' && order(reply)?.cancellation?.reason?.id === '053', 'expected Cancelled with reason 053'),
});

const placeOrder = () => [selectStep(), initStep(), confirmStep()];
const reselectFromQuote = (from) => selectStep({ reselect: true, lines: (s) => R.linesFromQuote(s[from].message.order.quote), expect: 'With the quantities the seller can supply: no error.' });

// ---- scenarios ------------------------------------------------------------------------------
// { id, group, title, summary, providerId, retailer, cart, mode?, steps }
// `cart` is the default order (editable in the playground). `mode` is the seller mode sent with
// every request (X-Mock-Mode); it acts on `state.target`, the affected item.

export const SCENARIOS = [
  // Pre-order
  {
    id: 'search', group: 'Pre-order', title: 'Search', providerId: 'P1', retailer: SHARMA, cart: [],
    summary: 'Broadcast /search and the full catalogue on_search.',
    steps: [searchStep()],
  },
  {
    id: 'place-order', anyItems: true, group: 'Pre-order', title: 'Place order (positive)', providerId: 'P1', retailer: SHARMA,
    summary: 'Order any items: select → init (pay on fulfillment, credit for a known retailer) → confirm.',
    steps: [
      selectStep({ expect: 'Serviceable. Two delivery options: F1 Standard Delivery (beat, P2D) and F2 Immediate Delivery (tomorrow, P1D).',
        check: (r) => all(noError(r), fail(order(r).fulfillments.length === 2, 'expected 2 delivery options')) }),
      initStep(),
      confirmStep(),
    ],
  },
  {
    id: 'delivery-tomorrow', anyItems: true, group: 'Pre-order', title: 'Place order - tomorrow delivery', providerId: 'P1', retailer: SHARMA,
    summary: 'The buyer picks F2 (Immediate Delivery) from on_select instead of the beat day.',
    steps: [
      selectStep({ expect: 'F1 Standard Delivery and F2 Immediate Delivery offered.' }),
      initStep({ fulfillmentId: 'F2', expect: 'Fulfillment F2 (Immediate Delivery), TAT P1D.',
        check: (r) => all(noError(r), fail(order(r).fulfillments[0].id === 'F2' && order(r).fulfillments[0]['@ondc/org/TAT'] === 'P1D', 'expected F2 / P1D')) }),
      confirmStep(),
    ],
  },
  {
    id: 'place-order-prepaid', anyItems: true, group: 'Pre-order', title: 'Place order - walk-in, prepaid (P3)', providerId: 'P3', retailer: WALK_IN_RETAILER,
    summary: 'Order any items and pay online (ON-ORDER): the seller returns its payment link in on_init.',
    steps: [
      selectStep(),
      initStep({ paymentType: 'ON-ORDER', expect: 'payments[0].type ON-ORDER with the seller\'s payment link (uri); no credit tag.',
        check: (r) => all(noError(r), fail(order(r).payments[0].uri, 'expected a payment uri')) }),
      confirmStep(),
    ],
  },
  {
    id: 'item-inactive', anyItems: true, group: 'Pre-order', title: 'Item inactive', providerId: 'P1', retailer: SHARMA, mode: 'item_inactive',
    summary: 'The seller disables an item that is in the cart. It tells the buyer with an incremental on_search, and returns the item at qty 0.',
    steps: [
      selectStep({ expect: (s) => `First an unsolicited incremental on_search (header inc) with ${s.target} time.label "disable", then on_select with error 40002 and ${s.target} at qty 0.`,
        check: (r, s) => {
          const inc = r.callbacks.find((c) => c.headers?.['X-ONDC-Search-Response'] === 'inc')?.body.message.catalog['bpp/providers'][0].items[0];
          return all(fail(inc?.id === s.target && inc?.time.label === 'disable', `expected an inc on_search disabling ${s.target}`),
            fail(errorCode(r) === '40002' && itemCount(r, s.target) === 0, `expected 40002 with ${s.target} at 0`));
        } }),
      reselectFromQuote('onSelect'),
      initStep(),
      confirmStep(),
    ],
  },
  {
    id: 'out-of-stock', anyItems: true, group: 'Pre-order', title: 'Item out of stock', providerId: 'P2', retailer: LAKSHMI, mode: 'out_of_stock',
    summary: 'The seller has none of the affected item left.',
    steps: [
      selectStep({ expect: (s) => `Error 40002, message [{"item_id":"${s.target}","error":"40002"}]; ${s.target} at qty 0.`,
        check: (r, s) => fail(errorCode(r) === '40002' && itemCount(r, s.target) === 0, `expected 40002 with ${s.target} at 0`) }),
      reselectFromQuote('onSelect'),
      initStep(),
      confirmStep(),
    ],
  },
  {
    id: 'partial-quantity', anyItems: true, group: 'Pre-order', title: 'Partial quantity available', providerId: 'P1', retailer: SHARMA, mode: 'partial_quantity',
    summary: 'The seller can supply only half of the affected item.',
    steps: [
      selectStep({ expect: (s) => `Error 40002; ${s.target} at ${half(qtyOf(s, s.target))} of ${qtyOf(s, s.target)}.`,
        check: (r, s) => fail(errorCode(r) === '40002' && itemCount(r, s.target) === half(qtyOf(s, s.target)), `expected 40002 with ${s.target} at ${half(qtyOf(s, s.target))}`) }),
      reselectFromQuote('onSelect'),
      initStep(),
      confirmStep(),
    ],
  },
  {
    id: 'price-changed', anyItems: true, group: 'Pre-order', title: 'Price changed', providerId: 'P2', retailer: LAKSHMI, mode: 'price_changed',
    summary: 'The seller now charges 5% more for the affected item than the catalogue says.',
    steps: [
      selectStep({ expect: (s) => `No error; ${s.target} item.price ${(Math.round(Number(catalogItem(s, s.target).price.value) * 105) / 100).toFixed(2)} instead of ${catalogItem(s, s.target).price.value}.`,
        check: (r, s) => all(noError(r), fail(itemLine(r, s.target)?.item.price.value === (Math.round(Number(catalogItem(s, s.target).price.value) * 105) / 100).toFixed(2), `expected ${s.target} +5%`)) }),
      initStep(),
      confirmStep(),
    ],
  },
  {
    id: 'min-order-value', anyItems: true, cartRule: 'below_mov', group: 'Pre-order', title: 'Minimum order value not met', providerId: 'P2', retailer: LAKSHMI,
    summary: 'A cart below the distributor\'s published order_value.min_value (P1 500, P2 2000, P3 1500). The buyer tops it up and re-selects.',
    steps: [
      selectStep({ buyer: () => 'Add items worth less than the distributor\'s minimum order value (P1 ₹500, P2 ₹2000, P3 ₹1500) and open the cart: the app sends /select.',
        expect: 'Error 30023 with the quote still present (pre-order-service shows MOV_NOT_MET).',
        check: (r) => fail(errorCode(r) === '30023' && order(r)?.quote, 'expected 30023 with a quote - is the cart below the minimum order value?') }),
      selectStep({ reselect: true, lines: scaleToMov, expect: 'Quantities scaled up to reach the minimum order value: no error.',
        buyer: () => 'Add items until the cart reaches the minimum order value: the app sends /select again.' }),
      initStep(),
      confirmStep(),
    ],
  },
  {
    id: 'init-qty-reduced', anyItems: true, group: 'Pre-order', title: 'Quantity reduced at init', providerId: 'P2', retailer: LAKSHMI, mode: 'init_qty_reduced',
    summary: 'Stock of the affected item halves between select and init. on_init returns the lower quantity; the buyer must select again.',
    steps: [
      selectStep({ expect: 'Everything available.' }),
      initStep({ expect: (s) => `No error, but ${s.target} comes back at ${half(qtyOf(s, s.target))} (pre-order-service: CART_UPDATED → re-select).`,
        check: (r, s) => all(noError(r), fail(itemCount(r, s.target) === half(qtyOf(s, s.target)), `expected ${s.target} at ${half(qtyOf(s, s.target))}`)) }),
      reselectFromQuote('onInit'),
      initStep({ name: 're-init → on_init', expect: 'Same quantities as the re-select: no further reduction.' }),
      confirmStep(),
    ],
  },
  {
    id: 'confirm-rejected', anyItems: true, group: 'Pre-order', title: 'Seller rejects confirm', providerId: 'P2', retailer: LAKSHMI, mode: 'confirm_rejected',
    summary: 'Select and init succeed; the seller cannot confirm the order.',
    steps: [
      selectStep(),
      initStep(),
      confirmStep({ expect: 'on_confirm with error 30019 (pre-order-service marks the order Cancelled).', check: (r) => fail(errorCode(r) === '30019', 'expected 30019') }),
    ],
  },

  // Offers - each offer names its items in the catalogue, so these carts are the qualifying ones.
  {
    id: 'offer-discount', group: 'Offers', title: 'Discount - opt-in (percent)', providerId: 'P1', retailer: SHARMA,
    cart: [{ id: 'I1', count: 20 }],
    summary: 'discp10: 10% off Atta (max ₹200), min ₹500, auto = no. on_select lists it without applying it; the buyer selects it at init.',
    steps: [
      selectStep({ expect: 'discp10 listed at -104.00, not applied: quote.price 1040.00.',
        check: (r) => all(noError(r), fail(offerLine(r, 'discp10')?.price.value === '-104.00', 'expected discp10 -104.00'), fail(order(r).quote.price.value === '1040.00', `quote.price ${order(r).quote.price.value}`)) }),
      initStep({ offers: ['discp10'], expect: 'Buyer sends offers [discp10]: applied, quote.price 936.00.',
        check: (r) => all(noError(r), quoteAddsUp(r), fail(appliedOffers(r).join() === 'discp10', `applied ${appliedOffers(r).join()}`), fail(order(r).quote.price.value === '936.00', `quote.price ${order(r).quote.price.value}`)) }),
      confirmStep(),
    ],
  },
  {
    id: 'offer-flat', group: 'Offers', title: 'Discount - flat amount', providerId: 'P2', retailer: LAKSHMI,
    cart: [{ id: 'I9', count: 10 }, { id: 'I12', count: 10 }],
    summary: 'flat150: ₹150 off Tea & Coffee above ₹1000, auto + additive.',
    steps: [
      selectStep({ expect: 'flat150 at -150.00, applied: quote.price 3750.00.', check: (r) => all(noError(r), fail(offerLine(r, 'flat150')?.price.value === '-150.00' && order(r).quote.price.value === '3750.00', 'expected flat150 applied')) }),
      initStep({ check: (r) => all(noError(r), quoteAddsUp(r), fail(appliedOffers(r).includes('flat150'), 'flat150 not applied')) }),
      confirmStep(),
    ],
  },
  {
    id: 'offer-slab-count', group: 'Offers', title: 'Slab - by quantity', providerId: 'P1', retailer: SHARMA,
    cart: [{ id: 'I2', count: 10 }],
    summary: 'Atta 5kg: slab1 5% for 10-19 units (max ₹500), slab2 10% for 20+ units (max ₹1000).',
    steps: [
      selectStep({ expect: '10 units: slab1 at -122.50.', check: (r) => fail(offerLine(r, 'slab1')?.price.value === '-122.50', 'expected slab1 -122.50') }),
      selectStep({ reselect: true, lines: [{ id: 'I2', count: 20 }], expect: '20 units: slab2 at -490.00 replaces slab1.', check: (r) => fail(offerLine(r, 'slab2')?.price.value === '-490.00' && !offerLine(r, 'slab1'), 'expected slab2 only') }),
      initStep({ check: (r) => all(quoteAddsUp(r), fail(appliedOffers(r).includes('slab2'), 'slab2 not applied')) }),
      confirmStep(),
    ],
  },
  {
    id: 'offer-slab-weight', group: 'Offers', title: 'Slab - by weight', providerId: 'P2', retailer: LAKSHMI,
    cart: [{ id: 'I10', count: 5 }],
    summary: 'Surf Excel: slabw1 4% for 20-49 kg, slabw2 8% for 50+ kg (weight = pack size x quantity).',
    steps: [
      selectStep({ expect: '20 kg: slabw1 at -99.00.', check: (r) => fail(offerLine(r, 'slabw1')?.price.value === '-99.00', 'expected slabw1 -99.00') }),
      selectStep({ reselect: true, lines: [{ id: 'I10', count: 13 }], expect: '52 kg: slabw2 at -514.80.', check: (r) => fail(offerLine(r, 'slabw2')?.price.value === '-514.80', 'expected slabw2 -514.80') }),
      initStep({ check: (r) => all(quoteAddsUp(r), fail(appliedOffers(r).includes('slabw2'), 'slabw2 not applied')) }),
      confirmStep(),
    ],
  },
  {
    id: 'offer-slab-value', group: 'Offers', title: 'Slab - by value', providerId: 'P3', retailer: WALK_IN_RETAILER,
    cart: [{ id: 'I19', count: 6 }],
    summary: 'slabv1: 3% off Appy Fizz worth ₹5000+ (max ₹1000), auto + additive.',
    steps: [
      selectStep({ expect: '₹5040 of Appy Fizz: slabv1 at -151.20.', check: (r) => fail(offerLine(r, 'slabv1')?.price.value === '-151.20', 'expected slabv1 -151.20') }),
      initStep({ check: (r) => all(quoteAddsUp(r), fail(appliedOffers(r).includes('slabv1'), 'slabv1 not applied')) }),
      confirmStep(),
    ],
  },
  {
    id: 'offer-freebie', group: 'Offers', title: 'Freebie', providerId: 'P1', retailer: SHARMA,
    cart: [{ id: 'I6', count: 10 }],
    summary: 'freebie1: buy 10 Dark Fantasy, get 1 Bingo Mad Angles free.',
    steps: [
      selectStep({ expect: 'freebie1 line: price 0.00, item_quantity 1, offer tag item_id I7, item_count 1.',
        check: (r) => fail(tagVal(offerLine(r, 'freebie1')?.item.tags, 'offer', 'item_id') === 'I7', 'expected freebie1 with I7') }),
      initStep({ check: (r) => all(quoteAddsUp(r), fail(appliedOffers(r).includes('freebie1'), 'freebie1 not applied')) }),
      confirmStep(),
    ],
  },
  {
    id: 'offer-buyxgety', group: 'Offers', title: 'Buy X get Y', providerId: 'P3', retailer: WALK_IN_RETAILER,
    cart: [{ id: 'I16', count: 6 }],
    summary: 'buy2get1: every 2 cases of Frooti 200ml get 1 more free.',
    steps: [
      selectStep({ expect: '6 cases: buy2get1 with 3 free (item_id I16, item_count 3, item_value 0.00).',
        check: (r) => fail(tagVal(offerLine(r, 'buy2get1')?.item.tags, 'offer', 'item_count') === '3', 'expected 3 free') }),
      initStep({ check: (r) => all(quoteAddsUp(r), fail(appliedOffers(r).includes('buy2get1'), 'buy2get1 not applied')) }),
      confirmStep(),
    ],
  },
  {
    id: 'offer-combo', group: 'Offers', title: 'Combo', providerId: 'P1', retailer: SHARMA,
    cart: [{ id: 'I1', count: 20 }, { id: 'I4', count: 5 }, { id: 'I5', count: 3 }],
    summary: 'combo1: Atta (I1 or I2) + both B Natural packs (I4 and I5) → 50% off, max ₹200.',
    steps: [
      selectStep({ expect: 'combo1 at -200.00 (capped).', check: (r) => fail(offerLine(r, 'combo1')?.price.value === '-200.00', 'expected combo1 -200.00') }),
      initStep({ check: (r) => all(quoteAddsUp(r), fail(appliedOffers(r).includes('combo1'), 'combo1 not applied')) }),
      confirmStep(),
    ],
  },
  {
    id: 'offer-stacking', group: 'Offers', title: 'Stacking - exclusive vs additive', providerId: 'P1', retailer: SHARMA,
    cart: [{ id: 'I2', count: 20 }, { id: 'I6', count: 10 }],
    summary: 'The cart qualifies for slab2 and freebie1 (both auto, non-additive) and discp10 (opt-in, additive). Only one non-additive offer may apply.',
    steps: [
      selectStep({ expect: 'All three listed. Applied: slab2 only (auto; the first non-additive) - quote.price 8010.00.',
        check: (r) => all(fail(['slab2', 'freebie1', 'discp10'].every((id) => offerLine(r, id)), 'expected slab2, freebie1 and discp10 listed'), fail(order(r).quote.price.value === '8010.00', `quote.price ${order(r).quote.price.value}`)) }),
      initStep({ offers: ['freebie1', 'discp10'], expect: 'Buyer selects freebie1 + discp10: both applied, slab2 dropped - quote.price 8300.00.',
        check: (r) => all(quoteAddsUp(r), fail(appliedOffers(r).join() === 'discp10,freebie1', `applied ${appliedOffers(r).join()}`)) }),
      confirmStep(),
    ],
  },

  // Retailer identification (P2P) - optional: the catalogue publishes no retailer_info_required.
  {
    id: 'p2p-customer-id', group: 'Retailer (P2P)', title: 'Existing retailer - customer_id', providerId: 'P1', retailer: SHARMA, cart: [],
    summary: 'If a buyer NP sends a P2P search, the seller returns the retailer\'s terms by outlet code.',
    steps: [p2pStep('search (P2P) → on_search', (env) => R.searchP2PWithCustomerId({ ...env, providerId: 'P1', customerId: SHARMA.customer_id }),
      'Header p2p. P1 with credit 25000.00, POC, customer.id and offers with scheme_progress (discp10: target 100, remaining 35).',
      (r) => fail(cbBody(r).message.catalog['bpp/providers'][0].offers?.some((o) => o.id === 'discp10' && tagVal(o.tags, 'scheme_progress', 'remaining_quantity') === '35'), 'expected discp10 scheme progress'))],
  },
  {
    id: 'p2p-phone-pan', group: 'Retailer (P2P)', title: 'Existing retailer - phone + PAN', providerId: 'P2', retailer: { ...LAKSHMI, customer_id: undefined }, cart: [],
    summary: 'The retailer does not know their outlet code; the seller resolves them from phone + PAN.',
    steps: [p2pStep('search (P2P) → on_search', (env) => R.searchP2PWithoutCustomerId({ ...env, providerId: 'P2', phone: LAKSHMI.phone, pan: LAKSHMI.PAN, gstin: LAKSHMI.GSTIN }),
      `P2 returns customer.id ${LAKSHMI.customer_id}.`)],
  },
  {
    id: 'p2p-new-retailer', group: 'Retailer (P2P)', title: 'New retailer registration', providerId: 'P1', retailer: NEW_RETAILER, cart: [],
    summary: 'Ravi Provision Store registers with P1.',
    steps: [p2pStep('search (P2P, new retailer) → on_search', (env) => R.searchP2PNewRetailer({ ...env, providerId: 'P1', retailer: NEW_RETAILER }),
      'First callback: creation pending (POC only). Second, ~5s later and unsolicited: credit + customer.id CUST-NEW-122233.')],
  },

  // Post-order
  {
    id: 'post-order', anyItems: true, group: 'Post-order', title: 'Post-order: status and delivery', providerId: 'P1', retailer: SHARMA,
    summary: 'After confirm: buyer /status, then the seller pushes Packed → Out-for-delivery → Order-delivered (unsolicited on_status).',
    steps: [
      ...placeOrder(),
      statusStep(),
      pushStep('packed', 'seller packs → on_status', 'Unsolicited: order In-progress, fulfillment Packed.', ['In-progress', 'Packed']),
      pushStep('out_for_delivery', 'seller dispatches → on_status', 'Unsolicited: order In-progress, fulfillment Out-for-delivery.', ['In-progress', 'Out-for-delivery']),
      pushStep('delivered', 'seller delivers → on_status', 'Unsolicited: order Completed, fulfillment Order-delivered.', ['Completed', 'Order-delivered']),
    ],
  },
  {
    id: 'buyer-cancel', anyItems: true, group: 'Post-order', title: 'Buyer cancels order', providerId: 'P1', retailer: SHARMA,
    summary: 'The retailer cancels a confirmed order (reason 053, as pre-order-service sends).',
    steps: [...placeOrder(), cancelStep()],
  },
  {
    id: 'seller-cancel', anyItems: true, group: 'Post-order', title: 'Seller cancels order', providerId: 'P1', retailer: SHARMA,
    summary: 'The distributor cancels a confirmed order on its own (unsolicited on_cancel, reason 005).',
    steps: [
      ...placeOrder(),
      pushStep('seller_cancel', 'seller cancels → on_cancel', 'Unsolicited: order Cancelled, reason 005 - pre-order-service records it as cancelled by the SELLER.', ['Cancelled', 'Cancelled']),
    ],
  },
];

// `cart` / `target` override the scenario's defaults (the playground's cart editor).
// Any-items scenarios get a random cart once the catalogue is loaded (see randomCart).
export function newState(scenario, { cart, target } = {}) {
  const state = {
    providerId: scenario.providerId,
    retailer: { ...scenario.retailer },
    cart: (cart ?? scenario.cart ?? []).map((l) => ({ ...l })),
    mode: scenario.mode ?? 'normal',
    anyItems: Boolean(scenario.anyItems),
    cartRule: scenario.cartRule,
    wantedTarget: target,
  };
  pickTarget(state);
  return state;
}

function pickTarget(state) {
  const ids = state.cart.map((l) => l.id);
  state.target = ids.includes(state.wantedTarget) ? state.wantedTarget : ids[0];
}

const randomInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
const shuffled = (list) => list.map((v) => [Math.random(), v]).sort((a, b) => a[0] - b[0]).map(([, v]) => v);

// A random cart that keeps the flow valid: two items at or above their MOQ, where the items other
// than the affected (first) one alone meet the minimum order value - so the order still goes through
// after the seller mode removes or halves the affected item. 'below_mov' is one item under the minimum.
export function randomCart(state) {
  const items = providerOf(state).items;
  const moq = (i) => Number(i.quantity.minimum.count);
  const price = (i) => Number(i.price.value);
  const mov = minOrderValue(state);
  if (state.cartRule === 'below_mov') {
    const under = items.filter((i) => price(i) * moq(i) < mov);
    const pick = shuffled(under.length ? under : items)[0];
    return [{ id: pick.id, count: moq(pick) }];
  }
  const [a, b] = shuffled(items);
  const lines = [a, b].map((i) => ({ id: i.id, count: randomInt(moq(i), moq(i) * 2) }));
  const rest = price(b) * lines[1].count;
  if (rest < mov) lines[1].count *= Math.ceil(mov / rest);
  return lines;
}

// The catalogue a buyer would already have cached: fetched once per scenario as a preview
// (sync mode, nothing is delivered), so order scenarios don't need a search step.
async function ensureCatalog(state, { bap, previewSend }) {
  if (!state.catalog) {
    const reply = await previewSend('search', R.searchBroadcast({ bap }), { name: 'normal', items: [] });
    state.catalog = cbBody(reply).message.catalog['bpp/providers'];
  }
  if (state.anyItems && !state.cart.length) {
    state.cart = randomCart(state);
    pickTarget(state);
  }
}
export { ensureCatalog };

// Runs one step: builds, sends (with the scenario's seller mode), checks the ACK, absorbs, then
// evaluates the step's expectation. Returns { request, reply, problem }; problem is null when the
// outcome matched. `send(action, body, mode)`; `previewSend` (defaults to `send`) fetches the catalogue.
export async function runStep(step, state, { bap, bpp, send, previewSend = send }) {
  if (step.needsCatalog) await ensureCatalog(state, { bap, previewSend });
  const request = step.build({ bap, bpp }, state);
  const reply = await send(step.action, request, { name: state.mode, items: state.target ? [state.target] : [] });
  if (reply.response?.message?.ack?.status !== 'ACK') {
    throw Object.assign(new Error(`${step.name}: NACK ${JSON.stringify(reply.response?.error)}`), { request, reply });
  }
  step.absorb?.(state, reply);
  return { request, reply, problem: step.check ? step.check(reply, state) : null };
}

export async function runScenario(scenario, { bap, bpp, send, previewSend, cart, target, onStep = () => {} }) {
  const state = newState(scenario, { cart, target });
  for (const step of scenario.steps) {
    const result = await runStep(step, state, { bap, bpp, send, previewSend });
    onStep({ step, ...result });
    if (result.problem) throw Object.assign(new Error(`${scenario.id} / ${step.name}: ${result.problem}`), result);
  }
  return state;
}

export { PUSH_LABELS };
export const buyerText = (step, state) => (state.catalog || !step.needsCatalog ? step.buyer(state) : '');
export function expectText(step, state) {
  if (typeof step.expect !== 'function') return step.expect;
  if (!state.catalog || !state.cart.length) return 'Depends on the items your app orders.';
  try {
    return step.expect(state);
  } catch {
    return 'Depends on the items your app orders.';
  }
}

// ---- live tracking --------------------------------------------------------------------------
// Matches the calls a buyer app actually made (activity entries, oldest first) to a scenario's
// steps, in order, and checks each one with the step's own expectation. Calls that are not part of
// the flow (a catalogue /search before an order, a repeated call) are skipped.
const entryMatches = (step, a) => (step.action === 'push'
  ? a.kind === 'seller_action' && a.request?.event === step.event
  : a.kind === 'request' && a.action === step.action && (step.action !== 'search' || Boolean(step.p2p) === Boolean(a.request?.context?.bpp_id)));

// Each result: { step, phase, entry, problem, expect } with phase
//   waiting   - the call has not arrived
//   running   - the app's call arrived; the mock is still delivering the callback(s)
//   completed - every callback was delivered; `problem` says whether the answer matched
export function trackLive(scenario, entries, { catalog, modeItems = [] }) {
  const state = newState(scenario);
  Object.assign(state, { catalog, modeItems, cart: [] });
  const steps = scenario.steps;
  const nextMatch = (step, from) => entries.findIndex((a, i) => i >= from && entryMatches(step, a));
  let cursor = 0;
  const results = steps.map((step) => {
    const at = nextMatch(step, cursor);
    if (at === -1) return { step, phase: 'waiting', entry: null, expect: expectText(step, state) };
    cursor = at + 1;
    const entry = entries[at];
    const reply = { response: entry.response, callbacks: entry.callbacks ?? [] };
    if (step.action === 'select') {
      state.selectRequest = entry.request;
      if (!state.cart.length) {
        // The first /select tells us what the app ordered; the seller mode hits the named items, else the first.
        const order = entry.request.message?.order ?? {};
        state.providerId = order.provider?.id ?? state.providerId;
        state.cart = (order.items ?? []).map((i) => ({ id: i.id, count: Number(i.quantity?.count ?? 0) }));
        state.wantedTarget = modeItems.find((id) => state.cart.some((l) => l.id === id));
        pickTarget(state);
      }
    }
    let problem = null;
    try {
      if (reply.response?.message?.ack?.status !== 'ACK') problem = `mock NACKed: ${JSON.stringify(reply.response?.error)}`;
      else {
        step.absorb?.(state, reply);
        problem = step.check ? step.check(reply, state) : null;
      }
    } catch (err) {
      problem = `could not check: ${err.message}`;
    }
    const phase = entry.status === 'running' ? 'running' : 'completed';
    return { step, phase, entry, problem, expect: expectText(step, state) };
  });
  // The tracked state (e.g. onConfirm, for the seller actions that follow the order).
  results.state = state;
  return results;
}
