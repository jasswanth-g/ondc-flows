import { SCENARIOS, newState, expectText, buyerText, trackLive, recommendation, PUSH_LABELS } from './shared/scenarios.js';
import { RETAILERS, NEW_RETAILER, WALK_IN_RETAILER } from './shared/retailers.js';
import { ID, label } from './shared/ids.js';
import * as R from './shared/requests.js';

// The buyer app makes every ONDC call; the mock only answers. This page:
//   - starts a flow (the scenario's seller mode) for the buyer app, identified by bap_uri or bap_id,
//   - tracks every call of the flow live: YOU SEND (/search: awaiting -> received) and
//     MOCK (/on_search: on hold -> sending -> sent), with the real JSON of each in the inspector,
//   - sends the seller's unsolicited calls (on_status, on_cancel) itself when their turn comes.

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
const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }).then((r) => r.json());

const BPP = { id: location.host, uri: `${location.origin}/ondc` };
$('#sendTo').textContent = `${BPP.uri}/<action>`;

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

document.addEventListener('click', async (e) => {
  const sel = e.target.closest('[data-copy]')?.dataset.copy;
  if (!sel) return;
  await navigator.clipboard.writeText($(sel).textContent);
  e.target.textContent = 'Copied';
  setTimeout(() => (e.target.textContent = 'Copy'), 1200);
});

// ---- the buyer app --------------------------------------------------------------------------
const bapIdInput = $('#bapId');
bapIdInput.value = store.get('bapId', '');
// The buyer app is identified by its bap_uri or bap_id; the mock matches calls by either.
const bapId = () => bapIdInput.value.trim().replace(/\/+$/, '');
// Who a seller push goes to: the bap_uri or the bap_id entered (the mock fills in the other half
// from the apps that called it).
const pushBap = () => (/^https?:\/\//.test(bapId()) ? { uri: bapId() } : { id: bapId() });

const MODE_LABELS = {
  normal: 'Normal', item_inactive: 'Item inactive', out_of_stock: 'Out of stock', partial_quantity: 'Partial quantity',
  price_changed: 'Price changed', init_qty_reduced: 'Quantity reduced at init', confirm_rejected: 'Seller rejects confirm',
  min_order_value: 'Minimum order value',
};
let armed = null; // { mode, items, scenario, at } running for bapId()
let health = null; // { store, env, ok, error?, vercel } from /api/mock/health
const runningScenario = () => (armed?.scenario ? SCENARIOS.find((x) => x.id === armed.scenario) : null);

function infoChips() {
  const sc = runningScenario();
  const chip = (k, v) => el('span', { class: 'chip-kv' }, el('span', {}, `${k}:`), el('b', {}, v));
  $('#infoChips').replaceChildren(
    chip('Subscriber type', 'BPP (mock seller)'), chip('Domain', 'ONDC:RETeB2B'), chip('Version', '1.2.5'), chip('City', 'std:080'),
    chip('Active flow', sc ? sc.title : 'N/A'),
    ...(health ? [el('span', { class: `chip-kv ${health.store === 'postgres' && health.ok ? '' : 'warn'}` }, el('span', {}, 'Storage:'),
      el('b', {}, health.store === 'postgres' ? (health.ok ? `Postgres (${health.env})` : `Postgres error: ${health.error}`) : 'memory only'))] : []),
    ...(sc && armed.mode !== 'normal' ? [chip('Seller mode', `${MODE_LABELS[armed.mode]}${armed.items?.length ? ` (${armed.items.map(label).join(', ')})` : ''}`)] : []),
  );
}

// On Vercel each API route is its own function: without a shared store the call logged by /ondc/*
// is invisible to /api/mock/activity, so nothing would ever update live. Say so plainly.
async function loadHealth() {
  try {
    health = await fetch('/api/mock/health', { cache: 'no-store' }).then((r) => r.json());
  } catch { health = null; }
  const broken = health && health.vercel && (health.store !== 'postgres' || !health.ok);
  $('#storageWarning')?.remove();
  if (broken) {
    $('main').prepend(el('section', { id: 'storageWarning', class: 'card banner bad' },
      el('b', {}, health.store === 'postgres' ? 'The database is not reachable: ' : 'This deployment has no database, so calls cannot be tracked live. '),
      health.store === 'postgres' ? health.error : ['In Vercel open the project → Settings → Environment Variables, make ', el('code', {}, 'POSTGRES_URL'),
        ' (from the Supabase integration) available to the Production environment, then redeploy.']));
  }
  infoChips();
}

function refreshTarget() {
  store.set('bapId', bapId());
  bapIdInput.classList.toggle('needs', !bapId());
  $('#targetHint').replaceChildren(...(bapId()
    ? ['Callbacks go to the ', el('code', {}, 'bap_uri'), ' your app sends in each request, at ', el('code', {}, '<bap_uri>/on_<action>'), '. Press ▶ on a flow first, then use your app: calls made before ▶ are not part of the flow.']
    : [el('b', {}, 'Enter your app\'s bap_uri (or bap_id) to start a flow.')]));
  for (const b of document.querySelectorAll('[data-needs-bap]')) {
    b.disabled = !bapId();
    b.title = bapId() ? (b.dataset.title ?? '') : 'Enter your app\'s bap_uri or bap_id above';
  }
  infoChips();
}

async function loadArmed() {
  armed = null;
  if (bapId()) {
    const m = await fetch(`/api/mock/mode?bap_id=${encodeURIComponent(bapId())}`).then((r) => r.json());
    armed = { mode: m.mode, items: m.items ?? [], scenario: m.scenario, at: m.at };
  }
  refreshTarget();
  renderFlows();
}

// Buyer apps that called the mock recently: one click fills the field with what the app really sends.
async function loadCallers() {
  try {
    const { callers = [] } = await fetch('/api/mock/activity', { cache: 'no-store' }).then((r) => r.json());
    $('#callers').replaceChildren(...(callers.length
      ? [el('span', { class: 'muted' }, 'Recent callers:'), ...callers.map((c) => el('button', {
          class: `ghost chip ${c.bap_uri === bapId() || c.bap_id === bapId() ? 'current' : ''}`, type: 'button', title: `bap_id ${c.bap_id}`,
          onclick: () => { bapIdInput.value = c.bap_uri || c.bap_id; refreshTarget(); loadArmed(); loadCallers(); poll(true); },
        }, c.bap_uri || c.bap_id))]
      : []));
  } catch { /* optional hint */ }
}

let bapTimer;
bapIdInput.addEventListener('input', () => {
  refreshTarget();
  clearTimeout(bapTimer);
  bapTimer = setTimeout(() => { loadArmed(); poll(true); }, 400);
});

// ---- tabs -----------------------------------------------------------------------------------
function showTab(name) {
  for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const s of document.querySelectorAll('.tab')) s.hidden = s.id !== `tab-${name}`;
  store.set('tab', name);
  if (name === 'catalogue') loadCatalogue();
}
for (const b of document.querySelectorAll('[data-tab]')) b.onclick = () => showTab(b.dataset.tab);

