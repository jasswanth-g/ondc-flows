// Confirmed orders, so post-order calls (/status, /cancel, seller pushes) can answer with the order.
// Uses Upstash Redis REST (Vercel KV / Upstash integration env vars) when configured, because
// serverless instances don't share memory; falls back to in-process memory otherwise.

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

const key = (orderId) => `ondc-mock:order:${orderId}`;

export async function saveOrder(record) {
  const cfg = kv();
  if (cfg) return command(cfg, ['SET', key(record.order.id), JSON.stringify(record), 'EX', TTL_SECONDS]);
  memory.set(record.order.id, record);
  if (memory.size > 1000) memory.delete(memory.keys().next().value);
}

export async function getOrder(orderId) {
  const cfg = kv();
  if (cfg) {
    const raw = await command(cfg, ['GET', key(orderId)]);
    return raw ? JSON.parse(raw) : null;
  }
  return memory.get(orderId) ?? null;
}

export const storeKind = () => (kv() ? 'kv' : 'memory');
