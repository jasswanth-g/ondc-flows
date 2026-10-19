import { SCENARIOS, newState, runStep } from './shared/scenarios.js';
import { RETAILERS, NEW_RETAILER, WALK_IN_RETAILER } from './shared/retailers.js';
import * as R from './shared/requests.js';

const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  n.append(...kids.flat().filter((k) => k != null));
  return n;
};
const json = (v) => JSON.stringify(v, null, 2);

const BPP = { id: location.host, uri: `${location.origin}/ondc` };
$('#bppUri').textContent = BPP.uri;

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

// ---- buyer app target -----------------------------------------------------------------------
// The callbacks of every request go to context.bap_uri + "/on_<action>", so the buyer app under
// test is identified only by what is typed here.
const bapUriInput = $('#bapUri');
const bapIdInput = $('#bapId');
bapUriInput.value = store.get('bapUri', '');
bapIdInput.value = store.get('bapId', '');

function target() {
  const uri = bapUriInput.value.trim().replace(/\/$/, '');
  if (!uri) return null;
  try {
    return { id: bapIdInput.value.trim() || new URL(uri).host, uri };
  } catch {
    return null;
  }
}
function refreshTarget() {
  store.set('bapUri', bapUriInput.value.trim());
  store.set('bapId', bapIdInput.value.trim());
  const t = target();
  $('#targetHint').replaceChildren(...(t
    ? ['▶ POSTs each callback to ', el('code', {}, `${t.uri}/on_<action>`), ' as ', el('code', {}, t.id), ' and shows what your buyer app answered.']
    : ['Enter your buyer app\'s bap_uri to enable ▶. Without it you can still Preview every callback.']));
  for (const b of document.querySelectorAll('[data-needs-target]')) b.disabled = !t || b.dataset.busy === '1' || Boolean(b.closest('.locked'));
}
bapUriInput.oninput = refreshTarget;
bapIdInput.oninput = refreshTarget;

const env = () => ({ bap: target() ?? R.BAP, bpp: BPP });

// ---- transport ------------------------------------------------------------------------------
// play: the mock delivers the callbacks to bap_uri and waits for the buyer app's reply.
// preview: callbacks are only returned, nothing is POSTed.
// 'push' is the mock seller acting on its own (fulfillment updates, seller cancel), not an ONDC call.
async function send(action, body, { play }) {
  const headers = { 'Content-Type': 'application/json', [play ? 'X-Mock-Deliver' : 'X-Mock-Sync']: play ? 'wait' : 'true' };
  const url = action === 'push' ? '/api/mock/push' : `/ondc/${action}`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  return res.json();
}

document.addEventListener('click', async (e) => {
  const sel = e.target.closest('[data-copy]')?.dataset.copy;
  if (!sel) return;
  const src = $(sel);
  await navigator.clipboard.writeText(src.value ?? src.textContent);
  e.target.textContent = 'Copied';
  setTimeout(() => (e.target.textContent = 'Copy'), 1200);
});

const copyBtn = (getText) => el('button', { class: 'ghost', type: 'button', onclick: async (e) => {
  await navigator.clipboard.writeText(getText());
  e.target.textContent = 'Copied';
  setTimeout(() => (e.target.textContent = 'Copy'), 1200);
} }, 'Copy');

function callBlock({ pill, pillClass, name, meta, sections, open = true, extra }) {
  const node = $('#tplCall').content.firstElementChild.cloneNode(true);
  node.open = open;
  node.querySelector('.pill').textContent = pill;
  node.querySelector('.pill').classList.add(pillClass);
  node.querySelector('.name').textContent = name;
  node.querySelector('.meta').textContent = meta ?? '';
  if (extra) node.querySelector('summary').append(extra);
  const body = node.querySelector('.call-body');
  for (const [title, value] of sections) {
    const text = typeof value === 'string' ? value : json(value);
    body.append(el('h5', {}, title, copyBtn(() => text)), el('pre', {}, text));
  }
  return node;
}

