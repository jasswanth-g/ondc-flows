import { SCENARIOS, newState, runStep, expectText, buyerText, trackLive, ensureCatalog, PUSH_LABELS } from './shared/scenarios.js';
import { RETAILERS, NEW_RETAILER, WALK_IN_RETAILER } from './shared/retailers.js';
import * as R from './shared/requests.js';

// The buyer app makes every ONDC call; the mock only answers. This page:
//   - activates a scenario (the seller mode) for the buyer app's bap_id,
//   - tells the developer what to do in the app, and shows the calls that arrive (Activity),
//   - runs seller actions (fulfillment updates, seller cancel) on orders the app confirmed,
//   - simulates any step in sync mode, which sends nothing to the buyer app.

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
$('#bppUri').textContent = BPP.uri;

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

// ---- the buyer app --------------------------------------------------------------------------
const bapIdInput = $('#bapId');
bapIdInput.value = store.get('bapId', '');
// The buyer app is identified by its bap_id or bap_uri; the mock matches calls by either.
const bapId = () => bapIdInput.value.trim().replace(/\/+$/, '');

const MODE_LABELS = {
  normal: 'Normal', item_inactive: 'Item inactive', out_of_stock: 'Out of stock', partial_quantity: 'Partial quantity',
  price_changed: 'Price changed', init_qty_reduced: 'Quantity reduced at init', confirm_rejected: 'Seller rejects confirm',
};
let armed = null; // { mode, items, scenario, at } armed for bapId()

function refreshTarget() {
  store.set('bapId', bapId());
  bapIdInput.classList.toggle('needs', !bapId());
  const running = armed?.scenario && SCENARIOS.find((x) => x.id === armed.scenario);
  $('#targetHint').replaceChildren(...(bapId()
    ? ['Point the app at ', el('code', {}, BPP.uri), '. ',
      running ? el('span', {}, 'Running: ', el('b', {}, running.title), armed.mode !== 'normal' ? ` (seller mode ${MODE_LABELS[armed.mode]}${armed.items?.length ? `, items ${armed.items.join(', ')}` : ''})` : '', '.')
        : 'Press ▶ on a scenario to start it.']
    : [el('b', {}, 'Enter your buyer app\'s bap_id or bap_uri.'), ' The mock matches your app\'s calls by either.']));
  for (const b of document.querySelectorAll('[data-needs-bap]')) {
    b.disabled = !bapId();
    b.title = bapId() ? (b.dataset.title ?? '') : 'Enter your buyer app\'s bap_id or bap_uri above';
  }
  for (const b of document.querySelectorAll('.scenario-item')) b.classList.toggle('running', Boolean(running) && b.dataset.id === running.id);
}

// Buyer apps that called the mock recently: one click fills the field with what the app really sends.
async function loadCallers() {
  try {
    const { callers = [] } = await fetch('/api/mock/activity', { cache: 'no-store' }).then((r) => r.json());
    $('#callers').replaceChildren(...(callers.length
      ? [el('span', { class: 'muted' }, 'Recent callers:'), ...callers.map((c) => el('button', {
          class: `ghost chip ${c.bap_id === bapId() || c.bap_uri === bapId() ? 'current' : ''}`, type: 'button', title: c.bap_uri ? `bap_uri ${c.bap_uri}` : '',
          onclick: () => { bapIdInput.value = c.bap_id; refreshTarget(); loadArmed(); loadCallers(); pollActivity(true); },
        }, c.bap_id))]
      : []));
  } catch { /* optional hint */ }
}
setInterval(loadCallers, 10000);

async function loadArmed() {
  armed = null;
  if (bapId()) {
    const m = await fetch(`/api/mock/mode?bap_id=${encodeURIComponent(bapId())}`).then((r) => r.json());
    armed = { mode: m.mode, items: m.items ?? [], scenario: m.scenario, at: m.at };
  }
  refreshTarget();
  if (currentScenario) renderScenario(currentScenario);
}
let bapTimer;
bapIdInput.addEventListener('input', () => {
  refreshTarget();
  clearTimeout(bapTimer);
  bapTimer = setTimeout(() => { loadArmed(); pollActivity(true); }, 400);
});

