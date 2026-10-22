import * as R from './requests.js';
import { RETAILERS, NEW_RETAILER, WALK_IN_RETAILER } from './retailers.js';
import { P1, P2, P3, ID, label } from './ids.js';

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
const priceIs = (reply, value) => fail(order(reply)?.quote.price.value === value, `quote.price ${order(reply)?.quote.price.value}, expected ${value}`);
const offerIs = (reply, id, value, auto) => {
  const l = offerLine(reply, id);
  if (!l) return `${label(id)} not in the breakup`;
  return all(fail(l.price.value === value, `${label(id)} at ${l.price.value}, expected ${value}`),
    fail(!auto || tagVal(l.item.tags, 'offer', 'auto') === auto, `${label(id)} sent with auto ${tagVal(l.item.tags, 'offer', 'auto')}, expected ${auto}`));
};
const offersAre = (reply, ids) => fail(appliedOffers(reply).sort().join() === [...ids].sort().join(), `applied [${appliedOffers(reply).map(label).join()}], expected [${ids.map(label).join()}]`);
// on_init / on_confirm list only the applied offers.
const onlyApplied = (reply) => {
  const listed = breakup(reply).filter((b) => b['@ondc/org/title_type'] === 'offer').map((b) => b['@ondc/org/item_id']).sort().join();
  return fail(listed === appliedOffers(reply).sort().join(), `breakup lists [${listed}], applied [${appliedOffers(reply).map(label).join()}]`);
};
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

const cartText = (s, lines) => lines.map((l) => `${label(l.id)} ${catalogItem(s, l.id)?.descriptor.name ?? ''} × ${l.count}`).join(', ');

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
// The seller deactivates / reactivates the scenario's provider: unsolicited incremental on_search.
const providerStep = (event) => {
  const want = event === 'provider_disable' ? 'disable' : 'enable';
  return {
    // The buyer's catalogue is cached before the seller goes inactive (the full catalogue then leaves it out).
    name: `seller ${want === 'disable' ? 'goes inactive' : 'is active again'} → on_search`, action: 'push', event, callback: 'on_search', needsCatalog: true,
    buyer: (s) => `Nothing to do in the app: the seller ${want === 'disable' ? 'deactivates' : 'reactivates'} ${label(s.providerId)} on its own${want === 'disable' ? ' when the flow starts' : ' once the previous step completes'}. The app receives it and ${want === 'disable' ? 'removes the provider from its catalogue' : 'restores the provider'}.`,
    expect: want === 'disable'
      ? 'Unsolicited on_search (header inc), new transaction: bpp/providers [{ id, time: { label: "disable", timestamp } }] - soft delete of the provider from the buyer\'s cache.'
      : 'Unsolicited on_search (header inc), new transaction: the whole provider record (locations, items, offers, tags) with time.label "enable" - the buyer restores it.',
    build: (env, s) => R.providerPush({ bap: env.bap, providerId: s.providerId, event }),
    ready: () => true,
    check: (reply, s) => {
      const c = reply.callbacks.at(-1);
      const p = c?.body?.message?.catalog?.['bpp/providers']?.[0];
      return all(fail(c?.headers?.['X-ONDC-Search-Response'] === 'inc', 'expected header inc'),
        fail(p?.id === s.providerId && p?.time?.label === want, `expected ${label(s.providerId)} with time.label ${want}, got ${label(p?.id)} ${p?.time?.label}`),
        fail(want === 'disable' ? !p?.items : p?.items?.length > 0, want === 'disable' ? 'disable should carry only id + time' : 'enable should carry the full provider'));
    },
  };
};

