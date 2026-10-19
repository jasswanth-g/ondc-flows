import { get, put } from './store.js';
import { appKey } from './modes.js';

// Providers the seller has deactivated, per buyer app: { [providerId]: { label, at } }, kept under
// the app's bap_id and bap_uri. A provider is inactive when its latest label is 'disable'. An armed
// flow run (mode.at) only sees changes made since it started, so ▶ on any flow starts with every
// provider active.
const key = (app) => `providers:${appKey(app)}`;

export async function setProviderState({ bap_id: bapId, bap_uri: bapUri }, providerId, label) {
  const at = new Date().toISOString();
  await Promise.all([...new Set([bapId, bapUri].map(appKey).filter(Boolean))].map(async (app) => {
    const states = (await get(key(app))) ?? {};
    await put(key(app), { ...states, [providerId]: { label, at } }, 24 * 3600);
  }));
}

export async function inactiveProviders(ctx, mode = {}) {
  const records = await Promise.all([ctx.bap_id, ctx.bap_uri].map(appKey).filter(Boolean).map((app) => get(key(app))));
  const latest = {};
  for (const states of records) {
    for (const [id, s] of Object.entries(states ?? {})) if (!latest[id] || s.at > latest[id].at) latest[id] = s;
  }
  return Object.keys(latest).filter((id) => latest[id].label === 'disable' && (!mode.at || latest[id].at >= mode.at));
}
