import crypto from 'node:crypto';
import { fullCatalog, incrementalCatalog } from './catalog.js';
import { resolveSingleRetailer, resolveMappings } from './p2p.js';
import { onSelect, onInit, onConfirm, onStatus, cancelOrder, advanceOrder, PUSH_EVENTS, DomainError } from './order.js';

export const ACTIONS = ['search', 'select', 'init', 'confirm', 'status', 'cancel'];
const DOMAIN = 'ONDC:RETeB2B';
// Reason the mock seller gives when it cancels an order itself (merchant rejected the order).
const SELLER_CANCEL_REASON = '005';

export const ack = () => ({ message: { ack: { status: 'ACK' } } });
export const nack = (code, message, type = 'DOMAIN-ERROR') => ({ message: { ack: { status: 'NACK' } }, error: { type, code, message } });

function responseContext(ctx, action, cfg, { messageId } = {}) {
  return {
    domain: ctx.domain,
    action,
    country: ctx.country,
    city: ctx.city,
    core_version: ctx.core_version,
    bap_id: ctx.bap_id,
    bap_uri: ctx.bap_uri,
    bpp_id: cfg.bppId,
    bpp_uri: cfg.bppUri,
    transaction_id: ctx.transaction_id,
    message_id: messageId ?? ctx.message_id,
    timestamp: cfg.now(),
  };
}

const findTag = (tags, code) => (tags ?? []).filter((t) => t.code === code);
const tagValue = (tag, code) => tag?.list?.find((e) => e.code === code)?.value;

// Every handler returns { response, callbacks }. `response` is the synchronous ACK/NACK body;
// each callback is { action, delayMs, headers, body } that the transport POSTs to bap_uri/<action>.
function cb(ctx, action, cfg, { message, error }, { searchType, delayMs = 0, messageId } = {}) {
  const headers = searchType ? { 'X-ONDC-Search-Response': searchType } : {};
  const body = { context: responseContext(ctx, action, cfg, { messageId }), message };
  if (error) body.error = error;
  return { action, delayMs, headers, body };
}

function handleSearch(ctx, intent, cfg) {
  const inc = findTag(intent.tags, 'catalog_inc')[0];
  const mappings = findTag(intent.tags, 'retailer_mapping');
  const customer = intent.fulfillment?.customer;

  // Incremental refresh (pull / push start / push stop).
  if (inc) {
    const mode = tagValue(inc, 'mode');
    if (mode === 'stop') return { response: ack(), callbacks: [], scenario: 'incremental-stop' };
    const callback = cb(ctx, 'on_search', cfg, { message: { catalog: incrementalCatalog(cfg.baseUrl, cfg.now()) } }, { searchType: 'inc' });
    if (mode === 'start') {
      // Push mode: one unsolicited update shortly after (same transaction_id, new message_id).
      Object.assign(callback, { delayMs: cfg.pushDelayMs });
      callback.body.context.message_id = crypto.randomUUID();
      return { response: ack(), callbacks: [callback], scenario: 'incremental-push-start' };
    }
    return { response: ack(), callbacks: [callback], scenario: 'incremental-pull' };
  }

  // P2P search: targeted at this Seller NP and carrying a retailer identity.
  if (ctx.bpp_id && (customer || mappings.length)) {
    if (customer && mappings.length) return { response: nack('30000', 'fulfillment.customer and retailer_mapping cannot be sent together'), callbacks: [] };
    if (mappings.length) {
      const message = { catalog: { 'bpp/descriptor': { tags: resolveMappings(mappings) } } };
      return { response: ack(), callbacks: [cb(ctx, 'on_search', cfg, { message }, { searchType: 'p2p' })], scenario: 'p2p-many-retailers' };
    }
    const { providers, followUp } = resolveSingleRetailer(intent);
    const callbacks = [cb(ctx, 'on_search', cfg, { message: { catalog: { 'bpp/providers': providers } } }, { searchType: 'p2p' })];
    if (followUp) {
      // Retailer "created" out of band: unsolicited /on_search on the same transaction_id.
      callbacks.push(cb(ctx, 'on_search', cfg, { message: { catalog: { 'bpp/providers': followUp } } }, { searchType: 'p2p', delayMs: cfg.creationDelayMs, messageId: crypto.randomUUID() }));
    }
    const scenario = followUp ? 'p2p-new-retailer' : customer.id ? 'p2p-existing-with-id' : 'p2p-existing-without-id';
    return { response: ack(), callbacks, scenario };
  }

  // Broadcast full catalogue.
  const message = { catalog: fullCatalog(cfg.baseUrl, { category: intent.category?.id }) };
  return { response: ack(), callbacks: [cb(ctx, 'on_search', cfg, { message }, { searchType: 'full' })], scenario: 'broadcast-full' };
}

