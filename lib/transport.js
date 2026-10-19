import { signingConfig, authorizationHeader } from './signing.js';
import { modeFromHeaders } from './modes.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function config(req, env = process.env) {
  const proto = req.headers['x-forwarded-proto'] ?? 'http';
  const baseUrl = (env.PUBLIC_BASE_URL ?? `${proto}://${req.headers.host}`).replace(/\/$/, '');
  return {
    baseUrl,
    bppId: env.BPP_ID ?? new URL(baseUrl).host,
    bppUri: env.BPP_URI ?? `${baseUrl}/ondc`,
    finderFeeType: env.FINDER_FEE_TYPE ?? 'percent',
    finderFeeAmount: env.FINDER_FEE_AMOUNT ?? '3.54',
    creationDelayMs: Number(env.CREATION_DELAY_MS ?? 5000),
    pushDelayMs: Number(env.PUSH_DELAY_MS ?? 3000),
    now: () => new Date().toISOString(),
    signing: signingConfig(env),
    // A seller mode sent on the request (playground) wins over the one armed for the bap_id.
    mode: modeFromHeaders(req.headers),
  };
}

const callbackUrl = (bapUri, action) => `${bapUri.replace(/\/$/, '')}/${action}`;

// POSTs each callback to the buyer NP, in order, honouring its delay. Failures are logged, not
// thrown: the ACK has already gone back to the buyer NP.
export async function deliver(bapUri, callbacks, cfg, fetchImpl = fetch) {
  const results = [];
  for (const c of callbacks) {
    if (c.delayMs) await sleep(c.delayMs);
    const body = JSON.stringify(c.body);
    const headers = { 'Content-Type': 'application/json', ...c.headers };
    if (cfg.signing) headers.Authorization = authorizationHeader(body, cfg.signing);
    const url = callbackUrl(bapUri, c.action);
    try {
      const res = await fetchImpl(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) });
      const text = await res.text();
      console.log(`[callback] ${c.action} -> ${url} ${res.status} ${text.slice(0, 200)}`);
      results.push({ url, status: res.status, body: text });
    } catch (err) {
      console.error(`[callback] ${c.action} -> ${url} failed: ${err.message}`);
      results.push({ url, error: err.message });
    }
  }
  return results;
}

// Shape returned in sync mode, so a developer without a public bap_uri still sees every callback.
export const syncView = (bapUri, callbacks) =>
  callbacks.map((c) => ({ url: callbackUrl(bapUri, c.action), delay_ms: c.delayMs, headers: c.headers, body: c.body }));