// ---- flows ----------------------------------------------------------------------------------
let catalogPromise;
const getCatalog = () => (catalogPromise ??= post('/ondc/search', R.searchBroadcast({ bap: R.BAP }), { 'X-Mock-Sync': 'true' })
  .then((r) => r.callbacks[0].body.message.catalog['bpp/providers']));

// A flow's calls: each buyer step is a YOU SEND card paired with the MOCK card of its callback(s);
// a seller step is a single unsolicited MOCK card.
function cardsOf(sc) {
  const cards = [];
  sc.steps.forEach((step, i) => {
    if (step.action === 'push') return cards.push({ i, step, side: 'mock', unsolicited: true, label: step.callback });
    const label = step.action === 'search' && step.p2p ? 'search (P2P)' : step.action;
    cards.push({ i, step, side: 'send', label });
    cards.push({ i, step, side: 'mock', label: `on_${step.action}` });
  });
  return cards;
}

// The card's status from the tracked phase of its step.
function cardStatus(card, result, isNext) {
  const ph = result?.phase ?? 'waiting';
  if (card.side === 'send') {
    if (ph === 'waiting') return isNext ? ['awaiting', 'awaiting'] : ['pending', 'pending'];
    const ok = result.entry.response?.message?.ack?.status === 'ACK';
    return ok ? ['received', 'done'] : [`NACK ${result.entry.response?.error?.code ?? ''}`, 'bad'];
  }
  if (ph === 'waiting') return card.unsolicited && isNext ? ['sending soon', 'awaiting'] : ['on hold', 'pending'];
  if (ph === 'running') return ['sending…', 'running'];
  const cbs = result.entry.callbacks ?? [];
  const delivered = cbs.every((c) => c.delivery && !c.delivery.error && c.delivery.status >= 200 && c.delivery.status < 300);
  if (!delivered) {
    const d = cbs.find((c) => !c.delivery || c.delivery.error || c.delivery.status >= 300)?.delivery;
    return [`not delivered${d ? ` (${d.error ?? d.status})` : ''}`, 'bad'];
  }
  if (result.problem) return ['unexpected', 'bad'];
  const code = cbs.at(-1)?.body?.error?.code;
  return [code ? `sent · error ${code}` : 'sent · ACK', 'done'];
}

let selected = null; // { scId, cardIndex } shown in the inspector; null = follow the latest call
let tracked = { results: [], at: '' };