// ---- rendering calls ------------------------------------------------------------------------
const copyBtn = (getText) => el('button', { class: 'ghost', type: 'button', onclick: async (e) => {
  await navigator.clipboard.writeText(getText());
  e.target.textContent = 'Copied';
  setTimeout(() => (e.target.textContent = 'Copy'), 1200);
} }, 'Copy');

document.addEventListener('click', async (e) => {
  const sel = e.target.closest('[data-copy]')?.dataset.copy;
  if (!sel) return;
  await navigator.clipboard.writeText($(sel).textContent);
  e.target.textContent = 'Copied';
  setTimeout(() => (e.target.textContent = 'Copy'), 1200);
});

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

// What the buyer app answered to one delivered callback.
function deliveryPill(d) {
  if (!d) return null;
  let ack = '';
  try { ack = JSON.parse(d.body).message?.ack?.status ?? ''; } catch { /* not JSON */ }
  const ok = d.status >= 200 && d.status < 300 && ack === 'ACK';
  return el('span', { class: `pill ${ok ? 'ok' : 'bad'}` }, d.error ? `buyer app: ${d.error}` : `buyer app: ${d.status} ${ack}`.trim());
}

function callbackBlocks(callbacks, open) {
  return (callbacks ?? []).map((c) => {
    const meta = [c.headers?.['X-ONDC-Search-Response'] && `X-ONDC-Search-Response: ${c.headers['X-ONDC-Search-Response']}`, c.delay_ms ? `unsolicited, after ${c.delay_ms / 1000}s` : null, c.url && `→ ${c.url}`].filter(Boolean).join(' · ');
    const sections = [['callback body', c.body]];
    if (c.delivery) sections.push(['buyer app response', c.delivery.error ?? c.delivery.body ?? '']);
    const error = c.body.error ? el('span', { class: 'pill bad' }, `error ${c.body.error.code}`) : null;
    return callBlock({ pill: 'CALLBACK', pillClass: 'cb', name: `/${c.body.context.action}`, meta, sections, open, extra: [error, deliveryPill(c.delivery)] });
  });
}

// ---- tabs -----------------------------------------------------------------------------------
function showTab(name) {
  for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const s of document.querySelectorAll('.tab')) s.hidden = s.id !== `tab-${name}`;
  store.set('tab', name);
  if (name === 'catalogue') loadCatalogue();
  if (name === 'activity') pollActivity(true);
}
for (const b of document.querySelectorAll('[data-tab]')) b.onclick = () => showTab(b.dataset.tab);

// ---- scenarios ------------------------------------------------------------------------------
let catalogPromise;
const getCatalog = () => (catalogPromise ??= post('/ondc/search', R.searchBroadcast({ bap: R.BAP }), { 'X-Mock-Sync': 'true' })
  .then((r) => r.callbacks[0].body.message.catalog['bpp/providers']));

// Simulation only: sync mode, so nothing reaches the buyer app. The scenario's mode rides on the request.
const simulate = (action, body, mode = { name: 'normal', items: [] }) => post(action === 'push' ? '/api/mock/push' : `/ondc/${action}`, body, {
  'X-Mock-Sync': 'true',
  'X-Mock-Mode': mode.name,
  ...(mode.items?.length ? { 'X-Mock-Mode-Items': mode.items.join(',') } : {}),
});

const overrides = {}; // simulation cart / affected item per scenario
let currentScenario;
let live = null; // the active scenario being tracked: { sc, steps, catalog, key }

const isActive = (sc) => armed && armed.scenario === sc.id && armed.mode === (sc.mode ?? 'normal');

// ▶ starts a scenario for the buyer app (arms its seller mode and starts tracking from now);
// ■ stops it (seller back to normal).
async function start(sc, items = '') {
  if (!bapId()) return;
  const m = await post('/api/mock/mode', { bap_id: bapId(), mode: sc.mode ?? 'normal', items, scenario: sc.id });
  if (m.error) return alertBox(m.error);
  armed = { mode: m.mode, items: m.items, scenario: m.scenario, at: m.at };
  refreshTarget();
  await renderScenario(sc);
  pollActivity(true);
}
async function stop(sc) {
  await post('/api/mock/mode', { bap_id: bapId(), mode: 'normal' });
  armed = { mode: 'normal', items: [], scenario: undefined, at: undefined };
  refreshTarget();
  renderScenario(sc);
}
const alertBox = (msg) => $('#scenarioRun').prepend(el('p', { class: 'pill bad' }, msg));