const finderFeeFrom = (cfg) => ({ type: cfg.finderFeeType, amount: cfg.finderFeeAmount });
const scenarioOf = (action, out) => (out.error ? `${action}-error-${out.error.code}` : action);

async function dispatch(action, ctx, message, cfg) {
  switch (action) {
    case 'search':
      return handleSearch(ctx, message?.intent ?? {}, cfg);
    case 'select': {
      const out = onSelect(message?.order);
      return { response: ack(), callbacks: [cb(ctx, 'on_select', cfg, out)], scenario: scenarioOf('select', out) };
    }
    case 'init': {
      const out = onInit(message?.order, { finderFee: finderFeeFrom(cfg), transactionId: ctx.transaction_id });
      return { response: ack(), callbacks: [cb(ctx, 'on_init', cfg, out)], scenario: 'init' };
    }
    case 'confirm': {
      const out = await onConfirm(message?.order, ctx, { now: cfg.now() });
      return { response: ack(), callbacks: [cb(ctx, 'on_confirm', cfg, out)], scenario: scenarioOf('confirm', out) };
    }
    case 'status': {
      const out = await onStatus(message?.order_id, { now: cfg.now() });
      return { response: ack(), callbacks: [cb(ctx, 'on_status', cfg, out)], scenario: 'status' };
    }
    case 'cancel': {
      const out = await cancelOrder(message?.order_id, { reasonId: message?.cancellation_reason_id ?? '053', cancelledBy: ctx.bap_id, now: cfg.now() });
      return { response: ack(), callbacks: [cb(ctx, 'on_cancel', cfg, out)], scenario: 'cancel' };
    }
    default:
      return { response: nack('10000', `Unsupported action ${action}`, 'CONTEXT-ERROR'), callbacks: [] };
  }
}

export async function handle(action, body, cfg) {
  const ctx = body?.context;
  if (!ctx) return { response: nack('10000', 'context is required', 'JSON-SCHEMA-ERROR'), callbacks: [] };
  if (ctx.domain !== DOMAIN) return { response: nack('10000', `context.domain must be ${DOMAIN}`, 'CONTEXT-ERROR'), callbacks: [] };
  if (ctx.action !== action) return { response: nack('10000', `context.action "${ctx.action}" does not match endpoint /${action}`, 'CONTEXT-ERROR'), callbacks: [] };
  if (!ctx.bap_uri || !ctx.transaction_id || !ctx.message_id) return { response: nack('10000', 'context.bap_uri, transaction_id and message_id are required', 'CONTEXT-ERROR'), callbacks: [] };
  try {
    return await dispatch(action, ctx, body.message, cfg);
  } catch (err) {
    if (err instanceof DomainError) return { response: nack(err.code, err.message), callbacks: [] };
    throw err;
  }
}

// Seller-initiated events on a confirmed order (no buyer request): unsolicited on_status for
// fulfillment progress, or on_cancel when the seller cancels. Sent to the bap_uri the order was
// placed from, on its transaction_id, with a new message_id.
export async function handlePush({ order_id: orderId, event }, cfg) {
  if (!PUSH_EVENTS[event] && event !== 'seller_cancel') {
    return { response: nack('10000', `event must be one of ${[...Object.keys(PUSH_EVENTS), 'seller_cancel'].join(', ')}`), callbacks: [] };
  }
  try {
    const out = event === 'seller_cancel'
      ? await cancelOrder(orderId, { reasonId: SELLER_CANCEL_REASON, cancelledBy: cfg.bppId, now: cfg.now() })
      : await advanceOrder(orderId, event, { now: cfg.now() });
    const ctx = { ...out.record.context, message_id: crypto.randomUUID() };
    const action = event === 'seller_cancel' ? 'on_cancel' : 'on_status';
    return { response: ack(), callbacks: [cb(ctx, action, cfg, out)], scenario: `push-${event}`, bapUri: ctx.bap_uri };
  } catch (err) {
    if (err instanceof DomainError) return { response: nack(err.code, err.message), callbacks: [] };
    throw err;
  }
}