function flowCard(sc) {
  const running = runningScenario()?.id === sc.id;
  const cards = cardsOf(sc);
  const results = running ? tracked.results : [];
  const nextStep = running ? results.findIndex((r) => r.phase === 'waiting') : -1;
  const doneCards = cards.filter((c) => {
    const r = results[c.i];
    return r && (c.side === 'send' ? r.phase !== 'waiting' : r.phase === 'completed');
  }).length;
  const pct = running ? Math.round((doneCards / cards.length) * 100) : 0;

  const play = el('button', { class: 'round play', type: 'button', 'data-needs-bap': '', 'data-title': running ? 'Restart this flow' : 'Start this flow', 'aria-label': `Start ${sc.title}` }, running ? '↻' : '▶');
  play.onclick = (e) => { e.stopPropagation(); start(sc); };
  const stopBtn = running ? el('button', { class: 'round stop', type: 'button', title: 'Stop this flow', 'aria-label': `Stop ${sc.title}`, onclick: (e) => { e.stopPropagation(); stop(); } }, '■') : null;

  const grid = el('div', { class: 'call-grid' });
  for (let k = 0; k < cards.length; k++) {
    const c = cards[k];
    const r = results[c.i];
    const [text, cls] = cardStatus(c, r, running && c.i === nextStep);
    const node = el('button', { class: `call-card ${cls} ${c.unsolicited ? 'wide' : ''} ${selected?.scId === sc.id && selected.cardIndex === k ? 'selected' : ''}`, type: 'button',
      onclick: () => { selected = { scId: sc.id, cardIndex: k }; renderFlows(); } },
      el('div', { class: 'call-top' }, el('span', { class: 'call-name' }, el('span', { class: 'muted' }, `${k + 1}: `), c.label),
        c.unsolicited ? el('span', { class: 'tag' }, 'UNSOLICITED') : null),
      el('div', { class: 'call-bottom' }, el('span', { class: `who ${c.side}` }, c.side === 'send' ? 'YOU SEND' : 'MOCK'), el('span', { class: `status ${cls}` }, text)));
    if (c.side === 'send' && cards[k + 1]?.side === 'mock' && !cards[k + 1].unsolicited) {
      const n2 = cards[k + 1];
      const r2 = results[n2.i];
      const [t2, c2] = cardStatus(n2, r2, running && n2.i === nextStep);
      const node2 = el('button', { class: `call-card ${c2} ${selected?.scId === sc.id && selected.cardIndex === k + 1 ? 'selected' : ''}`, type: 'button',
        onclick: () => { selected = { scId: sc.id, cardIndex: k + 1 }; renderFlows(); } },
        el('div', { class: 'call-top' }, el('span', { class: 'call-name' }, el('span', { class: 'muted' }, `${k + 2}: `), n2.label)),
        el('div', { class: 'call-bottom' }, el('span', { class: 'who mock' }, 'MOCK'), el('span', { class: `status ${c2}` }, t2)));
      grid.append(el('div', { class: 'call-pair' }, node, el('span', { class: 'swap', 'aria-hidden': 'true' }, '⇄'), node2));
      k++;
    } else {
      grid.append(node);
    }
  }

  const expanded = running || openFlows.has(sc.id);
  const card = el('section', { class: `flow ${running ? 'running' : ''}` },
    el('div', { class: 'flow-head', onclick: () => { openFlows.has(sc.id) ? openFlows.delete(sc.id) : openFlows.add(sc.id); renderFlows(); } },
      el('div', { class: 'flow-text' },
        el('div', { class: 'flow-title' }, el('h3', {}, sc.title), sc.mode ? el('span', { class: 'tag' }, MODE_LABELS[sc.mode]) : null),
        el('div', { class: 'progress' }, el('span', { style: `width:${pct}%` })),
        el('p', { class: 'muted' }, sc.summary)),
      el('span', { class: 'pct' }, `${pct}%`),
      el('div', { class: 'flow-actions' }, play, stopBtn),
      el('span', { class: 'chev', 'aria-hidden': 'true' }, expanded ? '▴' : '▾')),
    expanded ? recommendedPanel(sc) : null,
    expanded ? grid : null);
  return card;
}

// What to add in the app so the flow completes: seller, items and quantities, then each step.
function recommendedPanel(sc) {
  const rec = recommendation(sc, tracked.catalog);
  if (!rec) return null;
  const copyCart = () => navigator.clipboard?.writeText(json(rec.lines.map((l) => ({ id: l.id, quantity: { count: l.count } }))));
  return el('div', { class: 'recommend' },
    el('div', { class: 'recommend-head' }, el('b', {}, 'Recommended cart'),
      el('span', { class: 'muted' }, 'Seller ', idTag(rec.provider.id), ` ${rec.provider.name} · retailer ${rec.retailer.shop_name ?? rec.retailer.name ?? 'walk-in'}`),
      el('button', { class: 'ghost tiny', type: 'button', title: 'Copy the items with their ids', onclick: copyCart }, 'Copy items')),
    el('table', { class: 'recommend-items' },
      el('tbody', {}, rec.lines.map((l) => el('tr', { class: l.target ? 'target' : '' },
        el('td', {}, idTag(l.id)), el('td', {}, l.name ?? ''), el('td', { class: 'num' }, `× ${l.count}`),
        el('td', { class: 'num muted' }, `₹${l.price} · MOQ ${l.moq}`), el('td', { class: 'num' }, `₹${l.total}`),
        el('td', {}, l.target ? el('span', { class: 'pill warn' }, `seller: ${MODE_LABELS[sc.mode] ?? 'affected'}`) : null)))),
      el('tfoot', {}, el('tr', {}, el('td', { colspan: '4' }, el('span', { class: 'muted' }, `Seller minimum order value ₹${rec.minValue}`)), el('td', { class: 'num' }, el('b', {}, `₹${rec.value}`)), el('td', {})))),
    rec.note ? el('p', { class: 'recommend-note' }, rec.note) : null,
    el('details', { class: 'recommend-steps' }, el('summary', {}, 'Steps with this cart'),
      el('ol', {}, rec.steps.map((t) => el('li', {}, t.buyer, el('div', { class: 'muted' }, `→ ${t.expect}`))))));
}

const openFlows = new Set();

function renderFlows() {
  const list = $('#flowList');
  const groups = [...new Set(SCENARIOS.map((s) => s.group))];
  list.replaceChildren(...groups.flatMap((g) => [el('h4', { class: 'group' }, g), ...SCENARIOS.filter((s) => s.group === g).map(flowCard)]));
  refreshTarget();
  renderInspector();
}

