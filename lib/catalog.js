import { SELLER, PROVIDERS, VARIANT_GROUPS } from './data.js';
import { catalogOffers } from './offers.js';

// Snapshot time for the full catalogue. Fixed so that incremental updates (stamped "now")
// are always newer than the full broadcast a buyer NP cached.
export const SNAPSHOT_TS = '2026-01-01T00:00:00.000Z';

const list = (obj) => Object.entries(obj).map(([code, value]) => ({ code, value }));
const img = (base, name) => `${base}/img/${encodeURIComponent(name)}.svg`;

export function bppDescriptor(base) {
  return {
    name: SELLER.name,
    symbol: img(base, 'seller'),
    short_desc: SELLER.short_desc,
    long_desc: SELLER.long_desc,
    images: [img(base, 'seller')],
    tags: [
      { code: 'bpp_terms', list: list({ np_type: SELLER.np_type, accept_bap_terms: 'Y', collect_payment: 'Y' }) },
    ],
  };
}

export function providerDescriptor(p, base) {
  const d = { name: p.manufacturer, code: p.code, short_desc: p.distributor };
  if (base) {
    d.symbol = img(base, p.id);
    d.long_desc = p.long_desc;
    d.images = [img(base, p.id)];
  }
  return d;
}

function catalogLocation(l) {
  return {
    id: l.id,
    time: { label: 'enable', timestamp: SNAPSHOT_TS, schedule: { holidays: ['2026-01-26', '2026-08-15'] } },
    gps: l.gps,
    address: l.address,
  };
}

function variantCategory(id) {
  const g = VARIANT_GROUPS[id];
  return {
    id,
    descriptor: { name: g.name },
    tags: [
      { code: 'type', list: [{ code: 'type', value: 'variant_group' }] },
      ...g.attrs.map((name, i) => ({ code: 'attr', list: [{ code: 'name', value: name }, { code: 'seq', value: String(i + 1) }] })),
    ],
  };
}

export function catalogItem(p, i, base, { timestamp = SNAPSHOT_TS, available = '99', price, label = 'enable' } = {}) {
  const item = {
    id: i.id,
    time: { label, timestamp },
  };
  if (i.group) item.parent_item_id = i.group;
  Object.assign(item, {
    descriptor: {
      name: i.name,
      code: `1:${i.ean}`,
      symbol: img(base, i.id),
      short_desc: i.name,
      long_desc: `${i.name} - ${i.brand}`,
      images: [img(base, i.id)],
    },
    quantity: {
      unitized: { count: i.count, measure: { unit: i.unit, value: i.value } },
      available: { count: available },
      maximum: { count: i.max },
      minimum: { count: i.min },
    },
    price: { currency: 'INR', value: price ?? i.price, maximum_value: i.mrp },
    category_id: i.category,
    fulfillment_id: 'F1',
    location_id: i.location,
    '@ondc/org/returnable': true,
    '@ondc/org/cancellable': true,
    '@ondc/org/return_window': 'P2D',
    '@ondc/org/seller_pickup_return': true,
    '@ondc/org/time_to_ship': 'PT12H',
    '@ondc/org/available_on_cod': true,
    '@ondc/org/contact_details_consumer_care': p.care,
    '@ondc/org/statutory_reqs_packaged_commodities': {
      ...p.statutory,
      common_or_generic_name_of_commodity: i.commodity,
      month_year_of_manufacture_packing_import: '12/2025',
    },
  });
  if (i.nutrition) {
    item['@ondc/org/statutory_reqs_prepackaged_food'] = {
      nutritional_info: i.nutrition,
      additives_info: 'None',
      brand_owner_FSSAI_license_no: p.fssai,
      other_FSSAI_license_no: p.fssai,
      importer_FSSAI_license_no: '',
    };
  }
  item.tags = [{ code: 'origin', list: [{ code: 'country', value: 'IND' }] }];
  if (i.pack) {
    item.tags.push({
      code: 'pack_config',
      list: [
        { code: 'set', value: i.pack.set },
        { code: 'case', value: i.pack.case },
        ...i.pack.selling_unit.map((value) => ({ code: 'selling_unit', value })),
      ],
    });
  }
  item.tags.push(
    { code: 'attribute', list: [{ code: 'brand', value: i.brand }] },
    { code: 'veg_nonveg', list: [{ code: 'veg', value: 'yes' }] },
  );
  return item;
}

