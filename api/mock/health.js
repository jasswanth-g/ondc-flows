import { storeHealth } from '../../lib/store.js';

// GET /api/mock/health -> { store: 'postgres' | 'memory', env, ok, error?, region }
// Says whether the deployment has a shared store. On Vercel, 'memory' means each API route keeps its
// own state, so calls, flows and activity are not seen across routes. Never returns secrets.
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ ...(await storeHealth()), region: process.env.VERCEL_REGION ?? null, vercel: Boolean(process.env.VERCEL) }));
}
