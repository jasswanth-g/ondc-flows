// Offers (schemes) per the eB2B contract: published in the catalogue, evaluated at order time.
// Evaluation order from the contract: Applicability -> Qualifiers -> Benefit -> Meta.
//
// Which offers are applied:
//   /select        - only auto offers (auto = yes): every auto + additive offer, plus the first auto
//                    non-additive one. Every eligible offer, opt-in included, is listed so the buyer can choose.
//   /init, /confirm - exactly the offers the buyer sent in order.offers, after validation: an offer the
//                    cart does not qualify for is dropped, and of the non-additive ones only the first stays.
// Non-additive offers never stack with each other.

const VALID = { start: '2026-01-01T00:00:00.000Z', end: '2026-12-31T23:59:59.000Z' };

export const OFFERS = {
  P1: [
    {
      id: 'discp10', type: 'discount', title: '10% off on Aashirvaad Atta (max ₹200)', location_ids: ['L1', 'L2'], category_ids: ['Atta, Flours and Sooji'], item_ids: ['I1', 'I2', 'I3'],
      qualifier: { min_value: '500.00' }, benefit: { value_type: 'percent', value: '-10.00', value_cap: '-200.00' }, additive: 'yes', auto: 'no',
      progress: { target_quantity: '100', remaining_quantity: '35', tier: 'silver' },
    },
    {
      id: 'slab1', type: 'slab', title: '5% off on 10-19 units of Atta 5kg (max ₹500)', location_ids: ['L1'], item_ids: ['I2'],
      qualifier: { item_count: '10', item_count_upper: '19' }, benefit: { value_type: 'percent', value: '-5.00', value_cap: '-500.00' }, additive: 'no', auto: 'yes',
    },
    {
      id: 'slab2', type: 'slab', title: '10% off on 20+ units of Atta 5kg (max ₹1000)', location_ids: ['L1'], item_ids: ['I2'],
      qualifier: { item_count: '20', item_count_upper: '' }, benefit: { value_type: 'percent', value: '-10.00', value_cap: '-1000.00' }, additive: 'no', auto: 'yes',
    },
    {
      id: 'freebie1', type: 'freebie', title: 'Buy 10 Dark Fantasy, get 1 Bingo Mad Angles free', location_ids: ['L1'], item_ids: ['I6'],
      qualifier: { item_count: '10' }, benefit: { value_type: 'freebie', item_id: 'I7', item_count: '1' }, additive: 'no', auto: 'yes',
      progress: { target_quantity: '200', remaining_quantity: '50', tier: 'silver' },
    },
    {
      id: 'combo1', type: 'combo', title: '50% off (max ₹200) on Atta + both B Natural packs', location_ids: ['L1', 'L2'], item_ids: ['I1', 'I2'],
      qualifier: { item_id: 'I4,I5' }, benefit: { value_type: 'percent', value: '-50.00', value_cap: '-200.00' }, additive: 'no', auto: 'yes',
    },
  ],
  P2: [
    {
      id: 'flat150', type: 'discount', title: '₹150 off on Tea & Coffee above ₹1000', location_ids: ['L3'], category_ids: ['Tea and Coffee'], item_ids: ['I12', 'I13'],
      qualifier: { min_value: '1000.00' }, benefit: { value_type: 'amount', value: '-150.00' }, additive: 'yes', auto: 'yes',
      progress: { target_purchase_value: '50000', remaining_purchase_value: '12000', tier: 'gold' },
    },
    {
      id: 'slabw1', type: 'slab', title: '4% off on 20-49 kg of Surf Excel (max ₹800)', location_ids: ['L3'], item_ids: ['I9', 'I10'],
      qualifier: { item_weight: '20', item_weight_upper: '49' }, benefit: { value_type: 'percent', value: '-4.00', value_cap: '-800.00' }, additive: 'no', auto: 'yes',
    },
    {
      id: 'slabw2', type: 'slab', title: '8% off on 50+ kg of Surf Excel (max ₹2000)', location_ids: ['L3'], item_ids: ['I9', 'I10'],
      qualifier: { item_weight: '50', item_weight_upper: '' }, benefit: { value_type: 'percent', value: '-8.00', value_cap: '-2000.00' }, additive: 'no', auto: 'yes',
    },
  ],
  P3: [
    {
      id: 'buy2get1', type: 'buyXgetY', title: 'Buy 2 cases of Frooti 200ml, get 1 free', location_ids: ['L4'], item_ids: ['I16'],
      qualifier: { item_count: '2' }, benefit: { item_count: '1', item_id: 'I16', item_value: '0.00' }, additive: 'no', auto: 'yes',
    },
    {
      id: 'slabv1', type: 'slab', title: '3% off on Appy Fizz worth ₹5000+ (max ₹1000)', location_ids: ['L4'], item_ids: ['I18', 'I19'],
      qualifier: { item_value: '5000', item_value_upper: '' }, benefit: { value_type: 'percent', value: '-3.00', value_cap: '-1000.00' }, additive: 'yes', auto: 'yes',
    },
  ],
};

const list = (obj) => Object.entries(obj).map(([code, value]) => ({ code, value }));
const money = (n) => n.toFixed(2);