// What the buyer app answered to one delivered callback.
function deliveryPill(d) {
  if (!d) return null;
  let ack = '';
  try { ack = JSON.parse(d.body).message?.ack?.status ?? ''; } catch { /* not JSON */ }
  const ok = d.status >= 200 && d.status < 300 && ack === 'ACK';
  return el('span', { class: `pill ${ok ? 'ok' : 'bad'}` }, d.error ? `buyer app: ${d.error}` : `buyer app: ${d.status} ${ack || ''}`.trim());
}
const deliveriesOk = (reply) => (reply.callbacks ?? []).every((c) => !c.delivery || deliveryPill(c.delivery).classList.contains('ok'));

function renderReply(container, reply, { request, action } = {}) {
  const ok = reply.response?.message?.ack?.status === 'ACK';
  if (request) container.append(callBlock({ pill: 'REQUEST', pillClass: 'cb', name: `/${action}`, sections: [['buyer request (built by the playground)', request]], open: false }));
  container.append(callBlock({ pill: ok ? 'ACK' : 'NACK', pillClass: ok ? 'ok' : 'bad', name: 'mock sync response', sections: [['body', reply.response]], open: !ok }));
  for (const c of reply.callbacks ?? []) {
    const meta = [c.headers?.['X-ONDC-Search-Response'] && `X-ONDC-Search-Response: ${c.headers['X-ONDC-Search-Response']}`, c.delay_ms ? `unsolicited, after ${c.delay_ms / 1000}s` : null, `→ ${c.url}`].filter(Boolean).join(' · ');
    const sections = [['callback body', c.body]];
    if (c.delivery) sections.push(['buyer app response', c.delivery.error ?? c.delivery.body ?? '']);
    container.append(callBlock({ pill: 'CALLBACK', pillClass: 'cb', name: `/${c.body.context.action}`, meta, sections, open: !request, extra: deliveryPill(c.delivery) }));
  }
}

// ---- tabs -----------------------------------------------------------------------------------
function showTab(name) {
  for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const s of document.querySelectorAll('.tab')) s.hidden = s.id !== `tab-${name}`;
  store.set('tab', name);
  if (name === 'catalogue') loadCatalogue();
}
for (const b of document.querySelectorAll('[data-tab]')) b.onclick = () => showTab(b.dataset.tab);

// ---- scenarios ------------------------------------------------------------------------------
function busy(btn, on) {
  btn.dataset.busy = on ? '1' : '';
  btn.disabled = on || (btn.dataset.needsTarget !== undefined && !target()) || Boolean(btn.closest('.locked'));
}

const label = (step) => (step.action === 'push' ? 'seller push (mock)' : `/${step.action} → /on_${step.action}`);