// ---- inspector: Request / Response / Guide of the selected call -----------------------------
let inspTab = 'request';
for (const b of document.querySelectorAll('[data-insp]')) b.onclick = () => { inspTab = b.dataset.insp; renderInspector(); };
$('#inspSearch').addEventListener('input', () => renderInspector());

function inspected() {
  const sc = selected ? SCENARIOS.find((x) => x.id === selected.scId) : runningScenario();
  if (!sc) return null;
  const cards = cardsOf(sc);
  const running = runningScenario()?.id === sc.id;
  const results = running ? tracked.results : [];
  let k = selected?.scId === sc.id ? selected.cardIndex : -1;
  if (k === -1) {
    // Follow the flow: the last card with something to show, else the first awaited one.
    for (let j = cards.length - 1; j >= 0; j--) if (results[cards[j].i]?.entry) { k = cards[j].side === 'send' && cards[j + 1]?.side === 'mock' && !cards[j + 1].unsolicited ? j + 1 : j; break; }
    if (k === -1) k = 0;
  }
  return { sc, card: cards[k], k, result: results[cards[k].i], running };
}

function inspectorContent({ card, result, sc }) {
  const entry = result?.entry;
  const state = newState(sc);
  if (inspTab === 'guide') {
    return [
      `${card.side === 'send' ? 'YOU SEND' : 'MOCK'} · ${card.label}`,
      '',
      card.side === 'send' ? `In your app: ${buyerText(card.step, { ...state, cart: [], modeItems: armed?.items })}` : `The mock answers: ${result?.expect ?? expectText(card.step, { ...state, cart: [] })}`,
      '',
      ...(result?.problem ? [`Unexpected: ${result.problem}`] : []),
    ].join('\n');
  }
  if (!entry) {
    return card.side === 'send' ? `// awaiting /${card.step.action} from your app` : `// on hold until /${card.step.action} arrives`;
  }
  if (card.side === 'send') return json(inspTab === 'request' ? entry.request : entry.response);
  const cbs = entry.callbacks ?? [];
  if (inspTab === 'request') {
    const bodies = cbs.map((c) => ({ url: c.url, ...(c.delay_ms ? { delay_ms: c.delay_ms } : {}), headers: c.headers, body: c.body }));
    return json(bodies.length === 1 ? bodies[0] : bodies);
  }
  const replies = cbs.map((c) => {
    if (!c.delivery) return { status: 'sending…' };
    let body = c.delivery.body;
    try { body = JSON.parse(body); } catch { /* not JSON */ }
    return { status: c.delivery.status ?? c.delivery.error, body };
  });
  return json(replies.length === 1 ? replies[0] : replies);
}

function renderInspector() {
  for (const b of document.querySelectorAll('[data-insp]')) b.setAttribute('aria-selected', String(b.dataset.insp === inspTab));
  const x = inspected();
  if (!x) {
    $('#inspTitle').textContent = 'Select a call';
    $('#inspBody').textContent = '{}';
    return;
  }
  $('#inspTitle').replaceChildren(el('b', {}, `${x.k + 1}: ${x.card.label}`), ' ', el('span', { class: 'muted' }, `· ${x.sc.title}`),
    selected ? el('button', { class: 'ghost tiny', type: 'button', onclick: () => { selected = null; renderFlows(); } }, 'Follow live') : null);
  const text = inspectorContent(x);
  const q = $('#inspSearch').value.trim().toLowerCase();
  $('#inspBody').textContent = q ? text.split('\n').filter((l) => l.toLowerCase().includes(q)).join('\n') || '// no line matches' : text;
}

// ---- start / stop ---------------------------------------------------------------------------
async function start(sc) {
  if (!bapId()) return;
  // The seller mode hits the recommended item when the app orders it (else the first item of the cart).
  const items = sc.recommend?.target ? [sc.recommend.target] : undefined;
  const m = await post('/api/mock/mode', { bap_id: bapId(), mode: sc.mode ?? 'normal', scenario: sc.id, items });
  if (m.error) return $('#targetHint').replaceChildren(el('span', { class: 'pill bad' }, m.error));
  armed = { mode: m.mode, items: m.items, scenario: m.scenario, at: m.at };
  tracked = { ...tracked, results: [], at: m.at };
  selected = null;
  fired.clear();
  openFlows.add(sc.id);
  renderFlows();
  poll(true);
}
async function stop() {
  await post('/api/mock/mode', { bap_id: bapId(), mode: 'normal' });
  armed = { mode: 'normal', items: [], scenario: undefined, at: undefined };
  tracked = { ...tracked, results: [], at: '' };
  $('#liveState').textContent = '';
  renderFlows();
}

