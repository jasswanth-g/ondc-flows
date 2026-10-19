// Buyer-side request builders for every positive scenario. Plain ES module with no dependencies:
// the playground imports it in the browser and the test suite imports it in Node. Each step of an
// order journey is built from the previous on_* response, the way a real buyer NP must.

export const BAP = { id: 'buyer-np.com', uri: 'https://buyer-np.com/ondc' };

const uuid = () => globalThis.crypto.randomUUID();

export function context(action, { bap = BAP, bpp, transactionId = uuid(), city = 'std:080' } = {}) {
  const ctx = {
    domain: 'ONDC:RETeB2B',
    action,
    country: 'IND',
    city,
    core_version: '1.2.5',
    bap_id: bap.id,
    bap_uri: bap.uri,
  };
  if (bpp) Object.assign(ctx, { bpp_id: bpp.id, bpp_uri: bpp.uri });
  return Object.assign(ctx, { transaction_id: transactionId, message_id: uuid(), timestamp: new Date().toISOString(), ttl: 'PT30S' });
}

const BAP_TERMS = {
  code: 'bap_terms',
  list: [
    { code: 'static_terms', value: '' },
    { code: 'static_terms_new', value: 'https://github.com/ONDC-Official/NP-Static-Terms/buyerNP_BNP/1.0/tc.pdf' },
    { code: 'effective_date', value: '2025-02-01T00:00:00.000Z' },
  ],
};

// ---- Search ---------------------------------------------------------------------------------

// Broadcast (via gateway): no bpp_id/bpp_uri, no customer. Optional category narrows the catalogue.
export function searchBroadcast({ category, ...opts } = {}) {
  const intent = {};
  if (category) intent.category = { id: category };
  intent.fulfillment = { type: 'Delivery' };
  intent.payment = { '@ondc/org/buyer_app_finder_fee_type': 'percent', '@ondc/org/buyer_app_finder_fee_amount': '3.54' };
  intent.tags = [
    BAP_TERMS,
    { code: 'bap_features', list: ['01A', '0091', '0092', '0093', '0094'].map((code) => ({ code, value: 'yes' })) },
  ];
  return { context: context('search', opts), message: { intent } };
}

const incSearch = (list, opts) => ({
  context: { ...context('search', opts), city: '*' },
  message: {
    intent: {
      payment: { '@ondc/org/buyer_app_finder_fee_type': 'percent', '@ondc/org/buyer_app_finder_fee_amount': '3.54' },
      tags: [{ code: 'catalog_inc', list }, BAP_TERMS],
    },
  },
});

export function searchIncrementalPull({ hoursBack = 1, ...opts } = {}) {
  const end = new Date();
  const start = new Date(end.getTime() - hoursBack * 3600_000);
  return incSearch([{ code: 'start_time', value: start.toISOString() }, { code: 'end_time', value: end.toISOString() }], opts);
}
export const searchIncrementalStart = (opts = {}) => incSearch([{ code: 'mode', value: 'start' }], opts);
export function searchIncrementalStop(opts = {}) {
  const req = incSearch([{ code: 'mode', value: 'stop' }], opts);
  req.message.intent.tags = req.message.intent.tags.filter((t) => t.code === 'catalog_inc');
  return req;
}

// P2P: targeted at the Seller NP (bpp_id/bpp_uri) and carrying a retailer identity.
function p2p(intent, opts) {
  return { context: context('search', opts), message: { intent } };
}

export function searchP2PWithCustomerId({ providerId, customerId, ...opts }) {
  const intent = {};
  if (providerId) intent.provider = { id: providerId };
  intent.fulfillment = { type: 'Delivery', customer: { id: customerId } };
  return p2p(intent, opts);
}

export function searchP2PWithoutCustomerId({ providerId, phone, pan, gstin, ...opts }) {
  const creds = [];
  if (gstin) creds.push({ id: gstin, type: 'GSTIN' });
  if (pan) creds.push({ id: pan, type: 'PAN' });
  const intent = {};
  if (providerId) intent.provider = { id: providerId };
  intent.fulfillment = { type: 'Delivery', customer: { person: { creds }, contact: { phone } } };
  return p2p(intent, opts);
}

export function searchP2PNewRetailer({ providerId, retailer, ...opts }) {
  const creds = [];
  if (retailer.GSTIN) creds.push({ id: retailer.GSTIN, type: 'GSTIN' });
  if (retailer.PAN) creds.push({ id: retailer.PAN, type: 'PAN' });
  const intent = {};
  if (providerId) intent.provider = { id: providerId };
  intent.fulfillment = {
    type: 'Delivery',
    customer: {
      person: { creds },
      organization: { descriptor: { name: retailer.shop_name }, address: retailer.addressLine, city: { code: 'std:080' }, state: { code: 'KA' } },
      contact: { phone: retailer.phone, email: retailer.email },
    },
  };
  return p2p(intent, opts);
}

