// Pushes a scenario's callbacks to a real buyer NP, one step per run, so each step can be checked
// in the buyer app before moving on.
//
//   node scripts/push.js start --bap-uri https://bap.example/ondc --bap-id bap.example --scenario place-order
//   node scripts/push.js next        # sends the next step's on_* callback(s) to bap_uri/on_<action>
//   node scripts/push.js status      # shows where the scenario is
//
// The whole scenario is planned in-process on `start` (so every step shares one transaction and is
// built from the previous response); `next` only refreshes timestamps and POSTs.
// Callbacks are signed when SIGNING_PRIVATE_KEY, BPP_ID and BPP_UNIQUE_KEY_ID are set.
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { handle, handlePush } from '../lib/handler.js';
import { deliver } from '../lib/transport.js';
import { signingConfig } from '../lib/signing.js';
import { SCENARIOS, runScenario } from '../public/shared/scenarios.js';

const STATE = new URL('../.push-state.json', import.meta.url);
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { 'bap-uri': { type: 'string' }, 'bap-id': { type: 'string' }, scenario: { type: 'string', default: 'place-order' }, 'bpp-uri': { type: 'string' } },
});
const cmd = positionals[0] ?? 'status';

function cfgFor(bppUri) {
  const baseUrl = bppUri.replace(/\/ondc\/?$/, '');
  return {
    baseUrl,
    bppId: process.env.BPP_ID ?? new URL(baseUrl).host,
    bppUri,
    finderFeeType: 'percent',
    finderFeeAmount: '3.54',
    creationDelayMs: Number(process.env.CREATION_DELAY_MS ?? 5000),
    pushDelayMs: 0,
    now: () => new Date().toISOString(),
    signing: signingConfig(),
  };
}

async function start() {
  const bapUri = values['bap-uri'];
  if (!bapUri) throw new Error('--bap-uri is required');
  const bap = { id: values['bap-id'] ?? new URL(bapUri).host, uri: bapUri };
  const bppUri = values['bpp-uri'] ?? process.env.BPP_URI ?? 'https://mock-seller.example/ondc';
  const cfg = cfgFor(bppUri);
  const scenario = SCENARIOS.find((x) => x.id === values.scenario);
  if (!scenario) throw new Error(`Unknown scenario ${values.scenario}; use ${SCENARIOS.map((x) => x.id).join(', ')}`);

  const steps = [];
  await runScenario(scenario, {
    bap,
    bpp: { id: cfg.bppId, uri: bppUri },
    send: async (action, body) => {
      const out = action === 'push' ? await handlePush(body, cfg) : await handle(action, body, cfg);
      return { response: out.response, callbacks: out.callbacks };
    },
    // The catalogue preload is in-process only; it is never sent to the buyer app.
    onStep: ({ step, request, reply }) => steps.push({ name: step.name, action: step.action, request, callbacks: reply.callbacks, sent: false }),
  });
  await writeFile(STATE, JSON.stringify({ scenario: scenario.id, title: scenario.title, bap, bppUri, steps }, null, 2));
  console.log(`Planned "${scenario.title}" for ${bap.id} (${bap.uri}): ${steps.length} steps`);
  printPlan(steps);
}

function printPlan(steps) {
  steps.forEach((s, i) => console.log(`  ${s.sent ? '✔' : i === steps.findIndex((x) => !x.sent) ? '→' : ' '} ${i + 1}. ${s.name}: ${s.callbacks.map((c) => c.action).join(' + ')}`));
}

async function next() {
  const state = JSON.parse(await readFile(STATE, 'utf8'));
  const i = state.steps.findIndex((s) => !s.sent);
  if (i === -1) return console.log('Scenario complete. Run start again for a new transaction.');
  const step = state.steps[i];
  const cfg = cfgFor(state.bppUri);
  for (const c of step.callbacks) c.body.context.timestamp = new Date().toISOString();

  console.log(`Step ${i + 1}/${state.steps.length}: ${step.name}`);
  if (step.request.context) console.log(`  buyer request this answers: /${step.action} message_id ${step.request.context.message_id}`);
  const results = await deliver(state.bap.uri, step.callbacks, cfg);
  results.forEach((r, k) => {
    const c = step.callbacks[k];
    const header = c.headers['X-ONDC-Search-Response'] ? ` [X-ONDC-Search-Response: ${c.headers['X-ONDC-Search-Response']}]` : '';
    console.log(`  POST ${r.url}${header}${cfg.signing ? ' (signed)' : ' (unsigned)'}`);
    console.log(`    -> ${r.error ? `failed: ${r.error}` : `${r.status} ${r.body}`}`);
  });
  // Only an HTTP 2xx carrying an ACK moves the scenario on; anything else is retried by the next `next`.
  const acked = results.every((r) => r.status >= 200 && r.status < 300 && /"status"\s*:\s*"ACK"/.test(r.body ?? ''));
  step.results = results;
  step.sent = acked;
  await writeFile(STATE, JSON.stringify(state, null, 2));
  if (!acked) console.log('  Not ACKed - step stays pending. Fix the cause and run next again.');
  printPlan(state.steps);
}

async function status() {
  const state = JSON.parse(await readFile(STATE, 'utf8'));
  console.log(`"${state.title}" -> ${state.bap.uri}`);
  printPlan(state.steps);
}

const commands = { start, next, status };
if (commands[cmd]) await commands[cmd]();
else console.log('Usage: push.js start|next|status');