function controls(sc) {
  const active = isActive(sc);
  const items = sc.mode ? el('input', { class: 'items', placeholder: 'affected items (optional), e.g. I1,I2', spellcheck: 'false', value: active ? (armed.items ?? []).join(',') : '' }) : null;
  const startBtn = el('button', { class: 'play big', type: 'button', 'data-needs-bap': '', 'data-title': 'Start this scenario for your app' }, active ? '↻ Restart' : '▶ Start');
  startBtn.onclick = () => start(sc, items?.value ?? '');
  const stopBtn = active ? el('button', { class: 'ghost', type: 'button', onclick: () => stop(sc) }, '■ Stop') : null;
  return el('div', { class: 'controls' }, startBtn, stopBtn, items,
    el('span', { class: 'muted' }, active
      ? `Running since ${new Date(armed.at).toLocaleTimeString()} - use your app; each step updates as its call arrives.`
      : sc.mode ? `Seller mode: ${MODE_LABELS[sc.mode]} on the items your app orders.` : 'Normal seller.'));
}

async function renderScenario(sc) {
  currentScenario = sc;
  store.set('scenario', sc.id);
  for (const b of document.querySelectorAll('.scenario-item')) b.classList.toggle('current', b.dataset.id === sc.id);
  const state = newState(sc, overrides[sc.id]);
  state.catalog = await getCatalog();
  await ensureCatalog(state, { bap: R.BAP }); // fills a random cart for any-items scenarios

  const steps = sc.steps.map((step) => {
    const status = el('span', { class: 'pill' }, '');
    const detail = el('div', { class: 'out live-detail' });
    // Any-items flows: the affected item is only known once the app's /select arrives.
    const expect = el('span', {}, expectText(step, state.anyItems ? { ...state, cart: [] } : state));
    const li = el('li', { class: 'buyer-step' },
      el('div', { class: 'step-title' }, el('b', {}, step.name), ' ', el('code', {}, step.action === 'push' ? 'seller action' : `/${step.action} → /on_${step.action}`), status),
      el('div', {}, el('span', { class: 'who' }, step.action === 'push' ? 'Seller' : 'In your app'), state.anyItems ? buyerText(step, { ...state, cart: [], modeItems: armed?.items }) : buyerText(step, state)),
      el('div', { class: 'muted' }, el('span', { class: 'who' }, 'Mock answers'), expect),
      detail);
    return { step, li, status, detail, expect };
  });
  live = isActive(sc) ? { sc, steps, catalog: state.catalog, key: '' } : null;

  $('#scenarioRun').replaceChildren(
    el('div', { class: 'run-head' },
      el('div', {}, el('span', { class: 'pill' }, sc.group), el('h2', {}, sc.title), el('p', { class: 'muted' }, sc.summary))),
    controls(sc),
    el('h3', {}, live ? 'Live - waiting for your app' : 'Steps'),
    el('ol', { class: 'buyer-steps' }, steps.map((r) => r.li)),
    live ? null : el('p', { class: 'hint' }, 'Press ▶ Start, then use your app: each step goes waiting → running → completed as its call arrives.'),
    simulation(sc, state),
  );
  refreshTarget();
}