// ---- live tracking --------------------------------------------------------------------------
// Each poll re-matches the app's calls since the flow started to its steps. When the next step is
// the seller's own (UNSOLICITED), the page sends it once the step before it has completed.
const fired = new Set();
let lastKey = '';
function track(activity) {
  const sc = runningScenario();
  if (!sc) return void ($('#liveState').textContent = '');
  const entries = activity.filter((a) => a.at >= (armed.at ?? '')).reverse();
  const key = entries.map((a) => a.id + a.status + (a.callbacks ?? []).map((c) => c.delivery?.status ?? '').join()).join();
  const results = trackLive(sc, entries, { catalog: tracked.catalog ?? [], modeItems: armed.items ?? [] });
  tracked = { ...tracked, results };
  const next = results.findIndex((r) => r.phase === 'waiting');
  const prevDone = next >= 0 && results.slice(0, next).every((r) => r.phase === 'completed');
  const step = sc.steps[next];
  if (next !== -1 && step.action === 'push' && prevDone && step.ready(results.state) && !fired.has(next)) {
    fired.add(next);
    const body = step.build({ bap: pushBap() }, results.state);
    setTimeout(() => post('/api/mock/push', body, { 'X-Mock-Deliver': 'wait' }).then(() => poll(true)), 1200);
  }
  const done = next === -1 && results.every((r) => r.phase !== 'running');
  $('#liveState').textContent = done ? (results.some((r) => r.problem) ? `${sc.title}: completed with unexpected answers` : `${sc.title}: completed`) : `${sc.title}: running · live`;
  if (key !== lastKey) {
    lastKey = key;
    renderFlows();
  }
}

// ---- polling + all calls --------------------------------------------------------------------
let pollTimer;
let seenAll = '';
async function poll(force = false) {
  clearTimeout(pollTimer);
  if (bapId()) {
    try {
      const data = await fetch(`/api/mock/activity?bap_id=${encodeURIComponent(bapId())}`, { cache: 'no-store' }).then((r) => r.json());
      track(data.activity);
      const key = data.activity.map((a) => a.id + a.status).join() + json(data.orders.map((o) => [o.id, o.state, o.fulfillment_state, o.history.length]));
      if (force || key !== seenAll) {
        seenAll = key;
        renderActivity(data.activity);
        renderOrders(data.orders, data.activity);
      }
      $('#activityCount').textContent = data.activity.length ? String(data.activity.length) : '';
      $('#activityState').textContent = `live · updated ${new Date().toLocaleTimeString()}`;
    } catch {
      $('#activityState').textContent = 'could not load activity';
    }
  } else {
    $('#activity').replaceChildren(el('p', { class: 'muted' }, 'Enter your app\'s bap_uri or bap_id above to see its calls.'));
    renderOrders([]);
  }
  pollTimer = setTimeout(poll, runningScenario() ? 1000 : 3000);
}

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
  if (extra) node.querySelector('summary').append(...[extra].flat().filter(Boolean));
  const body = node.querySelector('.call-body');
  for (const [title, value] of sections) {
    const text = typeof value === 'string' ? value : json(value);
    body.append(el('h5', {}, title, copyBtn(() => text)), el('pre', {}, text));
  }
  return node;
}

function deliveryPill(d) {
  if (!d) return null;
  let ack = '';
  try { ack = JSON.parse(d.body).message?.ack?.status ?? ''; } catch { /* not JSON */ }
  const ok = d.status >= 200 && d.status < 300 && ack === 'ACK';
  return el('span', { class: `pill ${ok ? 'ok' : 'bad'}` }, d.error ? `your app: ${d.error}` : `your app: ${d.status} ${ack}`.trim());
}

function callbackBlocks(callbacks, open) {
  return (callbacks ?? []).map((c) => {
    const meta = [c.headers?.['X-ONDC-Search-Response'] && `X-ONDC-Search-Response: ${c.headers['X-ONDC-Search-Response']}`, c.delay_ms ? `unsolicited, after ${c.delay_ms / 1000}s` : null, c.url && `→ ${c.url}`].filter(Boolean).join(' · ');
    const sections = [['callback body', c.body]];
    if (c.delivery) sections.push(['your app\'s response', c.delivery.error ?? c.delivery.body ?? '']);
    const error = c.body.error ? el('span', { class: 'pill bad' }, `error ${c.body.error.code}`) : null;
    return callBlock({ pill: 'CALLBACK', pillClass: 'cb', name: `/${c.body.context.action}`, meta, sections, open, extra: [error, deliveryPill(c.delivery)] });
  });
}

function renderActivity(entries) {
  if (!entries.length) return $('#activity').replaceChildren(el('p', { class: 'muted' }, `No calls yet. Point your app at ${BPP.uri} and make a call.`));
  $('#activity').replaceChildren(...entries.map((a) => {
    const ok = a.response?.message?.ack?.status === 'ACK';
    const who = a.kind === 'seller_action' ? `seller: ${a.scenario}` : `/${a.action}`;
    const meta = [new Date(a.at).toLocaleTimeString(), a.status, a.transaction_id && `txn ${String(a.transaction_id).slice(0, 8)}`].filter(Boolean).join(' · ');
    const node = callBlock({
      pill: ok ? 'ACK' : 'NACK', pillClass: ok ? 'ok' : 'bad', name: who, meta, open: false,
      sections: [[a.kind === 'seller_action' ? 'seller action' : 'request from your app', a.request], ['mock sync response', a.response]],
      extra: (a.callbacks ?? []).map((c) => deliveryPill(c.delivery) ?? el('span', { class: 'pill' }, 'sending…')),
    });
    node.querySelector('.call-body').append(...callbackBlocks(a.callbacks, false));
    return node;
  }));
}

// ---- orders ---------------------------------------------------------------------------------
// Every order the app confirmed through the mock: a list, and the selected order in detail (items,
// offers, quote, delivery, payment, its history and its calls), with the seller's actions on it.
const PUSH_EVENTS = ['packed', 'out_for_delivery', 'delivered', 'seller_cancel'];
const STATE_CLASS = { Accepted: 'ok', 'In-progress': 'warn', Completed: 'ok', Cancelled: 'bad' };
const EVENT_LABELS = { resend: 'Status re-sent', confirm: 'Order confirmed', packed: 'Packed', out_for_delivery: 'Out for delivery', delivered: 'Delivered', cancel: 'Cancelled' };
let selectedOrder = null;
let ordersSeen = { orders: [], activity: [] };

