import { SELLER, findProvider, findItem, findLocation } from './data.js';
import { providerDescriptor } from './catalog.js';
import { creditFor } from './p2p.js';
import { offerLines } from './offers.js';
import { serves } from './serviceability.js';
import { saveOrder, getOrder } from './store.js';
import { rememberOrder } from './activity.js';

// The mock charges no tax and no delivery: those breakup lines are kept, at 0.00, so the quote
// keeps the shape of the contract.
const ZERO = { currency: 'INR', value: '0.00' };
const money = (n) => n.toFixed(2);

export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Resolves the provider and line items, and what the seller can fulfil given the transaction's
// seller-mode effects (see modes.js). Each line: { item, requested, count (fulfillable), unitPrice }.
function resolveOrder(order, effects) {
  const provider = findProvider(order?.provider?.id);
  if (!provider) throw new DomainError('30001', `Provider not found: ${order?.provider?.id}`);
  const lines = (order.items ?? []).map((reqItem) => {
    const item = findItem(provider, reqItem.id);
    if (!item) throw new DomainError('30004', `Item not found: ${reqItem.id} for provider ${provider.id}`);
    const requested = Number(reqItem.quantity?.count ?? item.min);
    const fx = effects.items[item.id] ?? {};
    const count = Math.min(requested, fx.available ?? Infinity);
    return { item, requested, count, unitPrice: Number(fx.price ?? item.price) };
  });
  if (!lines.length) throw new DomainError('30004', 'No items in order');
  return { provider, lines };
}

// The fulfillment the buyer picked (init/confirm), else the provider's first option.
const pickFulfillment = (provider, id) => provider.fulfillments.find((f) => f.id === id) ?? provider.fulfillments[0];

// The offer ids the buyer sent (on /select they win over auto offers; on /init and /confirm only they apply).
const selectedOfferIds = (order) => (order.offers ?? []).map((o) => o.id).filter(Boolean);

function isServiceable(provider, lines, end) {
  const point = { gps: end?.location?.gps, areaCode: end?.location?.address?.area_code };
  return [...new Set(lines.map((l) => l.item.location))].every((id) => serves(findLocation(provider, id), point));
}

// Quote: items, item tax (0.00), offers, then delivery and fulfillment tax (0.00; left out when the
// location is not serviceable). Offer lines: `listed` go in the breakup, only `applied` count in the
// total (on_select lists every eligible offer for the buyer to choose).
function buildQuote(provider, lines, fulfillment, { listed = [], applied = listed, serviceable = true, withItemQuantity = false } = {}) {
  const breakup = [];
  let total = 0;
  for (const { item, count, unitPrice } of lines) {
    const value = unitPrice * count;
    total += value;
    const entry = {
      '@ondc/org/item_id': item.id,
      '@ondc/org/item_quantity': { count },
      title: item.name,
      '@ondc/org/title_type': 'item',
      price: { currency: 'INR', value: money(value) },
      item: { price: { currency: 'INR', value: money(unitPrice) } },
    };
    if (withItemQuantity) {
      entry.item = {
        quantity: { available: { count: String(count) }, maximum: { count: item.max }, minimum: { count: item.min } },
        price: { currency: 'INR', value: money(unitPrice) },
      };
    }
    breakup.push(entry);
    breakup.push({ '@ondc/org/item_id': item.id, title: 'Tax', '@ondc/org/title_type': 'tax', price: ZERO });
  }
  breakup.push(...listed);
  // Offers never take the total below 0.00.
  total = Math.max(0, total + applied.reduce((s, l) => s + Number(l.price.value), 0));
  if (serviceable) {
    breakup.push({ '@ondc/org/item_id': fulfillment.id, title: 'Delivery charges', '@ondc/org/title_type': 'delivery', price: ZERO });
    breakup.push({
      '@ondc/org/item_id': fulfillment.id,
      title: 'Tax',
      '@ondc/org/title_type': 'tax',
      price: ZERO,
      item: { tags: [{ code: 'quote', list: [{ code: 'type', value: 'fulfillment' }] }] },
    });
  }
  return { price: { currency: 'INR', value: money(total) }, breakup, ttl: 'P1D' };
}

