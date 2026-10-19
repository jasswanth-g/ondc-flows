import postgres from 'postgres';

// Storage for the mock's state: confirmed orders, the seller mode armed per buyer NP, what a mode
// did inside a transaction, and the activity log. Serverless instances don't share memory, so on
// Vercel this is Postgres (the Supabase integration's POSTGRES_URL); without it, in-process memory
// (fine for `npm run dev`, where there is one process).
//
// Two tables, created on first use:
//   mock_kv   (key, value, expires_at)    single values
//   mock_list (id, key, value, created_at) newest-first lists, capped per key

const TTL_SECONDS = 7 * 24 * 3600;

// The connection string: POSTGRES_URL / DATABASE_URL, or the same name with the prefix the Vercel
// Supabase integration can add (e.g. STORAGE_POSTGRES_URL). The pooled URL is preferred.
export function dbEnvName(env = process.env) {
  if (env.POSTGRES_URL) return 'POSTGRES_URL';
  if (env.DATABASE_URL) return 'DATABASE_URL';
  const keys = Object.keys(env).filter((k) => env[k]);
  return keys.find((k) => /_POSTGRES_URL$/.test(k)) ?? keys.find((k) => /(^|_)POSTGRES_URL_NON_POOLING$/.test(k)) ?? null;
}

let sql;
let ready;
function db(env = process.env) {
  const name = dbEnvName(env);
  const url = name && env[name];
  if (!url) return null;
  // The Supabase pooler runs in transaction mode: no prepared statements; keep few connections.
  sql ??= postgres(url, { prepare: false, max: 3, idle_timeout: 20, connect_timeout: 10, ssl: 'require', onnotice: () => {} });
  ready ??= sql`
    create table if not exists mock_kv (
      key text primary key,
      value jsonb not null,
      expires_at timestamptz not null
    )`.then(() => sql`
    create table if not exists mock_list (
      id bigserial primary key,
      key text not null,
      value jsonb not null,
      created_at timestamptz not null default now()
    )`).then(() => sql`create index if not exists mock_list_key_id on mock_list (key, id desc)`)
    // RLS with no policies: Supabase's REST API (anon / authenticated keys) cannot touch these
    // tables; the mock connects as their owner and is unaffected.
    .then(() => sql`alter table mock_kv enable row level security`)
    .then(() => sql`alter table mock_list enable row level security`)
    .catch((err) => {
      ready = undefined; // retry on the next call
      throw err;
    });
  return sql;
}

async function conn() {
  const s = db();
  if (s) await ready;
  return s;
}

const memory = new Map();

export async function put(key, value, ttl = TTL_SECONDS) {
  const s = await conn();
  if (!s) {
    memory.set(key, value);
    if (memory.size > 5000) memory.delete(memory.keys().next().value);
    return;
  }
  await s`
    insert into mock_kv (key, value, expires_at)
    values (${key}, ${s.json(value)}, now() + ${`${ttl} seconds`}::interval)
    on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at`;
  // Expired rows are never read; sweep them now and then.
  if (Math.random() < 0.02) await s`delete from mock_kv where expires_at < now()`;
}

export async function get(key) {
  const s = await conn();
  if (!s) return memory.get(key) ?? null;
  const [row] = await s`select value from mock_kv where key = ${key} and expires_at > now()`;
  return row?.value ?? null;
}

// Newest-first list capped at `max` entries per key.
export async function pushList(key, value, max = 50) {
  const s = await conn();
  if (!s) {
    const list = memory.get(key) ?? [];
    list.unshift(value);
    memory.set(key, list.slice(0, max));
    return;
  }
  await s`insert into mock_list (key, value) values (${key}, ${s.json(value)})`;
  await s`
    delete from mock_list where key = ${key} and id not in (
      select id from mock_list where key = ${key} order by id desc limit ${max}
    )`;
}

export async function getList(key, max = 50) {
  const s = await conn();
  if (!s) return memory.get(key) ?? [];
  const rows = await s`select value from mock_list where key = ${key} order by id desc limit ${max}`;
  return rows.map((r) => r.value);
}

export const saveOrder = (record) => put(`order:${record.order.id}`, record);
export const getOrder = (orderId) => get(`order:${orderId}`);

export const storeKind = () => (db() ? 'postgres' : 'memory');

// For the health check: which store is in use and whether it answers.
export async function storeHealth() {
  const name = dbEnvName();
  if (!name) return { store: 'memory', env: null, ok: true };
  try {
    const s = await conn();
    await s`select 1`;
    return { store: 'postgres', env: name, ok: true };
  } catch (err) {
    return { store: 'postgres', env: name, ok: false, error: err.message };
  }
}