// on_search: the offers array of a provider.
export function catalogOffers(providerId, base) {
  return (OFFERS[providerId] ?? []).map((o) => ({
    id: o.id,
    descriptor: { code: o.type, images: [`${base}/img/offer-${o.id}.svg`] },
    location_ids: o.location_ids,
    category_ids: o.category_ids ?? [],
    item_ids: o.item_ids,
    time: { label: 'valid', range: VALID },
    tags: [
      { code: 'qualifier', list: list(o.qualifier) },
      { code: 'benefit', list: list(o.benefit) },
      { code: 'meta', list: list({ additive: o.additive, auto: o.auto }) },
    ],
  }));
}

// P2P on_search: each offer the retailer is progressing on, with only its id and scheme_progress.
export function schemeProgress(providerId) {
  return (OFFERS[providerId] ?? []).filter((o) => o.progress).map((o) => ({
    id: o.id,
    tags: [{ code: 'scheme_progress', list: list({ ...o.progress, valid_till: VALID.end }) }],
  }));
}

const KG = { kilogram: 1, gram: 0.001, tonne: 1000 };
const weightKg = (item, count) => Number(item.value) * (KG[item.unit] ?? 0) * Number(item.count) * count;

// Discount value of one offer for the cart, or null when the cart does not qualify.
// `lines` are [{ item, count, unitPrice }] with the effective (seller-side) qty and price.
function evaluate(o, lines) {
  const applicable = lines.filter((l) => l.count > 0 && o.item_ids.includes(l.item.id));
  const qty = applicable.reduce((s, l) => s + l.count, 0);
  const value = applicable.reduce((s, l) => s + l.unitPrice * l.count, 0);
  const weight = applicable.reduce((s, l) => s + weightKg(l.item, l.count), 0);
  const q = o.qualifier;
  const inRange = (v, lo, hi) => v >= Number(lo) && (hi === '' || hi === undefined || v <= Number(hi));

  if (o.type === 'combo') {
    const secondary = q.item_id.split(',');
    const hasPrimary = applicable.length > 0;
    const secLines = lines.filter((l) => l.count > 0 && secondary.includes(l.item.id));
    if (!hasPrimary || secLines.length !== secondary.length) return null;
    const base = value + secLines.reduce((s, l) => s + l.unitPrice * l.count, 0);
    return { discount: percentOff(o.benefit, base) };
  }
  if (!applicable.length) return null;
  if (q.min_value && value < Number(q.min_value)) return null;
  if (q.item_count && !inRange(qty, q.item_count, q.item_count_upper)) return null;
  if (q.item_value && !inRange(value, q.item_value, q.item_value_upper)) return null;
  if (q.item_weight && !inRange(weight, q.item_weight, q.item_weight_upper)) return null;

  if (o.type === 'freebie') return { discount: 0, freeItemId: o.benefit.item_id, freeCount: Number(o.benefit.item_count) };
  if (o.type === 'buyXgetY') {
    const free = Math.floor(qty / Number(q.item_count)) * Number(o.benefit.item_count);
    return { discount: 0, freeItemId: o.benefit.item_id, freeCount: free, itemValue: o.benefit.item_value };
  }
  if (o.benefit.value_type === 'amount') return { discount: Number(o.benefit.value) };
  return { discount: percentOff(o.benefit, value) };
}

function percentOff(benefit, base) {
  const raw = (base * Number(benefit.value)) / 100; // value is negative
  const cap = benefit.value_cap ? Number(benefit.value_cap) : -Infinity;
  return Math.round(Math.max(raw, cap) * 100) / 100;
}

function breakupLine(o, r) {
  const tag = { type: o.type, additive: o.additive, auto: o.auto };
  if (r.freeItemId) Object.assign(tag, { item_id: r.freeItemId, item_count: String(r.freeCount) });
  if (r.itemValue !== undefined) tag.item_value = r.itemValue;
  const line = { '@ondc/org/item_id': o.id };
  if (r.freeItemId) line['@ondc/org/item_quantity'] = { count: r.freeCount };
  Object.assign(line, {
    title: o.title,
    '@ondc/org/title_type': 'offer',
    price: { currency: 'INR', value: money(r.discount) },
    item: { tags: [{ code: 'quote', list: [{ code: 'type', value: 'order' }] }, { code: 'offer', list: list(tag) }] },
  });
  return line;
}

// Returns { eligible, applied } breakup lines for a stage ('select' or 'order').
export function offerLines(providerId, lines, { stage, selectedIds = [] }) {
  const eligible = [];
  for (const o of OFFERS[providerId] ?? []) {
    const r = evaluate(o, lines);
    if (r) eligible.push({ o, line: breakupLine(o, r) });
  }
  const chosen = new Set(selectedIds);
  const applied = [];
  let exclusiveTaken = false;
  for (const e of eligible) {
    let take = stage === 'select' ? e.o.auto === 'yes' : chosen.has(e.o.id);
    if (take && e.o.additive === 'no') {
      if (exclusiveTaken) take = false;
      else exclusiveTaken = true;
    }
    if (take) applied.push(e);
  }
  return { eligible: eligible.map((e) => e.line), applied: applied.map((e) => e.line) };
}