// Many retailers at once: one retailer_mapping block per retailer (codes of a type=existing variant).
export function searchRetailerMapping({ retailers, ...opts }) {
  const tags = retailers.map((codes) => ({ code: 'retailer_mapping', list: Object.entries(codes).map(([code, value]) => ({ code, value })) }));
  const req = p2p({ tags }, opts);
  req.context.ttl = 'PT60S';
  return req;
}

// ---- Order flow -----------------------------------------------------------------------------

// Customer block for fulfillments. A retailer of a provider without retailer_info_required has no id.
function customerBlock(retailer) {
  const c = {};
  if (retailer.customer_id) c.id = retailer.customer_id;
  const creds = [];
  if (retailer.GSTIN) creds.push({ id: retailer.GSTIN, type: 'GSTIN' });
  if (retailer.PAN) creds.push({ id: retailer.PAN, type: 'PAN' });
  if (creds.length) c.person = { creds };
  c.organization = { descriptor: { name: retailer.shop_name }, address: retailer.addressLine, city: { code: 'std:080' }, state: { code: 'KA' } };
  c.contact = { phone: retailer.phone, email: retailer.email };
  return c;
}

const offerRefs = (offers) => (offers?.length ? { offers: offers.map((id) => ({ id })) } : {});

// /select from a cached catalogue provider. `lines` is [{ id, count }]; count defaults to the item MOQ.
// `offers` are offer ids the buyer chose (they win over auto offers). `transactionId` keeps a re-select on the same transaction.
export function select({ catalogProvider, lines, retailer, offers, transactionId, ...opts }) {
  const items = lines.map(({ id, count }) => {
    const item = catalogProvider.items.find((i) => i.id === id);
    return { id, location_id: item.location_id, quantity: { count: count ?? Number(item.quantity.minimum.count) } };
  });
  return {
    context: context('select', { ...opts, ...(transactionId ? { transactionId } : {}) }),
    message: {
      order: {
        provider: {
          id: catalogProvider.id,
          descriptor: catalogProvider.descriptor && { name: catalogProvider.descriptor.name, code: catalogProvider.descriptor.code, short_desc: catalogProvider.descriptor.short_desc },
          locations: [...new Set(items.map((i) => i.location_id))].map((id) => ({ id })),
        },
        items,
        ...offerRefs(offers),
        fulfillments: [{ customer: customerBlock(retailer), end: { location: { gps: retailer.gps, address: { area_code: retailer.address.area_code } } } }],
      },
    },
  };
}

// Item lines a buyer would re-select after an on_select / on_init: the quantities the seller can
// fulfil, dropping items it cannot supply at all.
export const linesFromQuote = (quote) =>
  quote.breakup
    .filter((b) => b['@ondc/org/title_type'] === 'item' && b['@ondc/org/item_quantity'].count > 0)
    .map((b) => ({ id: b['@ondc/org/item_id'], count: b['@ondc/org/item_quantity'].count }));

// The offers on_select applied, read from its offer lines: an applied auto offer keeps auto = yes
// (a losing one is sent as auto = no). Of the ids the buyer sent on /select, the best exclusive one
// wins alone, else they stack with the auto ones. A buyer's default selection for /init, which
// applies only the ids it is sent.
export function appliedOnSelect(onSelect, selectedIds = []) {
  const lines = onSelect.message.order.quote.breakup
    .filter((b) => b['@ondc/org/title_type'] === 'offer')
    .map((b) => ({ id: b['@ondc/org/item_id'], value: Number(b.price.value), ...Object.fromEntries((b.item.tags.find((t) => t.code === 'offer')?.list ?? []).map((e) => [e.code, e.value])) }));
  const selected = lines.filter((l) => selectedIds.includes(l.id));
  const exclusive = selected.filter((l) => l.additive === 'no').sort((x, y) => x.value - y.value);
  if (exclusive.length) return [exclusive[0].id];
  return [...new Set([...lines.filter((l) => l.auto === 'yes').map((l) => l.id), ...selected.map((l) => l.id)])];
}