const orderProvider = (provider, lines) => ({
  id: provider.id,
  descriptor: providerDescriptor(provider),
  locations: [...new Set(lines.map((l) => l.item.location))].map((id) => ({ id })),
});

const orderItems = (lines, fulfillmentId) => lines.map(({ item, count }) => ({ id: item.id, fulfillment_id: fulfillmentId, quantity: { count } }));

const customerOf = (order) => order.fulfillments?.[0]?.customer;

function settlementDetails(provider) {
  const s = provider.settlement;
  return [{
    settlement_counterparty: 'seller-app',
    settlement_phase: 'sale-amount',
    settlement_type: 'upi',
    beneficiary_name: s.beneficiary_name,
    upi_address: s.upi_address,
    settlement_bank_account_no: 'XXXXXXXXXX',
    settlement_ifsc_code: 'XXXXXXXXX',
    bank_name: s.bank_name,
    branch_name: s.branch_name,
  }];
}

const bppTermsTag = (provider, extra = {}) => ({
  code: 'bpp_terms',
  list: Object.entries({ ...extra, tax_number: SELLER.gst, provider_tax_number: provider.pan }).map(([code, value]) => ({ code, value })),
});

// Item-level error message: [{"item_id":"I1","error":"40002"}, ...] per the contract.
const itemErrors = (lines) => JSON.stringify(lines.map((l) => ({ item_id: l.item.id, error: '40002' })));

// Every handler returns { message, error? } for the callback body.

// `enforceMov`: check the provider's minimum order value (only the min_order_value seller mode does).
export function onSelect(order, effects, { enforceMov = false } = {}) {
  const { provider, lines } = resolveOrder(order, effects);
  const customer = customerOf(order);
  const serviceable = isServiceable(provider, lines, order.fulfillments?.[0]?.end);
  const { eligible, applied } = offerLines(provider.id, lines, { stage: 'select', selectedIds: selectedOfferIds(order) });

  const fulfillments = provider.fulfillments.map((f) => {
    const out = {
      id: f.id,
      type: 'Delivery',
      '@ondc/org/provider_name': provider.distributor,
      tracking: false,
      '@ondc/org/category': f.category,
      '@ondc/org/TAT': f.tat,
      state: { descriptor: { code: serviceable ? 'Serviceable' : 'Non-serviceable' } },
    };
    if (customer?.id) out.customer = { id: customer.id };
    return out;
  });
  const message = {
    order: {
      provider: orderProvider(provider, lines),
      items: lines.map(({ item }) => ({ id: item.id, fulfillment_id: provider.fulfillments[0].id })),
      fulfillments,
      quote: buildQuote(provider, lines, provider.fulfillments[0], { listed: eligible, applied, serviceable, withItemQuantity: true }),
    },
  };

  if (!serviceable) return { message, error: { type: 'DOMAIN-ERROR', code: '30009', message: `Dropoff location not serviceable by ${provider.distributor}` } };
  const short = lines.filter((l) => l.count < l.requested);
  if (short.length) return { message, error: { type: 'DOMAIN-ERROR', code: '40002', message: itemErrors(short) } };
  const itemValue = lines.reduce((s, l) => s + l.unitPrice * l.count, 0);
  if (enforceMov && itemValue < provider.min_order_value) {
    return { message, error: { type: 'DOMAIN-ERROR', code: '30023', message: `Cart value ${money(itemValue)} is below the minimum order value ${money(provider.min_order_value)}` } };
  }
  return { message };
}