// Simulation: the same steps run in sync mode against the mock, showing the request the app should
// send and the callback it will get. Nothing is sent to the buyer app.
function simulation(sc, state) {
  const box = el('div', { class: 'out' });
  let done = 0;
  const mode = () => ({ name: state.mode, items: state.target ? [state.target] : [] });
  const rows = sc.steps.map((step, i) => {
    const out = el('div', { class: 'out step-out' });
    const status = el('span', { class: 'pill' }, '');
    const btn = el('button', { class: 'ghost', type: 'button' }, 'Simulate');
    const row = el('div', { class: 'step' }, el('div', { class: 'step-head' }, el('span', { class: 'step-no' }, String(i + 1)), el('b', {}, step.name), status, el('span', { class: 'spacer' }), btn), out);
    btn.onclick = async () => {
      btn.disabled = true;
      out.replaceChildren();
      try {
        const { request, reply, problem } = await runStep(step, state, { bap: R.BAP, bpp: BPP, send: (a, b) => simulate(a, b, mode()) });
        out.append(
          callBlock({ pill: 'REQUEST', pillClass: 'cb', name: step.action === 'push' ? 'seller action' : `/${step.action}`, sections: [[step.action === 'push' ? 'seller action' : 'what your app sends', request]], open: false }),
          ...callbackBlocks(reply.callbacks, true));
        status.textContent = problem ? `unexpected: ${problem}` : 'as expected';
        status.className = `pill ${problem ? 'bad' : 'ok'}`;
        if (!problem) done = Math.max(done, i + 1);
      } catch (err) {
        status.textContent = err.message;
        status.className = 'pill bad';
      }
      refresh();
    };
    return { row, btn };
  });
  const refresh = () => rows.forEach((r, i) => {
    r.row.classList.toggle('locked', i > done);
    r.btn.disabled = i > done;
    r.btn.title = i > done ? 'Simulate the previous step first' : '';
  });
  refresh();
  box.append(...rows.map((r) => r.row));

  const provider = state.catalog.find((p) => p.id === sc.providerId);
  return el('details', { class: 'card simulation' },
    el('summary', {}, el('b', {}, 'Simulate'), el('span', { class: 'muted' }, ' - see the exact request and callback for each step. Nothing is sent to your app.')),
    state.cart.length ? cartEditor(sc, state, provider) : null,
    box);
}

function cartEditor(sc, state, provider) {
  const rows = el('div', { class: 'cart-rows' });
  const itemOptions = (selected) => provider.items.map((i) => el('option', { value: i.id, ...(i.id === selected ? { selected: '' } : {}) }, `${i.id} · ${i.descriptor.name} · ₹${i.price.value}`));
  const addRow = (line) => {
    const pick = el('select', {}, itemOptions(line.id));
    const qty = el('input', { type: 'number', min: '1', value: String(line.count), class: 'qty' });
    const row = el('div', { class: 'cart-row' }, pick, qty, el('button', { class: 'ghost', type: 'button', onclick: () => row.remove() }, '✕'));
    rows.append(row);
  };
  state.cart.forEach(addRow);
  const affected = sc.mode ? el('select', {}, state.cart.map((l) => el('option', { value: l.id, ...(l.id === state.target ? { selected: '' } : {}) }, l.id))) : null;
  const apply = () => {
    const cart = [...rows.children].map((r) => ({ id: r.querySelector('select').value, count: Number(r.querySelector('input').value) })).filter((l) => l.count > 0);
    overrides[sc.id] = { cart, target: affected?.value && cart.some((l) => l.id === affected.value) ? affected.value : cart[0]?.id };
    renderScenario(sc);
  };
  return el('div', { class: 'cart' },
    el('div', { class: 'cart-head' }, el('b', {}, `Simulation cart · ${provider.id} ${provider.descriptor.short_desc}`),
      sc.anyItems ? el('span', { class: 'muted' }, 'random items - your app can order anything') : null),
    rows,
    el('div', { class: 'row' },
      el('button', { class: 'ghost', type: 'button', onclick: () => addRow({ id: provider.items[0].id, count: Number(provider.items[0].quantity.minimum.count) }) }, '+ Add item'),
      affected ? el('label', { class: 'inline' }, 'Affected item ', affected) : null,
      el('button', { type: 'button', onclick: apply }, 'Apply'),
      el('button', { class: 'ghost', type: 'button', onclick: () => { delete overrides[sc.id]; renderScenario(sc); } }, sc.anyItems ? 'Shuffle' : 'Default cart')));
}

