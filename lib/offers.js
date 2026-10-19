import { P1, P2, P3, ID } from '../public/shared/ids.js';
// Offers (schemes) per the eB2B contract: published in the catalogue, evaluated at order time.
// Evaluation order from the contract: Applicability -> Qualifiers -> Benefit -> Meta. Which offers
// apply follows the retail-seller-service offers flow (OFFERS-FLOW.md):
//
//   Eligible   - time-valid, matching the cart (item, category, location; a combo needs any primary
//                item and every secondary one), qualifier met and a discount > 0. Anything else is
//                left out silently, unknown / expired / duplicate offer ids included.
//   Exclusive  - an additive = no offer blocks every other offer, additive ones included. Of several
//                exclusive candidates the highest discount wins.
//   /select    - buyer sent offer ids: they win over auto (best selected exclusive alone, else the
//                selected additive ones + every auto additive one). No ids: every auto additive one;
//                only when there is none, the best auto exclusive one. Every eligible offer is listed;
//                the ones not applied carry auto = no (an auto offer that lost is downgraded).
//   /init, /confirm - only the buyer's ids (auto offers are not auto-applied), same exclusive rule,
//                and only the applied offers are listed.
// Offers stay valid from the start of this year to the end of next year; `expired1` ended 30 days ago.
const year = new Date().getUTCFullYear();
const VALID = { start: `${year}-01-01T00:00:00.000Z`, end: `${year + 1}-12-31T23:59:59.000Z` };
const EXPIRED = { start: `${year - 1}-01-01T00:00:00.000Z`, end: new Date(Date.now() - 30 * 86400000).toISOString() };