export function onInit(order, effects, { finderFee, transactionId }) {
  const { provider, lines } = resolveOrder(order, effects);
  const reqFulfillment = order.fulfillments?.[0] ?? {};
  const fulfillment = pickFulfillment(provider, reqFulfillment.id);
  const reqPayment = order.payments?.[0] ?? { type: 'ON-FULFILLMENT', collected_by: 'BPP' };
  const { applied } = offerLines(provider.id, lines, { stage: 'order', selectedIds: selectedOfferIds(order) });
  const quote = buildQuote(provider, lines, fulfillment, { listed: applied });

  const payment = {
    type: reqPayment.type,
    collected_by: reqPayment.collected_by ?? 'BPP',
    status: 'NOT-PAID',
    '@ondc/org/buyer_app_finder_fee_type': reqPayment['@ondc/org/buyer_app_finder_fee_type'] ?? finderFee.type,
    '@ondc/org/buyer_app_finder_fee_amount': reqPayment['@ondc/org/buyer_app_finder_fee_amount'] ?? finderFee.amount,
    '@ondc/org/settlement_details': settlementDetails(provider),
  };
  // Prepaid, collected by the seller: the seller hands back its payment link.
  if (payment.type === 'ON-ORDER' && payment.collected_by === 'BPP') payment.uri = `https://pay.mock-seller.example/pg?txn=${encodeURIComponent(transactionId)}`;

  const tags = [bppTermsTag(provider)];
  const credit = creditFor(provider.id, reqFulfillment.customer?.id);
  if (credit) tags.push({ code: 'credit', list: [{ code: 'credit_limit', value: credit }, { code: 'valid_till', value: '2026-12-31T23:59:59.000Z' }] });

  // A drop in stock since /select shows up as a lower item count (no error); the buyer re-selects.
  return {
    message: {
      order: {
        provider: orderProvider(provider, lines),
        items: orderItems(lines, fulfillment.id),
        ...(applied.length ? { offers: applied.map((l) => ({ id: l['@ondc/org/item_id'] })) } : {}),
        billing: order.billing,
        fulfillments: [{ ...reqFulfillment, id: fulfillment.id, type: reqFulfillment.type ?? 'Delivery', '@ondc/org/category': fulfillment.category, '@ondc/org/TAT': fulfillment.tat, tracking: false }],
        quote,
        payments: [payment],
        tags,
      },
    },
  };
}

export async function onConfirm(order, ctx, effects, { now }) {
  const { provider, lines } = resolveOrder(order, effects);
  if (effects.reject) {
    return {
      message: { order: { id: order.id, state: 'Cancelled', provider: { id: provider.id } } },
      error: { type: 'DOMAIN-ERROR', code: '30019', message: `${provider.distributor} cannot confirm the order` },
    };
  }
  const reqFulfillment = order.fulfillments?.[0] ?? {};
  const fulfillment = pickFulfillment(provider, reqFulfillment.id);
  const startLocation = findLocation(provider, lines[0].item.location);
  const { applied } = offerLines(provider.id, lines, { stage: 'order', selectedIds: selectedOfferIds(order) });
  const quote = buildQuote(provider, lines, fulfillment, { listed: applied });
  const reqPayment = order.payments?.[0] ?? {};
  const bapTerms = (order.tags ?? []).find((t) => t.code === 'bap_terms');

  const confirmed = {
    id: order.id,
    state: 'Accepted',
    provider: orderProvider(provider, lines),
    items: orderItems(lines, fulfillment.id),
    ...(applied.length ? { offers: applied.map((l) => ({ id: l['@ondc/org/item_id'] })) } : {}),
    billing: order.billing,
    fulfillments: [{
      id: fulfillment.id,
      '@ondc/org/provider_name': provider.distributor,
      state: { descriptor: { code: 'Pending' } },
      type: reqFulfillment.type ?? 'Delivery',
      tracking: true,
      '@ondc/org/category': fulfillment.category,
      '@ondc/org/TAT': reqFulfillment['@ondc/org/TAT'] ?? fulfillment.tat,
      ...(reqFulfillment.customer ? { customer: reqFulfillment.customer } : {}),
      start: {
        location: { id: startLocation.id, descriptor: { name: startLocation.name }, gps: startLocation.gps, address: startLocation.address },
        contact: { phone: provider.phone, email: provider.email },
      },
      end: reqFulfillment.end,
    }],
    quote,
    payments: [{
      ...reqPayment,
      params: { ...(reqPayment.params ?? {}), currency: 'INR', amount: quote.price.value },
      '@ondc/org/settlement_basis': reqPayment['@ondc/org/settlement_basis'] ?? 'delivery',
      '@ondc/org/settlement_window': reqPayment['@ondc/org/settlement_window'] ?? 'P1D',
      '@ondc/org/withholding_amount': reqPayment['@ondc/org/withholding_amount'] ?? '0.00',
      '@ondc/org/settlement_details': reqPayment['@ondc/org/settlement_details'] ?? settlementDetails(provider),
    }],
    tags: [
      bppTermsTag(provider, { np_type: SELLER.np_type, accept_bap_terms: 'Y' }),
      ...(bapTerms ? [{ code: 'bap_terms', list: bapTerms.list.filter((e) => e.code !== 'accept_bpp_terms') }] : []),
    ],
    created_at: order.created_at ?? now,
    updated_at: now,
  };
  await saveOrder({
    order: confirmed,
    context: { bap_id: ctx.bap_id, bap_uri: ctx.bap_uri, transaction_id: ctx.transaction_id, city: ctx.city, country: ctx.country, core_version: ctx.core_version, domain: ctx.domain },
    history: [historyEntry(confirmed, 'confirm', 'buyer', now)],
  });
  await rememberOrder(ctx, confirmed.id);
  return { message: { order: confirmed } };
}