// `offers`: offer ids the buyer sends on /select.
const selectStep = ({ lines, offers, expect = 'Serviceable quote.', check, reselect = false, buyer } = {}) => ({
  name: reselect ? 're-select → on_select' : 'select → on_select', action: 'select', expect, needsCatalog: true,
  buyer: buyer ?? ((s) => (reselect
    ? (Array.isArray(lines) ? `Change the cart to ${cartText(s, lines)}: the app sends /select again.` : 'Accept the seller\'s changes to the cart: the app sends /select again.')
    : s.anyItems
      ? `Add any items to the cart${s.mode !== 'normal' ? ` (the seller mode hits ${s.modeItems?.length ? s.modeItems.map(label).join(', ') : 'the first item in the cart'})` : ''} and open it: the app sends /select.`
      : `Add ${cartText(s, lines ?? s.cart)} from ${label(s.providerId)} and open the cart: the app sends /select${offers ? ` with the offer${offers.length > 1 ? 's' : ''} ${offers.map(label).join(' + ')} selected` : ''}.`)),
  build: (env, s) => {
    const req = R.select({
      ...env, catalogProvider: providerOf(s), retailer: s.retailer,
      lines: typeof lines === 'function' ? lines(s) : lines ?? s.cart, offers,
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
    fulfillmentId ? ` with delivery option ${label(fulfillmentId)}` : '',
    paymentType === 'ON-ORDER' ? ', paying online (ON-ORDER)' : '',
    offers ? ` with the offer${offers.length > 1 ? 's' : ''} ${offers.map(label).join(' + ')} selected` : ' keeping the offers on_select applied',
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

const PUSH_LABELS = { packed: 'Packed', out_for_delivery: 'Out for delivery', delivered: 'Delivered', seller_cancel: 'Seller cancels', resend_status: 'Re-send current status', provider_disable: 'Deactivate seller', provider_enable: 'Activate seller' };
const pushStep = (event, name, expect, [orderState, fulfillmentState]) => ({
  name, action: 'push', expect, event, callback: event === 'seller_cancel' ? 'on_cancel' : 'on_status',
  buyer: () => `Nothing to do in the app: the seller sends this on its own (${PUSH_LABELS[event]}) once the previous step completes. The app receives it.`,
  build: (env, s) => R.sellerPush({ onConfirm: s.onConfirm, event }),
  ready: (s) => Boolean(s.onConfirm),
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

// The buyer drops the item the seller can no longer supply and orders the rest - so the cart needs a
// second item that alone meets the minimum order value (see RECOMMENDED).
const removeTargetReselect = (why) => selectStep({
  reselect: true, lines: (s) => R.linesFromQuote(s.onSelect.message.order.quote),
  buyer: (s) => `Remove ${s.target ? label(s.target) : 'the affected item'} (${why}) from the cart, keep the other items and open the cart again: the app sends /select.`,
  expect: (s) => `on_select without ${label(s.target)}: no error.`,
  check: (r, s) => all(fail(!s.selectRequest.message.order.items.some((i) => i.id === s.target), `the cart still has ${label(s.target)} - remove it and select again`), noError(r)),
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
    id: 'search', group: 'Pre-order', title: 'Search', providerId: P1, retailer: SHARMA, cart: [],
    summary: 'Broadcast /search and the full catalogue on_search.',
    steps: [searchStep()],
  },
  {
    id: 'place-order', anyItems: true, group: 'Pre-order', title: 'Place order (positive)', providerId: P1, retailer: SHARMA,
    summary: 'Order any items: select → init (pay on fulfillment, credit for a known retailer) → confirm.',
    steps: [
      selectStep({ expect: 'Serviceable. Two delivery options: F1 Standard Delivery (beat, P2D) and F2 Immediate Delivery (tomorrow, P1D).',
        check: (r) => all(noError(r), fail(order(r).fulfillments.length === 2, 'expected 2 delivery options')) }),
      initStep(),
      confirmStep(),
    ],
  },
  {
    id: 'delivery-tomorrow', anyItems: true, group: 'Pre-order', title: 'Place order - tomorrow delivery', providerId: P1, retailer: SHARMA,
    summary: 'The buyer picks F2 (Immediate Delivery) from on_select instead of the beat day.',
    steps: [
      selectStep({ expect: 'F1 Standard Delivery and F2 Immediate Delivery offered.' }),
      initStep({ fulfillmentId: ID.P1_F2, expect: 'Fulfillment F2 (Immediate Delivery), TAT P1D.',
        check: (r) => all(noError(r), fail(order(r).fulfillments[0].id === ID.P1_F2 && order(r).fulfillments[0]['@ondc/org/TAT'] === 'P1D', 'expected F2 / P1D')) }),
      confirmStep(),
    ],
  },
  {
    id: 'place-order-prepaid', anyItems: true, group: 'Pre-order', title: 'Place order - walk-in, prepaid (P3)', providerId: P3, retailer: WALK_IN_RETAILER,
    summary: 'Order any items and pay online (ON-ORDER): the seller returns its payment link in on_init.',
    steps: [
      selectStep(),
      initStep({ paymentType: 'ON-ORDER', expect: 'payments[0].type ON-ORDER with the seller\'s payment link (uri); no credit tag.',
        check: (r) => all(noError(r), fail(order(r).payments[0].uri, 'expected a payment uri')) }),
      confirmStep(),
    ],
  },
  {
    id: 'item-inactive', anyItems: true, group: 'Pre-order', title: 'Item inactive', providerId: P1, retailer: SHARMA, mode: 'item_inactive',
    summary: 'Two items in the cart; the seller disables one of them (incremental on_search, then on_select with it at qty 0). The buyer removes the inactive item and completes the order with the other.',
    steps: [
      selectStep({ expect: (s) => `First an unsolicited incremental on_search (header inc) with ${label(s.target)} time.label "disable", then on_select with error 40002 and ${label(s.target)} at qty 0.`,
        check: (r, s) => {
          const inc = r.callbacks.find((c) => c.headers?.['X-ONDC-Search-Response'] === 'inc')?.body.message.catalog['bpp/providers'][0].items[0];
          return all(fail(inc?.id === s.target && inc?.time.label === 'disable', `expected an inc on_search disabling ${label(s.target)}`),
            fail(errorCode(r) === '40002' && itemCount(r, s.target) === 0, `expected 40002 with ${label(s.target)} at 0`));
        } }),
      removeTargetReselect('the seller disabled it'),
      initStep(),
      confirmStep(),
    ],
  },
  {
    id: 'out-of-stock', anyItems: true, group: 'Pre-order', title: 'Item out of stock', providerId: P2, retailer: LAKSHMI, mode: 'out_of_stock',
    summary: 'Two items in the cart; the seller has none of one of them left. The buyer removes it and completes the order with the other.',
    steps: [
      selectStep({ expect: (s) => `Error 40002, message [{"item_id":"${label(s.target)}","error":"40002"}]; ${label(s.target)} at qty 0.`,
        check: (r, s) => fail(errorCode(r) === '40002' && itemCount(r, s.target) === 0, `expected 40002 with ${label(s.target)} at 0`) }),
      removeTargetReselect('out of stock'),
      initStep(),
      confirmStep(),
    ],
  },
  {
    id: 'partial-quantity', anyItems: true, group: 'Pre-order', title: 'Partial quantity available', providerId: P1, retailer: SHARMA, mode: 'partial_quantity',
    summary: 'The seller can supply only half of the affected item.',
    steps: [
      selectStep({ expect: (s) => `Error 40002; ${label(s.target)} at ${half(qtyOf(s, s.target))} of ${qtyOf(s, s.target)}.`,
        check: (r, s) => fail(errorCode(r) === '40002' && itemCount(r, s.target) === half(qtyOf(s, s.target)), `expected 40002 with ${label(s.target)} at ${half(qtyOf(s, s.target))}`) }),
      reselectFromQuote('onSelect'),
      initStep(),
      confirmStep(),
    ],
  },
  {
    id: 'price-changed', anyItems: true, group: 'Pre-order', title: 'Price changed', providerId: P2, retailer: LAKSHMI, mode: 'price_changed',
    summary: 'The seller now charges 5% more for the affected item than the catalogue says.',
    steps: [
      selectStep({ expect: (s) => `No error; ${label(s.target)} item.price ${(Math.round(Number(catalogItem(s, s.target).price.value) * 105) / 100).toFixed(2)} instead of ${catalogItem(s, s.target).price.value}.`,
        check: (r, s) => all(noError(r), fail(itemLine(r, s.target)?.item.price.value === (Math.round(Number(catalogItem(s, s.target).price.value) * 105) / 100).toFixed(2), `expected ${label(s.target)} +5%`)) }),
      initStep(),
      confirmStep(),
    ],
  },
  {
    id: 'min-order-value', anyItems: true, cartRule: 'below_mov', mode: 'min_order_value', group: 'Pre-order', title: 'Minimum order value not met', providerId: P2, retailer: LAKSHMI,
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
    id: 'init-qty-reduced', anyItems: true, group: 'Pre-order', title: 'Quantity reduced at init', providerId: P2, retailer: LAKSHMI, mode: 'init_qty_reduced',
    summary: 'Stock of the affected item halves between select and init. on_init returns the lower quantity; the buyer must select again.',
    steps: [
      selectStep({ expect: 'Everything available.' }),
      initStep({ expect: (s) => `No error, but ${label(s.target)} comes back at ${half(qtyOf(s, s.target))} (pre-order-service: CART_UPDATED → re-select).`,
        check: (r, s) => all(noError(r), fail(itemCount(r, s.target) === half(qtyOf(s, s.target)), `expected ${label(s.target)} at ${half(qtyOf(s, s.target))}`)) }),
      reselectFromQuote('onInit'),
      initStep({ name: 're-init → on_init', expect: 'Same quantities as the re-select: no further reduction.' }),
      confirmStep(),
    ],
  },
  {
    id: 'confirm-rejected', anyItems: true, group: 'Pre-order', title: 'Seller rejects confirm', providerId: P2, retailer: LAKSHMI, mode: 'confirm_rejected',
    summary: 'Select and init succeed; the seller cannot confirm the order.',
    steps: [
      selectStep(),
      initStep(),
      confirmStep({ expect: 'on_confirm with error 30019 (pre-order-service marks the order Cancelled).', check: (r) => fail(errorCode(r) === '30019', 'expected 30019') }),
    ],
  },

  // Offers - each offer names its items in the catalogue, so these carts are the qualifying ones.
  {
    id: 'offer-discount', group: 'Offers', title: 'Discount - opt-in (percent)', providerId: P1, retailer: SHARMA,
    cart: [{ id: ID.I1, count: 20 }],
    summary: 'discp10: 10% off Atta (max ₹200), min ₹500, auto = no. on_select lists it without applying it; the buyer selects it at init.',
    steps: [
      selectStep({ expect: 'discp10 listed at -104.00, not applied: quote.price 1040.00.',
        check: (r) => all(noError(r), fail(offerLine(r, ID.discp10)?.price.value === '-104.00', 'expected discp10 -104.00'), fail(order(r).quote.price.value === '1040.00', `quote.price ${order(r).quote.price.value}`)) }),
      initStep({ offers: [ID.discp10], expect: 'Buyer sends offers [discp10]: applied, quote.price 936.00.',
        check: (r) => all(noError(r), quoteAddsUp(r), fail(appliedOffers(r).join() === ID.discp10, `applied ${appliedOffers(r).map(label).join()}`), fail(order(r).quote.price.value === '936.00', `quote.price ${order(r).quote.price.value}`)) }),
      confirmStep(),
    ],
  },
  {
    id: 'offer-flat', group: 'Offers', title: 'Discount - flat amount', providerId: P2, retailer: LAKSHMI,
    cart: [{ id: ID.I9, count: 10 }, { id: ID.I12, count: 10 }],
    summary: 'flat150: ₹150 off Tea & Coffee above ₹1000, auto + additive.',
    steps: [
      selectStep({ expect: 'flat150 at -150.00, applied: quote.price 3750.00.', check: (r) => all(noError(r), fail(offerLine(r, ID.flat150)?.price.value === '-150.00' && order(r).quote.price.value === '3750.00', 'expected flat150 applied')) }),
      initStep({ check: (r) => all(noError(r), quoteAddsUp(r), fail(appliedOffers(r).includes(ID.flat150), 'flat150 not applied')) }),
      confirmStep(),
    ],
  },
  {
    id: 'offer-slab-count', group: 'Offers', title: 'Slab - by quantity', providerId: P1, retailer: SHARMA,
    cart: [{ id: ID.I2, count: 10 }],
    summary: 'Atta 5kg: slab1 5% for 10-19 units (max ₹500), slab2 10% for 20+ units (max ₹1000).',
    steps: [
      selectStep({ expect: '10 units: slab1 at -122.50.', check: (r) => fail(offerLine(r, ID.slab1)?.price.value === '-122.50', 'expected slab1 -122.50') }),
      selectStep({ reselect: true, lines: [{ id: ID.I2, count: 20 }], expect: '20 units: slab2 at -490.00 replaces slab1.', check: (r) => fail(offerLine(r, ID.slab2)?.price.value === '-490.00' && !offerLine(r, ID.slab1), 'expected slab2 only') }),
      initStep({ check: (r) => all(quoteAddsUp(r), fail(appliedOffers(r).includes(ID.slab2), 'slab2 not applied')) }),
      confirmStep(),
    ],
  },
  {
    id: 'offer-slab-weight', group: 'Offers', title: 'Slab - by weight', providerId: P2, retailer: LAKSHMI,
    cart: [{ id: ID.I10, count: 5 }],
    summary: 'Surf Excel: slabw1 4% for 20-49 kg, slabw2 8% for 50+ kg (weight = pack size x quantity).',
    steps: [
      selectStep({ expect: '20 kg: slabw1 at -99.00.', check: (r) => fail(offerLine(r, ID.slabw1)?.price.value === '-99.00', 'expected slabw1 -99.00') }),
      selectStep({ reselect: true, lines: [{ id: ID.I10, count: 13 }], expect: '52 kg: slabw2 at -514.80.', check: (r) => fail(offerLine(r, ID.slabw2)?.price.value === '-514.80', 'expected slabw2 -514.80') }),
      initStep({ check: (r) => all(quoteAddsUp(r), fail(appliedOffers(r).includes(ID.slabw2), 'slabw2 not applied')) }),
      confirmStep(),
    ],
  },
  {
    id: 'offer-slab-value', group: 'Offers', title: 'Slab - by value', providerId: P3, retailer: WALK_IN_RETAILER,
    cart: [{ id: ID.I19, count: 6 }],
    summary: 'slabv1: 3% off Appy Fizz worth ₹5000+ (max ₹1000), auto + additive.',
    steps: [
      selectStep({ expect: '₹5040 of Appy Fizz: slabv1 at -151.20.', check: (r) => fail(offerLine(r, ID.slabv1)?.price.value === '-151.20', 'expected slabv1 -151.20') }),
      initStep({ check: (r) => all(quoteAddsUp(r), fail(appliedOffers(r).includes(ID.slabv1), 'slabv1 not applied')) }),
      confirmStep(),
    ],
  },
  {
    id: 'offer-freebie', group: 'Offers', title: 'Freebie', providerId: P1, retailer: SHARMA,
    cart: [{ id: ID.I6, count: 10 }],
    summary: 'freebie1: buy 10 Dark Fantasy, get 1 Bingo Mad Angles free.',
    steps: [
      selectStep({ expect: 'freebie1 applied at -380.00 (1 × I7 at its item_value 380.00), item_quantity 1, offer tag item_id I7, item_count 1: quote.price 3220.00.',
        check: (r) => all(fail(tagVal(offerLine(r, ID.freebie1)?.item.tags, 'offer', 'item_id') === ID.I7, 'expected freebie1 with I7'), offerIs(r, ID.freebie1, '-380.00', 'yes'), priceIs(r, '3220.00')) }),
      initStep({ check: (r) => all(quoteAddsUp(r), fail(appliedOffers(r).includes(ID.freebie1), 'freebie1 not applied')) }),
      confirmStep(),
    ],
  },
  {
    id: 'offer-buyxgety', group: 'Offers', title: 'Buy X get Y', providerId: P3, retailer: WALK_IN_RETAILER,
    cart: [{ id: ID.I16, count: 6 }],
    summary: 'buy2get1: buy 2+ cases of Frooti 200ml, get 1 free. Worth the free item\'s unit price × the benefit item_count (not per multiple of 2).',
    steps: [
      selectStep({ expect: '6 cases: buy2get1 applied at -300.00 (1 × I16 at its cart price 300.00), item_count 1: quote.price 1500.00.',
        check: (r) => all(fail(tagVal(offerLine(r, ID.buy2get1)?.item.tags, 'offer', 'item_count') === '1', 'expected 1 free'), offerIs(r, ID.buy2get1, '-300.00', 'yes'), priceIs(r, '1500.00')) }),
      initStep({ check: (r) => all(quoteAddsUp(r), fail(appliedOffers(r).includes(ID.buy2get1), 'buy2get1 not applied')) }),
      confirmStep(),
    ],
  },
  {
    id: 'offer-combo', group: 'Offers', title: 'Combo', providerId: P1, retailer: SHARMA,
    cart: [{ id: ID.I1, count: 20 }, { id: ID.I4, count: 5 }, { id: ID.I5, count: 3 }],
    summary: 'combo1: Atta (I1 or I2) + both B Natural packs (I4 and I5) → 50% off, max ₹200.',
    steps: [
      selectStep({ expect: 'combo1 at -200.00 (capped).', check: (r) => fail(offerLine(r, ID.combo1)?.price.value === '-200.00', 'expected combo1 -200.00') }),
      initStep({ check: (r) => all(quoteAddsUp(r), fail(appliedOffers(r).includes(ID.combo1), 'combo1 not applied')) }),
      confirmStep(),
    ],
  },
  {
    id: 'offer-stacking', group: 'Offers', title: 'Init - exclusive blocks additive', providerId: P1, retailer: SHARMA,
    cart: [{ id: ID.I2, count: 20 }, { id: ID.I6, count: 10 }],
    summary: 'The cart qualifies for slab2 and freebie1 (auto, exclusive) and discp10 (opt-in, additive). An exclusive offer blocks every other one, additive ones included.',
    steps: [
      selectStep({ expect: 'All three listed. Applied: slab2 only (the best auto exclusive, -490.00); freebie1 sent as auto = no: quote.price 8010.00.',
        check: (r) => all(fail([ID.slab2, ID.freebie1, ID.discp10].every((id) => offerLine(r, id)), 'expected slab2, freebie1 and discp10 listed'), offerIs(r, ID.freebie1, '-380.00', 'no'), priceIs(r, '8010.00')) }),
      initStep({ offers: [ID.freebie1, ID.discp10], expect: 'Buyer sends freebie1 + discp10: freebie1 is exclusive, so only freebie1 applies (discp10 blocked, slab2 not sent): quote.price 8120.00.',
        check: (r) => all(quoteAddsUp(r), onlyApplied(r), offersAre(r, [ID.freebie1]), priceIs(r, '8120.00')) }),
      confirmStep(),
    ],
  },
  // The on_select scenarios of the retail-seller-service offers flow (OFFERS-FLOW.md, 1-9).
  {
    id: 'offer-auto-priority', group: 'Offers', title: 'Select 1 - no ids: auto additive beats auto exclusive', providerId: P2, retailer: LAKSHMI,
    cart: [{ id: ID.I10, count: 5 }, { id: ID.I12, count: 10 }],
    summary: 'flat150 (auto, additive) and slabw1 (auto, exclusive) both qualify; the buyer sends no offer ids. Auto additive offers take priority.',
    steps: [
      selectStep({ expect: 'flat150 applied (-150.00, auto yes); slabw1 listed at -99.00 but sent as auto = no: quote.price 4925.00.',
        check: (r) => all(noError(r), offerIs(r, ID.flat150, '-150.00', 'yes'), offerIs(r, ID.slabw1, '-99.00', 'no'), priceIs(r, '4925.00')) }),
      initStep({ expect: 'The buyer carries flat150 forward: only flat150 applied, quote.price 4925.00.', check: (r) => all(quoteAddsUp(r), onlyApplied(r), offersAre(r, [ID.flat150]), priceIs(r, '4925.00')) }),
      confirmStep(),
    ],
  },
  {
    id: 'offer-optin-additive', group: 'Offers', title: 'Select 2 - buyer adds an opt-in additive offer', providerId: P2, retailer: LAKSHMI,
    cart: [{ id: ID.I10, count: 5 }, { id: ID.I12, count: 10 }, { id: ID.I15, count: 2 }],
    summary: 'The buyer sends disc5 (opt-in, additive) on /select: it stacks with flat150 (auto, additive). slabw1 (auto, exclusive) loses.',
    steps: [
      selectStep({ offers: [ID.disc5], expect: 'flat150 (-150.00) + disc5 (-52.00) applied, both auto = yes; slabw1 sent as auto = no: quote.price 5913.00.',
        check: (r) => all(noError(r), offerIs(r, ID.flat150, '-150.00', 'yes'), offerIs(r, ID.disc5, '-52.00', 'yes'), offerIs(r, ID.slabw1, '-99.00', 'no'), priceIs(r, '5913.00')) }),
      initStep({ expect: 'Buyer sends flat150 + disc5: both applied, quote.price 5913.00.', check: (r) => all(quoteAddsUp(r), onlyApplied(r), offersAre(r, [ID.flat150, ID.disc5]), priceIs(r, '5913.00')) }),
      confirmStep(),
    ],
  },
  {
    id: 'offer-optin-exclusive', group: 'Offers', title: 'Select 3 - buyer picks an exclusive offer', providerId: P2, retailer: LAKSHMI,
    cart: [{ id: ID.I10, count: 6 }, { id: ID.I12, count: 10 }],
    summary: 'The buyer sends excl300 (opt-in, exclusive): it blocks every other offer, the auto ones included.',
    steps: [
      selectStep({ offers: [ID.excl300], expect: 'Only excl300 applied (-300.00, auto = yes); flat150 (-150.00) and slabw1 (-118.80) listed with auto = no: quote.price 5270.00.',
        check: (r) => all(noError(r), offerIs(r, ID.excl300, '-300.00', 'yes'), offerIs(r, ID.flat150, '-150.00', 'no'), offerIs(r, ID.slabw1, '-118.80', 'no'), priceIs(r, '5270.00')) }),
      initStep({ expect: 'Buyer sends excl300: applied alone, quote.price 5270.00.', check: (r) => all(quoteAddsUp(r), onlyApplied(r), offersAre(r, [ID.excl300]), priceIs(r, '5270.00')) }),
      confirmStep(),
    ],
  },
  {
    id: 'offer-mixed-selection', group: 'Offers', title: 'Select 4 - several exclusive + additive ids', providerId: P2, retailer: LAKSHMI,
    cart: [{ id: ID.I10, count: 6 }, { id: ID.I12, count: 10 }, { id: ID.I15, count: 2 }],
    summary: 'The buyer sends slabw1 + excl300 (both exclusive) + disc5 (additive). The exclusive with the highest discount wins and blocks the rest.',
    steps: [
      selectStep({ offers: [ID.slabw1, ID.excl300, ID.disc5], expect: 'Only excl300 applied (-300.00 beats slabw1 -118.80); disc5 and flat150 blocked: quote.price 6310.00.',
        check: (r) => all(noError(r), offerIs(r, ID.excl300, '-300.00', 'yes'), offerIs(r, ID.slabw1, '-118.80', 'no'), offerIs(r, ID.flat150, '-150.00', 'no'), offerIs(r, ID.disc5, '-52.00', 'no'), priceIs(r, '6310.00')) }),
      initStep({ offers: [ID.excl300, ID.disc5], expect: 'Buyer sends excl300 + disc5 at init: excl300 alone, quote.price 6310.00.', check: (r) => all(quoteAddsUp(r), onlyApplied(r), offersAre(r, [ID.excl300]), priceIs(r, '6310.00')) }),
      confirmStep(),
    ],
  },
  {
    id: 'offer-optin-stack', group: 'Offers', title: 'Select 5 - only opt-in additive offers', providerId: P1, retailer: SHARMA,
    cart: [{ id: ID.I1, count: 20 }, { id: ID.I8, count: 2 }],
    summary: 'No auto offer qualifies. The buyer sends discp10 + flat50 (both opt-in, additive): they stack.',
    steps: [
      selectStep({ offers: [ID.discp10, ID.flat50], expect: 'discp10 (-104.00) + flat50 (-50.00) applied, both auto = yes: quote.price 3086.00.',
        check: (r) => all(noError(r), offerIs(r, ID.discp10, '-104.00', 'yes'), offerIs(r, ID.flat50, '-50.00', 'yes'), priceIs(r, '3086.00')) }),
      initStep({ expect: 'Buyer sends discp10 + flat50: both applied.', check: (r) => all(quoteAddsUp(r), onlyApplied(r), offersAre(r, [ID.discp10, ID.flat50]), priceIs(r, '3086.00')) }),
      confirmStep(),
    ],
  },
  {
    id: 'offer-only-auto-exclusive', group: 'Offers', title: 'Select 6 - only an auto exclusive offer', providerId: P1, retailer: SHARMA,
    cart: [{ id: ID.I2, count: 10 }],
    summary: 'slab1 (auto, exclusive) is the only auto offer; discp10 (opt-in) also qualifies. No ids sent: slab1 is auto-applied.',
    steps: [
      selectStep({ expect: 'slab1 applied (-122.50, auto yes); discp10 listed at -200.00 (auto no): quote.price 2327.50.',
        check: (r) => all(noError(r), offerIs(r, ID.slab1, '-122.50', 'yes'), offerIs(r, ID.discp10, '-200.00', 'no'), priceIs(r, '2327.50')) }),
      initStep({ expect: 'Buyer carries slab1 forward: quote.price 2327.50.', check: (r) => all(quoteAddsUp(r), onlyApplied(r), offersAre(r, [ID.slab1]), priceIs(r, '2327.50')) }),
      confirmStep(),
    ],
  },
  {
    id: 'offer-buyer-overrides-auto', group: 'Offers', title: 'Select 7 - buyer exclusive overrides a bigger auto exclusive', providerId: P2, retailer: LAKSHMI,
    cart: [{ id: ID.I10, count: 13 }],
    summary: '52 kg of Surf Excel: slabw2 (auto, exclusive, -514.80) and excl300 (opt-in, exclusive, -300.00). The buyer sends excl300: its choice wins although slabw2 is bigger.',
    steps: [
      selectStep({ offers: [ID.excl300], expect: 'excl300 applied (-300.00, auto = yes); slabw2 listed at -514.80 with auto = no: quote.price 6135.00.',
        check: (r) => all(noError(r), offerIs(r, ID.excl300, '-300.00', 'yes'), offerIs(r, ID.slabw2, '-514.80', 'no'), priceIs(r, '6135.00')) }),
      initStep({ expect: 'Buyer sends excl300: quote.price 6135.00.', check: (r) => all(quoteAddsUp(r), onlyApplied(r), offersAre(r, [ID.excl300]), priceIs(r, '6135.00')) }),
      confirmStep(),
    ],
  },
  {
    id: 'offer-optin-over-auto-exclusive', group: 'Offers', title: 'Select 8 - opt-in additive over an auto exclusive', providerId: P1, retailer: SHARMA,
    cart: [{ id: ID.I2, count: 10 }],
    summary: 'The only auto offer is slab1 (exclusive). The buyer sends discp10 (opt-in, additive): its choice wins, slab1 is downgraded.',
    steps: [
      selectStep({ offers: [ID.discp10], expect: 'discp10 applied (-200.00, capped, auto = yes); slab1 listed at -122.50 with auto = no: quote.price 2250.00.',
        check: (r) => all(noError(r), offerIs(r, ID.discp10, '-200.00', 'yes'), offerIs(r, ID.slab1, '-122.50', 'no'), priceIs(r, '2250.00')) }),
      initStep({ expect: 'Buyer sends discp10: quote.price 2250.00.', check: (r) => all(quoteAddsUp(r), onlyApplied(r), offersAre(r, [ID.discp10]), priceIs(r, '2250.00')) }),
      confirmStep(),
    ],
  },
  {
    id: 'offer-best-auto-exclusive', group: 'Offers', title: 'Select 9 - several auto exclusive: best wins', providerId: P1, retailer: SHARMA,
    cart: [{ id: ID.I2, count: 20 }, { id: ID.I6, count: 10 }, { id: ID.I4, count: 5 }, { id: ID.I5, count: 3 }],
    summary: 'slab2 (-490.00), freebie1 (-380.00) and combo1 (-200.00) are all auto + exclusive; no ids sent. The highest discount applies.',
    steps: [
      selectStep({ expect: 'slab2 applied (auto yes); freebie1 and combo1 listed with auto = no: quote.price 12480.00.',
        check: (r) => all(noError(r), offerIs(r, ID.slab2, '-490.00', 'yes'), offerIs(r, ID.freebie1, '-380.00', 'no'), offerIs(r, ID.combo1, '-200.00', 'no'), priceIs(r, '12480.00')) }),
      initStep({ expect: 'Buyer carries slab2 forward: quote.price 12480.00.', check: (r) => all(quoteAddsUp(r), onlyApplied(r), offersAre(r, [ID.slab2]), priceIs(r, '12480.00')) }),
      confirmStep(),
    ],
  },
  // Edge cases of the offers flow.
  {
    id: 'offer-invalid-ids', group: 'Offers', title: 'Edge - unknown, expired and duplicate ids', providerId: P1, retailer: SHARMA,
    cart: [{ id: ID.I1, count: 20 }],
    summary: 'The buyer sends discp10 twice, expired1 (published but expired) and an unknown id. Invalid ids are skipped silently; discp10 applies once.',
    steps: [
      selectStep({ offers: [ID.discp10, ID.discp10, ID.expired1, 'NOPE'], expect: 'No error. discp10 applied once (-104.00); expired1 not listed: quote.price 936.00.',
        check: (r) => all(noError(r), offerIs(r, ID.discp10, '-104.00', 'yes'), fail(!offerLine(r, ID.expired1), 'expired1 listed'), priceIs(r, '936.00')) }),
      initStep({ offers: [ID.discp10, ID.discp10, ID.expired1, 'NOPE'], expect: 'No error. Only discp10 applied: quote.price 936.00.',
        check: (r) => all(noError(r), quoteAddsUp(r), offersAre(r, [ID.discp10]), priceIs(r, '936.00')) }),
      confirmStep(),
    ],
  },
  {
    id: 'offer-cart-changed', group: 'Offers', title: 'Edge - cart changes after select', providerId: P1, retailer: SHARMA,
    cart: [{ id: ID.I2, count: 20 }],
    summary: 'on_select applies slab2 for 20 units; the buyer drops to 12 units but still sends slab2 at init. Offers are re-evaluated on the new cart.',
    steps: [
      selectStep({ expect: 'slab2 applied (-490.00): quote.price 4410.00.', check: (r) => all(offerIs(r, ID.slab2, '-490.00', 'yes'), priceIs(r, '4410.00')) }),
      selectStep({ reselect: true, lines: [{ id: ID.I2, count: 12 }], expect: '12 units: slab1 applied (-147.00), slab2 gone: quote.price 2793.00.',
        check: (r) => all(offerIs(r, ID.slab1, '-147.00', 'yes'), fail(!offerLine(r, ID.slab2), 'slab2 still listed'), priceIs(r, '2793.00')) }),
      initStep({ offers: [ID.slab2], expect: 'Buyer sends the stale slab2: dropped, no offer applied: quote.price 2940.00.',
        check: (r) => all(noError(r), quoteAddsUp(r), offersAre(r, []), priceIs(r, '2940.00')) }),
      confirmStep(),
    ],
  },

  // Retailer identification (P2P) - optional: the catalogue publishes no retailer_info_required.
  {
    id: 'p2p-customer-id', group: 'Retailer (P2P)', title: 'Existing retailer - customer_id', providerId: P1, retailer: SHARMA, cart: [],
    summary: 'If a buyer NP sends a P2P search, the seller returns the retailer\'s terms by outlet code.',
    steps: [p2pStep('search (P2P) → on_search', (env) => R.searchP2PWithCustomerId({ ...env, providerId: P1, customerId: SHARMA.customer_id }),
      'Header p2p. P1 with credit 25000.00, POC, customer.id and offers with scheme_progress (discp10: target 100, remaining 35).',
      (r) => fail(cbBody(r).message.catalog['bpp/providers'][0].offers?.some((o) => o.id === ID.discp10 && tagVal(o.tags, 'scheme_progress', 'remaining_quantity') === '35'), 'expected discp10 scheme progress'))],
  },
  {
    id: 'p2p-phone-pan', group: 'Retailer (P2P)', title: 'Existing retailer - phone + PAN', providerId: P2, retailer: { ...LAKSHMI, customer_id: undefined }, cart: [],
    summary: 'The retailer does not know their outlet code; the seller resolves them from phone + PAN.',
    steps: [p2pStep('search (P2P) → on_search', (env) => R.searchP2PWithoutCustomerId({ ...env, providerId: P2, phone: LAKSHMI.phone, pan: LAKSHMI.PAN, gstin: LAKSHMI.GSTIN }),
      `P2 returns customer.id ${LAKSHMI.customer_id}.`)],
  },
  {
    id: 'p2p-new-retailer', group: 'Retailer (P2P)', title: 'New retailer registration', providerId: P1, retailer: NEW_RETAILER, cart: [],
    summary: 'Ravi Provision Store registers with P1.',
    steps: [p2pStep('search (P2P, new retailer) → on_search', (env) => R.searchP2PNewRetailer({ ...env, providerId: P1, retailer: NEW_RETAILER }),
      'First callback: creation pending (POC only). Second, ~5s later and unsolicited: credit + customer.id CUST-NEW-122233.')],
  },

  // Seller (provider) inactive / active again
  {
    id: 'seller-inactive', group: 'Pre-order', title: 'Seller inactive, then active again', providerId: P1, retailer: SHARMA, cart: [{ id: ID.I1, count: 20 }],
    summary: 'The seller deactivates P1 (incremental on_search, time.label disable): orders on it get 30021 Merchant inactive. It then reactivates P1 (time.label enable, whole provider) and the order goes through.',
    steps: [
      providerStep('provider_disable'),
      selectStep({ buyer: () => 'Try to order from P1 anyway (e.g. from a cart built before): the app sends /select.', expect: 'on_select with error 30021 (Merchant inactive) - the provider takes no orders.',
        check: (r) => fail(errorCode(r) === '30021', `expected 30021, got ${errorCode(r) ?? 'no error'}`) }),
      providerStep('provider_enable'),
      selectStep({ reselect: true, buyer: () => 'Order from P1 again: the app sends /select.', expect: 'Serviceable quote, no error.', check: noError }),
      initStep(),
      confirmStep(),
    ],
  },

  // Post-order
  {
    id: 'post-order', anyItems: true, group: 'Post-order', title: 'Post-order: status and delivery', providerId: P1, retailer: SHARMA,
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
    id: 'buyer-cancel', anyItems: true, group: 'Post-order', title: 'Buyer cancels order', providerId: P1, retailer: SHARMA,
    summary: 'The retailer cancels a confirmed order (reason 053, as pre-order-service sends).',
    steps: [...placeOrder(), cancelStep()],
  },
  {
    id: 'seller-cancel', anyItems: true, group: 'Post-order', title: 'Seller cancels order', providerId: P1, retailer: SHARMA,
    summary: 'The distributor cancels a confirmed order on its own (unsolicited on_cancel, reason 005).',
    steps: [
      ...placeOrder(),
      pushStep('seller_cancel', 'seller cancels → on_cancel', 'Unsolicited: order Cancelled, reason 005 - pre-order-service records it as cancelled by the SELLER.', ['Cancelled', 'Cancelled']),
    ],
  },
];

// ---- recommended carts ------------------------------------------------------------------------
// What to put in the cart so each flow completes smoothly. Any-items flows work with any cart, but
// some need a particular shape: `target` is the item the seller mode hits (armed with ▶), and the
// other items alone stay at or above their MOQ and the seller's minimum order value
// (P1 ₹500, P2 ₹2000, P3 ₹1500), so the order still goes through after the seller removes or
// reduces the target. Flows with a fixed cart (offers, seller inactive) recommend that cart.
const RECOMMENDED = {
  'place-order': { lines: [{ id: ID.I1, count: 20 }, { id: ID.I6, count: 5 }] },
  'delivery-tomorrow': { lines: [{ id: ID.I1, count: 20 }, { id: ID.I6, count: 5 }] },
  'place-order-prepaid': { lines: [{ id: ID.I16, count: 5 }, { id: ID.I20, count: 10 }] },
  'item-inactive': { lines: [{ id: ID.I7, count: 5 }, { id: ID.I1, count: 20 }], target: ID.I7,
    note: 'Add both items: I7 goes inactive, I1 alone (₹1040) still meets P1\'s ₹500 minimum, so the order goes through without I7. With one item only, the cart is empty after removing it.' },
  'out-of-stock': { lines: [{ id: ID.I13, count: 10 }, { id: ID.I10, count: 5 }], target: ID.I13,
    note: 'Add both items: I13 runs out, I10 alone (₹2475) still meets P2\'s ₹2000 minimum.' },
  'partial-quantity': { lines: [{ id: ID.I1, count: 40 }, { id: ID.I6, count: 5 }], target: ID.I1,
    note: 'I1 × 40 comes back at 20 - still its MOQ (20), so the re-select is valid.' },
  'price-changed': { lines: [{ id: ID.I12, count: 10 }, { id: ID.I9, count: 10 }], target: ID.I12,
    note: 'I12 comes back at 5% more (273.00 instead of 260.00).' },
  'min-order-value': { lines: [{ id: ID.I9, count: 10 }],
    note: 'I9 × 10 is ₹1300, below P2\'s ₹2000 minimum. After the 30023, raise I9 to 20 (₹2600) and select again.' },
  'init-qty-reduced': { lines: [{ id: ID.I10, count: 10 }, { id: ID.I12, count: 10 }], target: ID.I10,
    note: 'I10 × 10 comes back at 5 in on_init - still its MOQ (5). Re-select with 5, then init again.' },
  'confirm-rejected': { lines: [{ id: ID.I12, count: 10 }, { id: ID.I13, count: 10 }] },
  'post-order': { lines: [{ id: ID.I1, count: 20 }, { id: ID.I6, count: 5 }] },
  'buyer-cancel': { lines: [{ id: ID.I1, count: 20 }, { id: ID.I6, count: 5 }] },
  'seller-cancel': { lines: [{ id: ID.I1, count: 20 }, { id: ID.I6, count: 5 }] },
  'seller-inactive': { lines: [{ id: ID.I1, count: 20 }],
    note: 'Build the cart before you press ▶ (or from your cached catalogue): P1 is deactivated as soon as the flow starts.' },
};
for (const sc of SCENARIOS) sc.recommend = RECOMMENDED[sc.id] ?? (sc.cart?.length ? { lines: sc.cart } : null);

// The recommended cart priced from the catalogue, and what to do in the app at each step with it.
export function recommendation(sc, catalog) {
  const rec = sc.recommend;
  const provider = catalog?.find((p) => p.id === sc.providerId);
  if (!rec || !provider) return null;
  const state = newState({ ...sc, anyItems: false }, { cart: rec.lines, target: rec.target });
  Object.assign(state, { catalog, modeItems: rec.target ? [rec.target] : [] });
  const lines = rec.lines.map((l) => {
    const item = provider.items.find((i) => i.id === l.id);
    return { id: l.id, name: item?.descriptor.name, count: l.count, price: item?.price.value, moq: item?.quantity.minimum.count,
      total: (Number(item?.price.value ?? 0) * l.count).toFixed(2), target: l.id === rec.target };
  });
  const steps = sc.steps.map((step) => {
    try { return { buyer: step.buyer(state), expect: expectText(step, state) }; } catch { return { buyer: '', expect: '' }; }
  });
  return {
    provider: { id: provider.id, name: provider.descriptor.name }, retailer: sc.retailer, lines, target: rec.target, note: rec.note, steps,
    value: lines.reduce((t, l) => t + Number(l.total), 0).toFixed(2), minValue: tagVal(provider.tags, 'order_value', 'min_value'),
  };
}

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