function openScenario(sc) {
  store.set('scenario', sc.id);
  for (const b of document.querySelectorAll('.scenario-item')) b.classList.toggle('current', b.dataset.id === sc.id);
  const state = newState(sc);
  let done = 0;
  const rows = sc.steps.map((step, i) => {
    const out = el('div', { class: 'out step-out' });
    const status = el('span', { class: 'pill' }, 'pending');
    const playBtn = el('button', { class: 'play', type: 'button', 'data-needs-target': '' }, '▶');
    const previewBtn = el('button', { class: 'ghost', type: 'button' }, 'Preview');
    const row = el('div', { class: 'step' },
      el('div', { class: 'step-head' }, el('span', { class: 'step-no' }, String(i + 1)), el('b', {}, step.name), el('code', {}, label(step)), status, el('span', { class: 'spacer' }), previewBtn, playBtn),
      el('p', { class: 'step-expect' }, 'Expected: ', step.expect),
      out);
    const go = async (play) => {
      busy(playBtn, true);
      busy(previewBtn, true);
      status.textContent = play ? 'sending…' : 'previewing…';
      status.className = 'pill';
      out.replaceChildren();
      let ok = false;
      try {
        const { request, reply, problem } = await runStep(step, state, { ...env(), send: (a, b) => send(a, b, { play }), previewSend: (a, b) => send(a, b, { play: false }) });
        renderReply(out, reply, { request, action: step.action });
        const delivered = !play || deliveriesOk(reply);
        ok = !problem && delivered;
        status.textContent = problem ? `unexpected: ${problem}` : !delivered ? 'buyer app did not ACK' : play ? 'as expected · delivered' : 'as expected';
        status.className = `pill ${ok ? 'ok' : 'bad'}`;
        if (!problem) done = Math.max(done, i + 1);
      } catch (err) {
        if (err.reply) renderReply(out, err.reply, { request: err.request, action: step.action });
        status.textContent = err.message;
        status.className = 'pill bad';
      }
      busy(playBtn, false);
      busy(previewBtn, false);
      refreshSteps();
      return ok;
    };
    playBtn.onclick = () => go(true);
    previewBtn.onclick = () => go(false);
    return { row, playBtn, previewBtn, go };
  });
  // A step unlocks once every earlier step has produced its expected response.
  const refreshSteps = () => rows.forEach((r, i) => {
    r.row.classList.toggle('locked', i > done);
    if (r.playBtn.dataset.busy !== '1') r.playBtn.disabled = i > done || !target();
    if (r.previewBtn.dataset.busy !== '1') r.previewBtn.disabled = i > done;
  });
  const runAll = (play) => async (e) => {
    busy(e.currentTarget, true);
    for (let i = done; i < rows.length; i++) if (!(await rows[i].go(play)) && play) break;
    busy(e.currentTarget, false);
  };
  const playAll = el('button', { class: 'play', type: 'button', 'data-needs-target': '' }, '▶ Play all');
  playAll.onclick = runAll(true);
  const previewAll = el('button', { class: 'ghost', type: 'button' }, 'Preview all');
  previewAll.onclick = runAll(false);
  const reset = el('button', { class: 'ghost', type: 'button', onclick: () => openScenario(sc) }, 'Reset');
  $('#scenarioRun').replaceChildren(
    el('div', { class: 'run-head' },
      el('div', {}, el('span', { class: 'pill' }, sc.group), el('h2', {}, sc.title), el('p', { class: 'muted' }, sc.summary)),
      el('div', { class: 'row' }, reset, previewAll, playAll)),
    ...rows.map((r) => r.row),
  );
  refreshSteps();
  refreshTarget();
}

let group;
for (const sc of SCENARIOS) {
  if (sc.group !== group) $('#scenarioList').append(el('h4', {}, (group = sc.group)));
  $('#scenarioList').append(el('button', { class: 'scenario-item', type: 'button', 'data-id': sc.id, onclick: () => openScenario(sc) },
    el('span', {}, sc.title), el('span', { class: 'muted steps-count' }, `${sc.steps.length} step${sc.steps.length > 1 ? 's' : ''}`)));
}
openScenario(SCENARIOS.find((x) => x.id === store.get('scenario', '')) ?? SCENARIOS[0]);

// ---- catalogue ------------------------------------------------------------------------------
const tagList = (tags, code) => (tags.find((t) => t.code === code)?.list ?? []).map((e) => `${e.code} ${e.value === '' ? '(no upper limit)' : e.value}`).join(', ');

function offersTable(p) {
  if (!p.offers?.length) return null;
  return el('div', { class: 'table-wrap offers' }, el('table', {},
    el('thead', {}, el('tr', {}, ...['offer', 'type', 'items', 'qualifier', 'benefit', 'meta'].map((h) => el('th', {}, h)))),
    el('tbody', {}, p.offers.map((o) => el('tr', {},
      el('td', {}, el('code', {}, o.id)),
      el('td', {}, o.descriptor.code),
      el('td', {}, o.item_ids.join(', ')),
      el('td', {}, tagList(o.tags, 'qualifier')),
      el('td', {}, tagList(o.tags, 'benefit')),
      el('td', {}, tagList(o.tags, 'meta')),
    ))),
  ));
}

