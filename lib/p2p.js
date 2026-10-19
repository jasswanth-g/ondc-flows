import { PROVIDERS, RETAILERS, NEW_RETAILER_TERMS, findProvider } from './data.js';
import { schemeProgress } from './offers.js';

const CREDIT_VALID_TILL = '2026-12-31T23:59:59.000Z';

// Normalise every way the contract lets a buyer NP identify a retailer into one flat code map
// (customer_id, phone_number, GSTIN, PAN, shop_name, address) so variant matching is uniform.
export function codesFromCustomer(customer = {}) {
  const codes = {};
  if (customer.id) codes.customer_id = customer.id;
  for (const c of customer.person?.creds ?? []) if (c.type && c.id) codes[c.type] = c.id;
  if (customer.contact?.phone) codes.phone_number = customer.contact.phone;
  if (customer.contact?.email) codes.email = customer.contact.email;
  if (customer.organization?.descriptor?.name) codes.shop_name = customer.organization.descriptor.name;
  if (customer.organization?.address) codes.address = customer.organization.address;
  return codes;
}

export const codesFromMappingBlock = (block) => Object.fromEntries((block.list ?? []).map((e) => [e.code, e.value]));

const variantSatisfied = (variant, codes) =>
  Object.entries(variant.codes).every(([code, required]) => required !== 'true' || codes[code]);

// A retailer held by the Seller NP is found when the codes fully satisfy one type=existing variant
// that the provider(s) publish and every code supplied for that variant matches the record.
export function findRetailer(codes, providers = PROVIDERS) {
  const variants = providers.flatMap((p) => p.retailer_info_required.filter((v) => v.type === 'existing'));
  for (const v of variants) {
    if (!variantSatisfied(v, codes)) continue;
    const keys = Object.keys(v.codes).filter((k) => codes[k]);
    const hit = RETAILERS.find((r) => keys.every((k) => (k === 'phone_number' ? r.phone : r[k]) === codes[k]));
    if (hit) return hit;
  }
  return null;
}

// Mock creation: the outlet code is derived from the phone so repeat runs are stable.
export const newCustomerId = (phone) => `CUST-NEW-${String(phone ?? '000000').slice(-6)}`;

const pocTag = (poc) => ({ code: 'poc', list: Object.entries(poc).map(([code, value]) => ({ code, value })) });
const creditTag = (limit) => ({ code: 'credit', list: [{ code: 'credit_limit', value: limit }, { code: 'valid_till', value: CREDIT_VALID_TILL }] });
const customerTag = (id) => ({ code: 'customer', list: [{ code: 'id', value: id }] });

const defaultPoc = (p) => ({ name: `${p.distributor} Sales Desk`, phone: p.phone, email: p.email });

// One bpp/providers element of a P2P response: offers with the retailer's scheme progress, credit,
// POC and customer. `pending` (creation pending) sends offer ids only and omits credit + customer.
export function p2pProvider(p, { customerId, terms, pending = false }) {
  const tags = [pocTag(terms?.poc ?? defaultPoc(p))];
  if (!pending) tags.unshift(creditTag(terms?.credit_limit ?? NEW_RETAILER_TERMS.credit_limit));
  if (!pending && customerId) tags.push(customerTag(customerId));
  const progress = schemeProgress(p.id);
  const offers = pending ? progress.map((o) => ({ id: o.id })) : progress;
  return { id: p.id, ...(offers.length ? { offers } : {}), tags };
}

// Resolve a single-retailer P2P /search. Returns { providers, followUp } where followUp (if any)
// is the bpp/providers payload of the unsolicited "created" /on_search.
export function resolveSingleRetailer(intent) {
  const providerId = intent.provider?.id;
  const scope = providerId ? [findProvider(providerId)].filter(Boolean) : PROVIDERS;
  const customer = intent.fulfillment?.customer ?? {};
  const codes = codesFromCustomer(customer);
  const isNewRequest = Boolean(customer.organization) && !codes.customer_id;

  const identifying = scope.filter((p) => p.retailer_info_required.length);
  const retailer = findRetailer(codes, identifying);

  // Providers that already hold this retailer.
  const held = retailer
    ? identifying.filter((p) => retailer.providers[p.id]).map((p) => p2pProvider(p, { customerId: retailer.customer_id, terms: retailer.providers[p.id] }))
    : [];

  // A provider that publishes no retailer_info_required does not identify retailers; when it is
  // targeted explicitly we return it with its POC so the buyer NP can proceed straight to /select.
  const open = providerId ? scope.filter((p) => !p.retailer_info_required.length).map((p) => ({ id: p.id, tags: [pocTag(defaultPoc(p))] })) : [];

  if (!isNewRequest || held.length) return { providers: [...held, ...open], followUp: null };

  // /search (New Retailer): every in-scope provider with a type=new variant accepts the request.
  const accepting = scope.filter((p) => p.retailer_info_required.some((v) => v.type === 'new' && variantSatisfied(v, codes)));
  if (!accepting.length) return { providers: open, followUp: null };
  const customerId = newCustomerId(codes.phone_number);
  return {
    providers: [...accepting.map((p) => p2pProvider(p, { pending: true })), ...open],
    followUp: accepting.map((p) => p2pProvider(p, { customerId })),
  };
}

// Many-retailer form: one retailer_mapping block in, one block out per resolved retailer. The
// request's codes are echoed and customer_id + provider_id appended. Unresolved retailers are omitted.
export function resolveMappings(blocks) {
  const out = [];
  for (const block of blocks) {
    const codes = codesFromMappingBlock(block);
    const retailer = findRetailer(codes);
    if (!retailer) continue;
    const list = (block.list ?? []).filter((e) => e.code !== 'customer_id').map((e) => ({ code: e.code, value: e.value }));
    list.push({ code: 'customer_id', value: retailer.customer_id }, { code: 'provider_id', value: Object.keys(retailer.providers).join(',') });
    out.push({ code: 'retailer_mapping', list });
  }
  return out;
}

// Terms (credit) the provider extends to a known customer id, for /on_init.
export function creditFor(providerId, customerId) {
  const r = RETAILERS.find((x) => x.customer_id === customerId);
  if (r?.providers[providerId]) return r.providers[providerId].credit_limit;
  if (customerId?.startsWith('CUST-NEW-')) return NEW_RETAILER_TERMS.credit_limit;
  return null;
}