// ---- post-order -----------------------------------------------------------------------------

// One step of an order's life, kept with the order for the playground's Orders tab:
// { at, event (confirm | packed | out_for_delivery | delivered | cancel), by (buyer | seller), state, fulfillment_state }.
function historyEntry(order, event, by, at, extra = {}) {
  return { at, event, by, state: order.state, fulfillment_state: order.fulfillments?.[0]?.state?.descriptor?.code, ...extra };
}
const withHistory = (record, entry) => ({ ...record, history: [...(record.history ?? []), entry] });

async function loadOrder(orderId) {
  const record = orderId && (await getOrder(orderId));
  if (!record) throw new DomainError('30018', `Order not found: ${orderId}. The mock only knows orders confirmed through it.`);
  return record;
}

function withState(order, orderState, fulfillmentState, now) {
  return {
    ...order,
    state: orderState,
    fulfillments: order.fulfillments.map((f) => ({ ...f, state: { descriptor: { code: fulfillmentState } } })),
    updated_at: now,
  };
}

export async function onStatus(orderId, { now }) {
  const record = await loadOrder(orderId);
  return { message: { order: { ...record.order, updated_at: now } }, record };
}

// The order's current state again, for a re-sent callback. Its state is unchanged; updated_at is
// stamped now (and kept), so a buyer app that skips callbacks it has already seen still processes it.
export async function resendOrder(orderId, { now }) {
  const record = await loadOrder(orderId);
  const order = { ...record.order, updated_at: now };
  const next = withHistory({ ...record, order }, historyEntry(order, 'resend', 'seller', now));
  await saveOrder(next);
  return { message: { order }, record: next };
}

// BNP-usable reasons (051/052/053/999) mean the buyer cancelled; any other code is the seller's.
export async function cancelOrder(orderId, { reasonId, cancelledBy, now }) {
  const record = await loadOrder(orderId);
  if (record.order.state === 'Cancelled' || record.order.state === 'Completed') {
    throw new DomainError('50001', `Order ${orderId} is ${record.order.state} and cannot be cancelled`);
  }
  const order = {
    ...withState(record.order, 'Cancelled', 'Cancelled', now),
    cancellation: { cancelled_by: cancelledBy, reason: { id: reasonId } },
  };
  await saveOrder(withHistory({ ...record, order }, historyEntry(order, 'cancel', cancelledBy === record.context.bap_id ? 'buyer' : 'seller', now, { reason: reasonId })));
  return { message: { order }, record };
}

// Seller-side progress pushed as unsolicited on_status.
export const PUSH_EVENTS = {
  packed: ['In-progress', 'Packed'],
  out_for_delivery: ['In-progress', 'Out-for-delivery'],
  delivered: ['Completed', 'Order-delivered'],
};

export async function advanceOrder(orderId, event, { now }) {
  const record = await loadOrder(orderId);
  if (record.order.state === 'Cancelled') throw new DomainError('50002', `Order ${orderId} is cancelled`);
  const [orderState, fulfillmentState] = PUSH_EVENTS[event];
  const order = withState(record.order, orderState, fulfillmentState, now);
  await saveOrder(withHistory({ ...record, order }, historyEntry(order, event, 'seller', now)));
  return { message: { order }, record };
}