let group;
for (const sc of SCENARIOS) {
  if (sc.group !== group) $('#scenarioList').append(el('h4', {}, (group = sc.group)));
  const play = el('button', { class: 'play mini', type: 'button', 'data-needs-bap': '', 'data-title': `Start "${sc.title}"`, 'aria-label': `Start ${sc.title}` }, '▶');
  play.onclick = (e) => { e.stopPropagation(); start(sc); };
  $('#scenarioList').append(el('div', { class: 'scenario-item', 'data-id': sc.id, onclick: () => renderScenario(sc) },
    play, el('span', { class: 'title' }, sc.title), sc.mode ? el('span', { class: 'muted steps-count' }, MODE_LABELS[sc.mode]) : null));
}

// ---- live tracking --------------------------------------------------------------------------
// Each poll re-matches the app's calls since activation to the scenario's steps.
function updateLive(activity) {
  if (!live || !isActive(live.sc)) return;
  const since = armed.at ?? '';
  const entries = activity.filter((a) => a.at >= since).reverse();
  const key = entries.map((a) => a.id + a.status + (a.callbacks ?? []).map((c) => c.delivery?.status ?? '').join()).join();
  if (key === live.key) return;
  live.key = key;
  const results = trackLive(live.sc, entries, { catalog: live.catalog, modeItems: armed.items ?? [] });
  const next = results.findIndex((r) => r.phase === 'waiting');
  results.forEach((r, i) => {
    const row = live.steps[i];
    row.expect.textContent = r.expect ?? row.expect.textContent;
    row.detail.replaceChildren();
    if (r.entry) {
      row.detail.append(
        callBlock({ pill: 'REQUEST', pillClass: 'cb', name: r.entry.kind === 'seller_action' ? 'seller action' : `/${r.entry.action}`, meta: new Date(r.entry.at).toLocaleTimeString(), sections: [['from your app', r.entry.request], ['mock sync response', r.entry.response]], open: false }),
        ...callbackBlocks(r.entry.callbacks, false));
    }
    if (r.phase === 'running') {
      row.status.textContent = `running - sending ${(r.entry.callbacks ?? []).map((c) => `/${c.body.context.action}`).join(' + ') || 'the answer'} to your app…`;
      row.status.className = 'pill running';
      row.li.className = 'buyer-step next';
    } else if (r.phase === 'completed') {
      const delivered = (r.entry.callbacks ?? []).every((c) => !c.delivery || (c.delivery.status >= 200 && c.delivery.status < 300));
      row.status.textContent = r.problem ? `completed - unexpected: ${r.problem}` : delivered ? 'completed · as expected' : 'completed - your app did not ACK the callback';
      row.status.className = `pill ${r.problem || !delivered ? 'bad' : 'ok'}`;
      row.li.className = 'buyer-step done';
    } else if (r.phase === 'skipped') {
      row.status.textContent = 'skipped - your app used its cached catalogue';
      row.status.className = 'pill';
      row.li.className = 'buyer-step skipped';
    } else if (i === next) {
      row.status.textContent = r.step.action === 'push' ? 'waiting - press the seller action in Activity' : `waiting for /${r.step.action} from your app…`;
      row.status.className = 'pill waiting';
      row.li.className = 'buyer-step next';
    } else {
      row.status.textContent = '';
      row.status.className = 'pill';
      row.li.className = 'buyer-step';
    }
  });
  const runningNow = results.some((r) => r.phase === 'running');
  const done = next === -1 && !runningNow;
  const head = $('#scenarioRun h3');
  if (head) head.textContent = done ? (results.some((r) => r.problem) ? 'Completed - with unexpected answers' : 'Completed - every step as expected') : runningNow ? 'Running…' : 'Live - waiting for your app';
}

// ---- activity -------------------------------------------------------------------------------
// Polls what the mock received from this bap_id and what it sent back.
let seen = '';
let pollTimer;
async function pollActivity(force = false) {
  clearTimeout(pollTimer);
  if (!bapId()) {
    $('#activity').replaceChildren(el('p', { class: 'muted' }, 'Enter your bap_id above to see the calls your app makes.'));
    $('#orders').replaceChildren();
    $('#activityCount').textContent = '';
  } else {
    try {
      const data = await fetch(`/api/mock/activity?bap_id=${encodeURIComponent(bapId())}`, { cache: 'no-store' }).then((r) => r.json());
      const key = data.activity.map((a) => a.id).join() + json(data.orders.map((o) => [o.id, o.state, o.fulfillment_state]));
      if (force || key !== seen) {
        seen = key;
        renderActivity(data.activity);
        renderOrders(data.orders);
      }
      updateLive(data.activity);
      $('#activityCount').textContent = data.activity.length ? String(data.activity.length) : '';
      $('#activityState').textContent = `live · updated ${new Date().toLocaleTimeString()}`;
    } catch {
      $('#activityState').textContent = 'could not load activity';
    }
  }
  pollTimer = setTimeout(pollActivity, live ? 1000 : 3000);
}