// /init from /select + /on_select. Billing timestamps are fixed here and must be echoed unchanged.
// `fulfillmentId` picks one of the on_select delivery options (default: the first).
// `offers` is the buyer's offer selection (default: the offers on_select applied).
export function init({ selectRequest, onSelect, retailer, paymentType = 'ON-FULFILLMENT', fulfillmentId, offers, ...opts }) {
  const sel = selectRequest.message.order;
  const os = onSelect.message.order;
  const now = new Date().toISOString();
  const fulfillment = { id: fulfillmentId ?? os.fulfillments[0].id, type: 'Delivery' };
  if (retailer.customer_id) fulfillment.customer = { id: retailer.customer_id };
  fulfillment.end = { location: { gps: retailer.gps, address: retailer.address }, contact: { phone: retailer.phone } };
  return {
    context: context('init', { ...opts, transactionId: selectRequest.context.transaction_id }),
    message: {
      order: {
        provider: { id: os.provider.id, descriptor: os.provider.descriptor, locations: os.provider.locations },
        items: sel.items.map((i) => ({ id: i.id, fulfillment_id: fulfillment.id, quantity: i.quantity })),
        ...offerRefs(offers ?? appliedOnSelect(onSelect, (selectRequest.message.order.offers ?? []).map((o) => o.id))),
        billing: {
          name: retailer.shop_name,
          address: retailer.address,
          tax_number: retailer.GSTIN,
          email: retailer.email,
          phone: retailer.phone,
          created_at: now,
          updated_at: now,
        },
        payments: [{ type: paymentType, collected_by: 'BPP' }],
        fulfillments: [fulfillment],
      },
    },
  };
}

// /confirm from /on_init (+ the TAT the chosen on_select fulfillment quoted, which must not change).
export function confirm({ onInit, onSelect, retailer, orderId, ...opts }) {
  const o = onInit.message.order;
  const now = new Date().toISOString();
  const pay = o.payments[0];
  const chosen = onSelect.message.order.fulfillments.find((f) => f.id === o.fulfillments[0].id) ?? onSelect.message.order.fulfillments[0];
  return {
    context: context('confirm', { ...opts, transactionId: onInit.context.transaction_id }),
    message: {
      order: {
        id: orderId ?? `O${Date.now().toString(36).toUpperCase()}`,
        state: 'Created',
        provider: o.provider,
        items: o.items,
        ...(o.offers ? { offers: o.offers } : {}),
        billing: o.billing,
        fulfillments: [{
          ...o.fulfillments[0],
          '@ondc/org/TAT': chosen['@ondc/org/TAT'],
          end: { ...o.fulfillments[0].end, contact: { phone: retailer.phone, email: retailer.email } },
        }],
        quote: o.quote,
        payments: [{
          ...(pay.uri ? { uri: pay.uri, tl_method: 'http/get' } : {}),
          params: { currency: 'INR', amount: o.quote.price.value },
          status: 'NOT-PAID',
          type: pay.type,
          collected_by: pay.collected_by,
          '@ondc/org/buyer_app_finder_fee_type': pay['@ondc/org/buyer_app_finder_fee_type'],
          '@ondc/org/buyer_app_finder_fee_amount': pay['@ondc/org/buyer_app_finder_fee_amount'],
          '@ondc/org/settlement_basis': 'delivery',
          '@ondc/org/settlement_window': 'P1D',
          '@ondc/org/withholding_amount': '0.00',
          '@ondc/org/settlement_details': pay['@ondc/org/settlement_details'],
        }],
        tags: [
          { code: 'bpp_terms', list: o.tags.find((t) => t.code === 'bpp_terms').list },
          {
            code: 'bap_terms',
            list: [
              { code: 'accept_bpp_terms', value: 'Y' },
              { code: 'static_terms', value: 'https://github.com/ONDC-Official/NP-Static-Terms/buyerNP_BNP/1.0/tc.pdf' },
              { code: 'tax_number', value: 'gst_number_of_buyerNP' },
            ],
          },
        ],
        created_at: now,
        updated_at: now,
      },
    },
  };
}

// ---- Post-order -----------------------------------------------------------------------------

export const status = ({ onConfirm, ...opts }) => ({
  context: context('status', { ...opts, transactionId: onConfirm.context.transaction_id }),
  message: { order_id: onConfirm.message.order.id },
});

// 053 = buyer cancelled (RetailBuyerCancelledOrder), the reason the pre-order-service sends.
export const cancel = ({ onConfirm, reasonId = '053', ...opts }) => ({
  context: context('cancel', { ...opts, transactionId: onConfirm.context.transaction_id }),
  message: { order_id: onConfirm.message.order.id, cancellation_reason_id: reasonId },
});

// Mock-only: tells the seller to act on the order (not an ONDC request).
export const sellerPush = ({ onConfirm, event }) => ({ order_id: onConfirm.message.order.id, event });
// The seller deactivates (provider_disable) or reactivates (provider_enable) a provider for a buyer
// app: an unsolicited incremental on_search to that app.
export const providerPush = ({ bap, providerId, event }) => ({ event, provider_id: providerId, bap_id: bap.id, bap_uri: bap.uri });