const when = (t) => (t ? new Date(t).toLocaleString() : '—');
const rupees = (v) => `₹${Number(v ?? 0).toFixed(2)}`;
const statePill = (state) => el('span', { class: `pill ${STATE_CLASS[state] ?? ''}` }, state ?? '—');
// An id as its short label, with the full id on hover and one click to copy it.
const idTag = (id) => el('code', { class: 'id-tag', title: `${id} (click to copy)`, onclick: () => navigator.clipboard?.writeText(id) }, label(id));

// The calls that belong to an order: its /confirm, /status, /cancel and the seller's pushes on it.
const callsOf = (orderId, activity) => activity.filter((a) => a.request?.message?.order?.id === orderId
  || a.request?.message?.order_id === orderId || a.request?.order_id === orderId).slice().reverse();

function renderOrders(orders, activity = []) {
  ordersSeen = { orders, activity };
  $('#orderCount').textContent = orders.length ? String(orders.length) : '';
  if (!bapId()) {
    $('#orderList').replaceChildren(el('p', { class: 'muted' }, 'Enter your app\'s bap_uri or bap_id above to see its orders.'));
    return void $('#orderDetail').replaceChildren();
  }
  if (!orders.length) {
    $('#orderList').replaceChildren(el('section', { class: 'card' }, el('p', { class: 'muted' }, 'No orders yet. Orders your app confirms through the mock (/confirm → on_confirm Accepted) show up here.')));
    return void $('#orderDetail').replaceChildren(el('p', { class: 'muted' }, 'Select an order.'));
  }
  if (!orders.some((o) => o.id === selectedOrder)) selectedOrder = orders[0].id;
  $('#orderList').replaceChildren(...orders.map((o) => el('button', {
    class: `order-row ${o.id === selectedOrder ? 'selected' : ''}`, type: 'button',
    onclick: () => { selectedOrder = o.id; renderOrders(ordersSeen.orders, ordersSeen.activity); },
  },
    el('span', { class: 'order-row-top' }, el('code', {}, o.id), statePill(o.state)),
    el('span', { class: 'order-row-mid' }, `${label(o.provider)} · ${o.order.provider?.descriptor?.short_desc ?? ''}`, el('b', {}, rupees(o.total))),
    el('span', { class: 'muted order-row-bot' }, `${o.retailer ?? 'walk-in'} · ${o.fulfillment_state ?? ''} · ${when(o.updated_at)}`),
  )));
  renderOrderDetail(orders.find((o) => o.id === selectedOrder), activity);
}

