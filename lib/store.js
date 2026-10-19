// Small key-value store for the mock's state: confirmed orders, the seller mode armed per buyer NP,
// and what a mode did inside a transaction. Uses Upstash Redis REST (Vercel KV / Upstash integration
// env vars) when configured, because serverless instances don't share memory; in-process memory otherwise.

const TTL_SECONDS = 7 * 24 * 3600;
const memory = new Map();

function kv(env = process.env) {
  const url = env.KV_REST_API_URL ?? env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN ?? env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

async function command(cfg, args) {
  const res = await fetch(cfg.url, { method: 'POST', headers: { Authorization: `Bearer ${cfg.token}` }, body: JSON.stringify(args) });
  if (!res.ok) throw new Error(`KV ${args[0]} failed: ${res.status}`);
  return (await res.json()).result;
}

const prefixed = (key) => `ondc-mock:${key}`;

export async function put(key, value, ttl = TTL_SECONDS) {
  const cfg = kv();
  if (cfg) return command(cfg, ['SET', prefixed(key), JSON.stringify(value), 'EX', ttl]);
  memory.set(key, value);
  if (memory.size > 5000) memory.delete(memory.keys().next().value);
}

export async function get(key) {
  const cfg = kv();
  if (cfg) {
    const raw = await command(cfg, ['GET', prefixed(key)]);
    return raw ? JSON.parse(raw) : null;
  }
  return memory.get(key) ?? null;
}

export const saveOrder = (record) => put(`order:${record.order.id}`, record);
export const getOrder = (orderId) => get(`order:${orderId}`);

export const storeKind = () => (kv() ? 'kv' : 'memory');