function renderActivity(entries) {
  if (!entries.length) {
    return $('#activity').replaceChildren(el('p', { class: 'muted' }, `No calls from ${bapId()} yet. Point your app at ${BPP.uri} and make a call - it shows up here.`));
  }
  $('#activity').replaceChildren(...entries.map((a) => {
    const ok = a.response?.message?.ack?.status === 'ACK';
    const who = a.kind === 'seller_action' ? `seller: ${a.scenario}` : `/${a.action}`;
    const meta = [new Date(a.at).toLocaleTimeString(), a.transaction_id && `txn ${String(a.transaction_id).slice(0, 8)}`, a.kind === 'request' && a.scenario].filter(Boolean).join(' · ');
    const node = callBlock({
      pill: ok ? 'ACK' : 'NACK', pillClass: ok ? 'ok' : 'bad', name: who, meta, open: false,
      sections: [[a.kind === 'seller_action' ? 'seller action' : 'request from your app', a.request], ['mock sync response', a.response]],
      extra: (a.callbacks ?? []).map((c) => deliveryPill(c.delivery) ?? el('span', { class: 'pill' }, 'callback pending')),
    });
    node.querySelector('.call-body').append(...callbackBlocks(a.callbacks, false));
    return node;
  }));
}

const PUSH_EVENTS = ['packed', 'out_for_delivery', 'delivered', 'seller_cancel'];
function renderOrders(orders) {
  if (!orders.length) return $('#orders').replaceChildren();
  $('#orders').replaceChildren(el('section', { class: 'card' },
    el('h2', {}, 'Seller actions'),
    el('p', { class: 'muted' }, 'Things the seller does on its own on orders your app confirmed. Each sends an unsolicited on_status / on_cancel to your app.'),
    el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ...['order', 'provider', 'total', 'state', 'fulfillment', ''].map((h) => el('th', {}, h)))),
      el('tbody', {}, orders.map((o) => el('tr', {},
        el('td', {}, el('code', {}, o.id)),
        el('td', {}, o.provider),
        el('td', { class: 'num' }, `₹${o.total}`),
        el('td', {}, o.state),
        el('td', {}, o.fulfillment_state),
        el('td', { class: 'actions' }, PUSH_EVENTS.map((ev) => {
          const done = ['Cancelled', 'Completed'].includes(o.state);
          return el('button', { class: ev === 'seller_cancel' ? 'ghost danger' : 'ghost', type: 'button', ...(done ? { disabled: '', title: `Order is ${o.state}` } : {}), onclick: async (e) => {
            e.currentTarget.disabled = true;
            await post('/api/mock/push', { order_id: o.id, event: ev }, { 'X-Mock-Deliver': 'wait' });
            pollActivity(true);
          } }, PUSH_LABELS[ev]);
        })),
      ))),
    )),
  ));
}

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
  const providers = await getCatalog();
  const box = $('#catalogue');
  for (const p of providers) {
    const svc = p.tags.filter((t) => t.code === 'serviceability').map((t) => t.list.find((e) => e.code === 'unit').value);
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
        el('span', { class: 'pill' }, `serviceability: ${[...new Set(svc)].join(', ')} (pan-India)`),
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

showTab(['scenarios', 'activity', 'catalogue', 'retailers'].includes(store.get('tab', '')) ? store.get('tab', '') : 'scenarios');

refreshTarget();
loadArmed();
loadCallers();
pollActivity();
renderScenario(SCENARIOS.find((x) => x.id === store.get('scenario', '')) ?? SCENARIOS[0]);