function renderOrderDetail(o, activity) {
  const order = o.order;
  const f = order.fulfillments?.[0] ?? {};
  const pay = order.payments?.[0] ?? {};
  const breakup = order.quote?.breakup ?? [];
  const lines = breakup.filter((b) => b['@ondc/org/title_type'] === 'item');
  const offers = breakup.filter((b) => b['@ondc/org/title_type'] === 'offer');
  const sum = (type) => breakup.filter((b) => b['@ondc/org/title_type'] === type).reduce((t, b) => t + Number(b.price.value), 0);
  const closed = ['Cancelled', 'Completed'].includes(order.state);
  const note = el('span', { class: 'muted' });
  const kv = (rows) => el('dl', { class: 'kv' }, ...rows.filter(([, v]) => v !== undefined && v !== null && v !== '').flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));
  const section = (title, ...kids) => el('section', { class: 'order-section' }, el('h4', {}, title), ...kids);
  const address = (a) => (a ? [a.building, a.locality, a.street, a.city, a.area_code].filter(Boolean).join(', ') : undefined);

  $('#orderDetail').replaceChildren(
    el('header', { class: 'order-head' },
      el('div', {},
        el('h3', {}, 'Order ', el('code', {}, order.id)),
        el('span', { class: 'muted' }, `txn ${o.transaction_id} · placed ${when(order.created_at)} · updated ${when(order.updated_at)}`)),
      el('div', { class: 'order-states' }, statePill(order.state), el('span', { class: 'pill' }, `fulfillment: ${o.fulfillment_state ?? '—'}`))),
    el('div', { class: 'order-actions' },
      el('span', { class: 'label' }, 'Seller actions'),
      ...PUSH_EVENTS.map((ev) => el('button', {
        class: ev === 'seller_cancel' ? 'ghost danger' : 'ghost', type: 'button',
        ...(closed ? { disabled: '', title: `Order is ${order.state}` } : { title: ev === 'seller_cancel' ? 'Unsolicited on_cancel (reason 005)' : 'Unsolicited on_status' }),
        onclick: async (e) => {
          e.currentTarget.disabled = true;
          const r = await post('/api/mock/push', { order_id: order.id, event: ev }, { 'X-Mock-Deliver': 'wait' }).catch((err) => ({ failed: err.message }));
          const d = r.callbacks?.[0]?.delivery;
          note.textContent = r.failed ? `Failed: ${r.failed}` : r.response?.error ? `NACK ${r.response.error.code}: ${r.response.error.message}` : `${r.callbacks[0].body.context.action} sent · your app answered ${d?.status ?? d?.error ?? '?'}`;
          poll(true);
        },
      }, PUSH_LABELS[ev])),
      el('button', {
        class: 'ghost', type: 'button', title: `Unsolicited ${order.state === 'Cancelled' ? 'on_cancel' : 'on_status'} with the order as it is now (${order.state} / ${o.fulfillment_state ?? '—'}), updated_at stamped now`,
        onclick: async (e) => {
          e.currentTarget.disabled = true;
          const r = await post('/api/mock/push', { order_id: order.id, event: 'resend_status' }, { 'X-Mock-Deliver': 'wait' }).catch((err) => ({ failed: err.message }));
          const d = r.callbacks?.[0]?.delivery;
          note.textContent = r.failed ? `Failed: ${r.failed}` : r.response?.error ? `NACK ${r.response.error.code}: ${r.response.error.message}` : `${r.callbacks?.[0]?.body?.context?.action} (${order.state} / ${o.fulfillment_state ?? '—'}) re-sent · your app answered ${d?.status ?? d?.error ?? '?'}`;
          poll(true);
        },
      }, `↻ ${PUSH_LABELS.resend_status}`),
      note),
    el('div', { class: 'order-grid' },
      section('Seller', kv([
        ['Provider', el('span', {}, `${order.provider?.descriptor?.short_desc ?? ''} × ${order.provider?.descriptor?.name ?? ''} `, idTag(order.provider?.id))],
        ['Ships from', f.start?.location ? el('span', {}, `${f.start.location.descriptor?.name ?? ''} `, idTag(f.start.location.id)) : undefined],
        ['Contact', f.start?.contact ? `${f.start.contact.phone} · ${f.start.contact.email}` : undefined],
      ])),
      section('Retailer', kv([
        ['Billing name', order.billing?.name],
        ['GSTIN', order.billing?.tax_number],
        ['customer.id', f.customer?.id ?? 'walk-in'],
        ['Phone', order.billing?.phone ?? f.end?.contact?.phone],
        ['Address', address(order.billing?.address)],
      ])),
      section('Delivery', kv([
        ['Option', el('span', {}, `${f['@ondc/org/category'] ?? ''} `, idTag(f.id))],
        ['TAT', f['@ondc/org/TAT']],
        ['State', o.fulfillment_state],
        ['Deliver to', address(f.end?.location?.address)],
        ['GPS', f.end?.location?.gps],
      ])),
      section('Payment', kv([
        ['Type', pay.type],
        ['Collected by', pay.collected_by],
        ['Status', pay.status],
        ['Amount', pay.params?.amount && rupees(pay.params.amount)],
        ['Settlement', [pay['@ondc/org/settlement_basis'], pay['@ondc/org/settlement_window']].filter(Boolean).join(' · ')],
      ])),
    ),
    section('Items', el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ...['item', 'name', 'qty', 'unit price', 'amount'].map((h) => el('th', {}, h)))),
      el('tbody', {}, lines.map((b) => el('tr', {},
        el('td', {}, idTag(b['@ondc/org/item_id'])),
        el('td', {}, b.title),
        el('td', { class: 'num' }, String(b['@ondc/org/item_quantity']?.count ?? '')),
        el('td', { class: 'num' }, rupees(b.item?.price?.value)),
        el('td', { class: 'num' }, rupees(b.price.value)),
      ))),
    ))),
    offers.length ? section('Offers applied', el('ul', { class: 'plain' }, offers.map((b) => el('li', {}, idTag(b['@ondc/org/item_id']), ` ${b.title} `, el('b', {}, rupees(b.price.value)))))) : null,
    section('Quote', el('dl', { class: 'kv totals' },
      el('dt', {}, 'Items'), el('dd', {}, rupees(sum('item'))),
      el('dt', {}, 'Offers'), el('dd', {}, rupees(sum('offer'))),
      el('dt', {}, 'Delivery'), el('dd', {}, rupees(sum('delivery'))),
      el('dt', {}, 'Tax'), el('dd', {}, rupees(sum('tax'))),
      el('dt', {}, el('b', {}, 'Total')), el('dd', {}, el('b', {}, rupees(order.quote?.price?.value))))),
    section('History', el('ol', { class: 'timeline' }, (o.history.length ? o.history : [{ at: order.created_at, event: 'confirm', by: 'buyer', state: order.state }]).map((h) => el('li', {},
      el('b', {}, EVENT_LABELS[h.event] ?? h.event), ` · by ${h.by}`, h.reason ? ` · reason ${h.reason}` : '',
      el('span', { class: 'muted' }, ` · ${h.state}${h.fulfillment_state ? ` / ${h.fulfillment_state}` : ''} · ${when(h.at)}`))))),
    section('Calls for this order', (() => {
      const calls = callsOf(order.id, activity);
      if (!calls.length) return el('p', { class: 'muted' }, 'None in the recent activity log.');
      return el('ul', { class: 'plain calls' }, calls.map((a) => {
        const cbs = a.callbacks ?? [];
        const answered = cbs.map((c) => `${c.body?.context?.action} → ${c.delivery?.status ?? c.delivery?.error ?? (a.status === 'running' ? 'sending…' : '?')}`).join(', ');
        return el('li', {}, el('code', {}, a.kind === 'seller_action' ? `seller ${a.request?.event}` : `/${a.action}`), ` ${a.response?.message?.ack?.status ?? ''} · ${answered} `, el('span', { class: 'muted' }, when(a.at)));
      }));
    })()),
    el('details', { class: 'order-json' }, el('summary', {}, 'Order JSON (as the seller holds it)'), el('pre', {}, json(order))),
  );
}