function serviceabilityTag(l) {
  const s = l.serviceability;
  const entries = { location: l.id, category: '*', type: s.type, val: s.val, unit: s.unit };
  if (s.delivery_days) entries.delivery_days = s.delivery_days;
  return { code: 'serviceability', list: list(entries) };
}

function timingTags(l) {
  return [
    { code: 'timing', list: list({ type: 'Order', location: l.id, day_from: '1', day_to: '7', time_from: '0000', time_to: '2359' }) },
    { code: 'timing', list: list({ type: 'Delivery', location: l.id, day_from: '1', day_to: '6', time_from: '0900', time_to: '1800' }) },
  ];
}

function providerTags(p, base) {
  return [
    { code: 'order_value', list: [{ code: 'min_value', value: p.min_order_value.toFixed(2) }] },
    ...p.locations.flatMap(timingTags),
    ...p.locations.map(serviceabilityTag),
    { code: 'brand_images', list: p.brand_images.map((b) => ({ code: b, value: img(base, `brand-${b}`) })) },
    ...p.retailer_info_required.map((v) => ({ code: 'retailer_info_required', list: list({ ...v.codes, type: v.type }) })),
  ];
}

// One provider of the full broadcast. `items` lets the caller pass a category-filtered subset.
export function catalogProvider(p, base, items = p.items) {
  const groups = [...new Set(items.map((i) => i.group).filter(Boolean))];
  const ids = new Set(items.map((i) => i.id));
  const offers = catalogOffers(p.id, base).filter((o) => o.item_ids.some((id) => ids.has(id)));
  return {
    id: p.id,
    time: { label: 'enable', timestamp: SNAPSHOT_TS },
    descriptor: providerDescriptor(p, base),
    ttl: 'P1D',
    creds: [{ id: p.gstin, descriptor: { code: 'Identifier', short_desc: 'GSTIN' } }],
    fulfillments: p.fulfillments.map((f) => ({ id: f.id, type: 'Delivery', contact: { phone: p.phone, email: p.email } })),
    locations: p.locations.map(catalogLocation),
    categories: groups.map(variantCategory),
    ...(offers.length ? { offers } : {}),
    items: items.map((i) => catalogItem(p, i, base)),
    tags: providerTags(p, base),
  };
}

// Full catalogue, optionally narrowed to one category (intent.category.id). A provider with no
// item in that category is left out.
export function fullCatalog(base, { category } = {}) {
  const providers = PROVIDERS.map((p) => {
    const items = category ? p.items.filter((i) => i.category === category) : p.items;
    return items.length ? catalogProvider(p, base, items) : null;
  }).filter(Boolean);
  return { 'bpp/descriptor': bppDescriptor(base), 'bpp/providers': providers };
}

// Incremental refresh: a fixed set of "events" stamped with the given time - a price change and an
// item disabled by the seller on P1, a price change on P2 and a stock-out on P3. Only the changed
// items travel, as the entire item record, per the contract.
export function incrementalCatalog(base, timestamp) {
  const changes = {
    P1: [{ id: 'I2', price: '239.00' }, { id: 'I8', label: 'disable' }],
    P2: [{ id: 'I12', available: '99', price: '255.00' }],
    P3: [{ id: 'I20', available: '0' }],
  };
  return {
    'bpp/providers': PROVIDERS.map((p) => ({
      id: p.id,
      time: { label: 'enable', timestamp },
      items: changes[p.id].map((c) => catalogItem(p, p.items.find((i) => i.id === c.id), base, { timestamp, ...c })),
    })),
  };
}