export const OFFERS = {
  [P1]: [
    {
      id: ID.discp10, type: 'discount', title: '10% off on Aashirvaad Atta (max ₹200)', location_ids: [ID.L1, ID.L2], category_ids: ['Atta, Flours and Sooji'], item_ids: [ID.I1, ID.I2, ID.I3],
      qualifier: { min_value: '500.00' }, benefit: { value_type: 'percent', value: '-10.00', value_cap: '-200.00' }, additive: 'yes', auto: 'no',
      progress: { target_quantity: '100', remaining_quantity: '35', tier: 'silver' },
    },
    {
      id: ID.slab1, type: 'slab', title: '5% off on 10-19 units of Atta 5kg (max ₹500)', location_ids: [ID.L1], item_ids: [ID.I2],
      qualifier: { item_count: '10', item_count_upper: '19' }, benefit: { value_type: 'percent', value: '-5.00', value_cap: '-500.00' }, additive: 'no', auto: 'yes',
    },
    {
      id: ID.slab2, type: 'slab', title: '10% off on 20+ units of Atta 5kg (max ₹1000)', location_ids: [ID.L1], item_ids: [ID.I2],
      qualifier: { item_count: '20', item_count_upper: '' }, benefit: { value_type: 'percent', value: '-10.00', value_cap: '-1000.00' }, additive: 'no', auto: 'yes',
    },
    {
      id: ID.freebie1, type: 'freebie', title: 'Buy 10 Dark Fantasy, get 1 Bingo Mad Angles free', location_ids: [ID.L1], item_ids: [ID.I6],
      qualifier: { item_count: '10' }, benefit: { value_type: 'freebie', item_id: ID.I7, item_count: '1', item_value: '380.00' }, additive: 'no', auto: 'yes',
      progress: { target_quantity: '200', remaining_quantity: '50', tier: 'silver' },
    },
    {
      id: ID.combo1, type: 'combo', title: '50% off (max ₹200) on Atta + both B Natural packs', location_ids: [ID.L1, ID.L2], item_ids: [ID.I1, ID.I2],
      qualifier: { item_id: `${ID.I4},${ID.I5}` }, benefit: { value_type: 'percent', value: '-50.00', value_cap: '-200.00' }, additive: 'no', auto: 'yes',
    },
    {
      id: ID.flat50, type: 'discount', title: '₹50 off on Yippee Noodles above ₹2000', location_ids: [ID.L2], item_ids: [ID.I8],
      qualifier: { min_value: '2000.00' }, benefit: { value_type: 'amount', value: '-50.00' }, additive: 'yes', auto: 'no',
    },
    {
      id: ID.expired1, type: 'discount', title: '5% off on Aashirvaad Atta (expired)', location_ids: [ID.L1, ID.L2], item_ids: [ID.I1, ID.I2, ID.I3], time: EXPIRED,
      qualifier: { min_value: '100.00' }, benefit: { value_type: 'percent', value: '-5.00', value_cap: '-100.00' }, additive: 'yes', auto: 'yes',
    },
  ],
  [P2]: [
    {
      id: ID.flat150, type: 'discount', title: '₹150 off on Tea & Coffee above ₹1000', location_ids: [ID.L3], category_ids: ['Tea and Coffee'], item_ids: [ID.I12, ID.I13],
      qualifier: { min_value: '1000.00' }, benefit: { value_type: 'amount', value: '-150.00' }, additive: 'yes', auto: 'yes',
      progress: { target_purchase_value: '50000', remaining_purchase_value: '12000', tier: 'gold' },
    },
    {
      id: ID.slabw1, type: 'slab', title: '4% off on 20-49 kg of Surf Excel (max ₹800)', location_ids: [ID.L3], item_ids: [ID.I9, ID.I10],
      qualifier: { item_weight: '20', item_weight_upper: '49' }, benefit: { value_type: 'percent', value: '-4.00', value_cap: '-800.00' }, additive: 'no', auto: 'yes',
    },
    {
      id: ID.slabw2, type: 'slab', title: '8% off on 50+ kg of Surf Excel (max ₹2000)', location_ids: [ID.L3], item_ids: [ID.I9, ID.I10],
      qualifier: { item_weight: '50', item_weight_upper: '' }, benefit: { value_type: 'percent', value: '-8.00', value_cap: '-2000.00' }, additive: 'no', auto: 'yes',
    },
    {
      id: ID.disc5, type: 'discount', title: '5% off on Kissan & Knorr above ₹1000 (max ₹100)', location_ids: [ID.L3], item_ids: [ID.I14, ID.I15],
      qualifier: { min_value: '1000.00' }, benefit: { value_type: 'percent', value: '-5.00', value_cap: '-100.00' }, additive: 'yes', auto: 'no',
    },
    {
      id: ID.excl300, type: 'discount', title: '₹300 off on Surf Excel above ₹2500 (exclusive)', location_ids: [ID.L3], item_ids: [ID.I9, ID.I10],
      qualifier: { min_value: '2500.00' }, benefit: { value_type: 'amount', value: '-300.00' }, additive: 'no', auto: 'no',
    },
  ],
  [P3]: [
    {
      id: ID.buy2get1, type: 'buyXgetY', title: 'Buy 2 cases of Frooti 200ml, get 1 free', location_ids: [ID.L4], item_ids: [ID.I16],
      qualifier: { item_count: '2' }, benefit: { item_count: '1', item_id: ID.I16, item_value: '300.00' }, additive: 'no', auto: 'yes',
    },
    {
      id: ID.slabv1, type: 'slab', title: '3% off on Appy Fizz worth ₹5000+ (max ₹1000)', location_ids: [ID.L4], item_ids: [ID.I18, ID.I19],
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
    time: { label: 'valid', range: o.time ?? VALID },
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

const inTime = (o, now) => {
  const { start, end } = o.time ?? VALID;
  return now >= Date.parse(start) && now <= Date.parse(end);
};
// Applicability: the offer's items, and its categories and locations when it names them.
const matches = (o, l) => l.count > 0 && o.item_ids.includes(l.item.id)
  && (!o.category_ids?.length || o.category_ids.includes(l.item.category))
  && (!o.location_ids?.length || o.location_ids.includes(l.item.location));

// Discount of one offer for the cart (negative), or null when the cart does not qualify.
// `lines` are [{ item, count, unitPrice }] with the effective (seller-side) qty and price.
function evaluate(o, lines, now) {
  if (!inTime(o, now)) return null;
  const applicable = lines.filter((l) => matches(o, l));
  const qty = applicable.reduce((s, l) => s + l.count, 0);
  const value = applicable.reduce((s, l) => s + l.unitPrice * l.count, 0);
  const weight = applicable.reduce((s, l) => s + weightKg(l.item, l.count), 0);
  const q = o.qualifier;
  const inRange = (v, lo, hi) => v >= Number(lo) && (hi === '' || hi === undefined || v <= Number(hi));

  if (o.type === 'combo') {
    const secondary = q.item_id.split(',');
    const secLines = lines.filter((l) => l.count > 0 && secondary.includes(l.item.id));
    if (!applicable.length || secLines.length !== secondary.length) return null;
    const base = value + secLines.reduce((s, l) => s + l.unitPrice * l.count, 0);
    if (q.min_value && base < Number(q.min_value)) return null;
    return { discount: offAmount(o.benefit, base) };
  }
  if (!applicable.length) return null;
  if (q.min_value && value < Number(q.min_value)) return null;
  if (q.item_count && !inRange(qty, q.item_count, q.item_count_upper)) return null;
  if (q.item_value && !inRange(value, q.item_value, q.item_value_upper)) return null;
  if (q.item_weight && !inRange(weight, q.item_weight, q.item_weight_upper)) return null;

  if (o.type === 'freebie' || o.type === 'buyXgetY') {
    // Worth the free item's unit price (from the cart, else the benefit's item_value) x its count.
    const freeCount = Number(o.benefit.item_count);
    const inCart = lines.find((l) => l.item.id === o.benefit.item_id);
    const unit = inCart ? inCart.unitPrice : Number(o.benefit.item_value || 0);
    return { discount: -round(unit * freeCount), freeItemId: o.benefit.item_id, freeCount, itemValue: o.benefit.item_value };
  }
  return { discount: offAmount(o.benefit, value) };
}

const round = (n) => Math.round(n * 100) / 100;

function offAmount(benefit, base) {
  const raw = benefit.value_type === 'amount' ? Number(benefit.value) : (base * Number(benefit.value)) / 100; // value is negative
  const cap = benefit.value_cap ? Number(benefit.value_cap) : -Infinity;
  return round(Math.max(raw, cap, -base));
}

// `auto` is the flag the line carries: the catalogue's, or 'no' for an auto offer that was not applied.
function breakupLine(o, r, auto) {
  const tag = { type: o.type, additive: o.additive, auto };
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

// Highest discount first (discounts are negative); ties keep catalogue order.
const best = (es) => es.reduce((a, e) => (!a || e.r.discount < a.r.discount ? e : a), null);

// Which eligible offers apply, per stage ('select' or 'order') and the buyer's offer ids.
function choose(eligible, stage, chosen) {
  const selected = eligible.filter((e) => chosen.has(e.o.id));
  const exclusive = selected.filter((e) => e.o.additive === 'no');
  if (exclusive.length) return [best(exclusive)];
  if (stage === 'order') return selected;
  const autoAdditive = eligible.filter((e) => e.o.auto === 'yes' && e.o.additive === 'yes');
  if (selected.length) return [...new Set([...autoAdditive, ...selected])];
  if (autoAdditive.length) return autoAdditive;
  const autoExclusive = best(eligible.filter((e) => e.o.auto === 'yes'));
  return autoExclusive ? [autoExclusive] : [];
}

// Returns { eligible, applied } breakup lines: `eligible` is what on_select lists (every eligible
// offer), `applied` what counts in the total (and all that on_init / on_confirm list).
export function offerLines(providerId, lines, { stage, selectedIds = [], now = Date.now() }) {
  const eligible = [];
  for (const o of OFFERS[providerId] ?? []) {
    const r = evaluate(o, lines, now);
    if (r && r.discount < 0) eligible.push({ o, r });
  }
  const applied = new Set(choose(eligible, stage, new Set(selectedIds)));
  const line = (e) => breakupLine(e.o, e.r, applied.has(e) ? e.o.auto : 'no');
  return { eligible: eligible.map(line), applied: eligible.filter((e) => applied.has(e)).map(line) };
}