// ---- catalogue ------------------------------------------------------------------------------
const tagList = (tags, code) => (tags.find((t) => t.code === code)?.list ?? []).map((e) => `${e.code} ${e.value === '' ? '(no upper limit)' : e.value}`).join(', ');

function offersTable(p) {
  if (!p.offers?.length) return null;
  return el('div', { class: 'table-wrap offers' }, el('table', {},
    el('thead', {}, el('tr', {}, ...['offer', 'type', 'items', 'qualifier', 'benefit', 'meta'].map((h) => el('th', {}, h)))),
    el('tbody', {}, p.offers.map((o) => el('tr', {},
      el('td', {}, idTag(o.id)),
      el('td', {}, o.descriptor.code),
      el('td', {}, ...o.item_ids.map(idTag)),
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
  const providers = await getCatalog();
  const box = $('#catalogue');
  for (const p of providers) {
    const svc = p.tags.filter((t) => t.code === 'serviceability').map((t) => t.list.find((e) => e.code === 'unit').value);
    const minOrder = p.tags.find((t) => t.code === 'order_value').list[0].value;
    const rows = p.items.map((i) => el('tr', {},
      el('td', {}, el('img', { class: 'thumb', src: i.descriptor.symbol, alt: '' })),
      el('td', {}, idTag(i.id)),
      el('td', {}, i.descriptor.name),
      el('td', {}, i.parent_item_id ? idTag(i.parent_item_id) : '—'),
      el('td', {}, i.category_id),
      el('td', {}, idTag(i.location_id)),
      el('td', { class: 'num' }, `₹${i.price.value}`),
      el('td', { class: 'num' }, `₹${i.price.maximum_value}`),
      el('td', { class: 'num' }, `${i.quantity.minimum.count} – ${i.quantity.maximum.count}`),
    ));
    box.append(el('section', { class: 'card provider' },
      el('header', {},
        el('h3', {}, `${label(p.id)} · ${p.descriptor.short_desc} × ${p.descriptor.name}`),
        el('code', { class: 'muted' }, `provider id ${p.id}`),
        el('span', { class: 'muted' }, `${p.descriptor.code} · locations ${p.locations.map((l) => `${label(l.id)} ${l.address.locality}`).join(', ')} · min order ₹${minOrder}`),
        el('span', { class: 'pill' }, `serviceability: ${[...new Set(svc)].join(', ')} (pan-India)`),
        sellerSwitch(p.id),
      ),
      el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, ...['', 'id', 'name', 'variant', 'category', 'location', 'price', 'MRP', 'MOQ – max'].map((h) => el('th', {}, h)))),
        el('tbody', {}, rows),
      )),
      offersTable(p),
    ));
  }
}

// The seller deactivates / reactivates a provider for the app entered above, by hand: an unsolicited
// incremental on_search (time.label disable / enable). The reply shows next to the buttons.
function sellerSwitch(providerId) {
  const note = el('span', { class: 'muted' });
  const button = (event, text, cls) => el('button', { class: cls, type: 'button', onclick: async (e) => {
    if (!bapId()) return void (note.textContent = 'Enter your bap_uri (or bap_id) under Endpoints first.');
    e.currentTarget.disabled = true;
    try {
      const r = await post('/api/mock/push', R.providerPush({ bap: pushBap(), providerId, event }), { 'X-Mock-Deliver': 'wait' });
      const delivery = r.callbacks?.[0]?.delivery;
      note.textContent = r.response?.error ? `NACK: ${r.response.error.message}` : `on_search sent · your app answered ${delivery?.status ?? delivery?.error ?? '?'}`;
      poll(true);
    } catch (err) {
      note.textContent = `Failed: ${err.message}`;
    } finally {
      e.currentTarget.disabled = false;
    }
  } }, text);
  return el('span', { class: 'actions' }, button('provider_disable', 'Deactivate seller', 'ghost danger'), button('provider_enable', 'Activate seller', 'ghost'), note);
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
    el('td', {}, r.providers ? Object.entries(r.providers).map(([id, t]) => `${label(id)} (credit ₹${t.credit_limit}, POC ${t.poc.name})`).join('; ') : r.kind === 'new' ? 'not held - register with P1' : 'P3 only - no registration'),
  ));
  $('#retailers').append(el('section', { class: 'card' },
    el('p', { class: 'muted' }, 'Retailers the mock Seller NP knows. A retailer is resolved when the request fully satisfies one type=existing variant: customer_id, or phone_number + PAN. Any other identity is "not found" (empty bpp/providers).'),
    el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ...['shop', 'customer_id', 'phone', 'PAN', 'GSTIN', 'pincode', 'mapped providers'].map((h) => el('th', {}, h)))),
      el('tbody', {}, rows),
    )),
  ));
}

showTab(['flows', 'orders', 'activity', 'catalogue', 'retailers'].includes(store.get('tab', '')) ? store.get('tab', '') : 'flows');
getCatalog().then((c) => {
  tracked.catalog = c;
  renderFlows();
});
loadHealth();
loadArmed();
loadCallers();
setInterval(loadCallers, 10000);
poll();