let catalogueLoaded = false;
async function loadCatalogue() {
  if (catalogueLoaded) return;
  catalogueLoaded = true;
  const reply = await send('search', R.searchBroadcast(env()), { play: false });
  const providers = reply.callbacks[0].body.message.catalog['bpp/providers'];
  const box = $('#catalogue');
  for (const p of providers) {
    const variants = p.tags.filter((t) => t.code === 'retailer_info_required').map((t) => t.list.find((e) => e.code === 'type').value);
    const minOrder = p.tags.find((t) => t.code === 'order_value').list[0].value;
    const rows = p.items.map((i) => el('tr', {},
      el('td', {}, el('img', { class: 'thumb', src: i.descriptor.symbol, alt: '' })),
      el('td', {}, el('code', {}, i.id)),
      el('td', {}, i.descriptor.name),
      el('td', {}, i.parent_item_id ?? '—'),
      el('td', {}, i.category_id),
      el('td', {}, i.location_id),
      el('td', { class: 'num' }, `₹${i.price.value}`),
      el('td', { class: 'num' }, `₹${i.price.maximum_value}`),
      el('td', { class: 'num' }, `${i.quantity.minimum.count} – ${i.quantity.maximum.count}`),
    ));
    box.append(el('section', { class: 'card provider' },
      el('header', {},
        el('h3', {}, `${p.id} · ${p.descriptor.short_desc} × ${p.descriptor.name}`),
        el('span', { class: 'muted' }, `${p.descriptor.code} · locations ${p.locations.map((l) => `${l.id} ${l.address.locality}`).join(', ')} · min order ₹${minOrder}`),
        el('span', { class: 'pill' }, variants.length ? `retailer_info_required: ${variants.join(', ')}` : 'no retailer_info_required'),
      ),
      el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, ...['', 'id', 'name', 'variant', 'category', 'location', 'price', 'MRP', 'MOQ – max'].map((h) => el('th', {}, h)))),
        el('tbody', {}, rows),
      )),
      offersTable(p),
    ));
  }
}

// ---- retailers ------------------------------------------------------------------------------
{
  const rows = [...RETAILERS.map((r) => ({ ...r, kind: 'held' })), { ...NEW_RETAILER, kind: 'new' }, { ...WALK_IN_RETAILER, kind: 'walk-in' }].map((r) => el('tr', {},
    el('td', {}, r.shop_name),
    el('td', {}, r.customer_id ? el('code', {}, r.customer_id) : r.kind === 'new' ? 'issued on registration (CUST-NEW-…)' : '—'),
    el('td', {}, r.phone),
    el('td', {}, r.PAN ?? '—'),
    el('td', {}, r.GSTIN ?? '—'),
    el('td', {}, r.address.area_code),
    el('td', {}, r.providers ? Object.entries(r.providers).map(([id, t]) => `${id} (credit ₹${t.credit_limit}, POC ${t.poc.name})`).join('; ') : r.kind === 'new' ? 'not held - register with P1' : 'P3 only - no registration'),
  ));
  $('#retailers').append(el('section', { class: 'card' },
    el('p', { class: 'muted' }, 'Retailers the mock Seller NP knows. A retailer is resolved when the request fully satisfies one type=existing variant: customer_id, or phone_number + PAN. Any other identity is "not found" (empty bpp/providers).'),
    el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ...['shop', 'customer_id', 'phone', 'PAN', 'GSTIN', 'pincode', 'mapped providers'].map((h) => el('th', {}, h)))),
      el('tbody', {}, rows),
    )),
  ));
}

showTab(['scenarios', 'catalogue', 'retailers'].includes(store.get('tab', '')) ? store.get('tab', '') : 'scenarios');
