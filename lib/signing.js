import crypto from 'node:crypto';

// ONDC Authorization header (Beckn signing): BLAKE2b-512 digest of the raw body, signed with Ed25519.
// SIGNING_PRIVATE_KEY is the base64 key from the ONDC key-pair utility: a 32-byte seed or a
// 64-byte libsodium secret key (seed || public key). Without it, callbacks go out unsigned.

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function privateKey(b64) {
  const raw = Buffer.from(b64, 'base64');
  if (raw.length !== 32 && raw.length !== 64) throw new Error('SIGNING_PRIVATE_KEY must be a base64 32 or 64 byte Ed25519 key');
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, raw.subarray(0, 32)]), format: 'der', type: 'pkcs8' });
}

export function signingConfig(env = process.env) {
  if (!env.SIGNING_PRIVATE_KEY || !env.BPP_ID || !env.BPP_UNIQUE_KEY_ID) return null;
  return { key: privateKey(env.SIGNING_PRIVATE_KEY), subscriberId: env.BPP_ID, uniqueKeyId: env.BPP_UNIQUE_KEY_ID };
}

export function authorizationHeader(body, cfg, now = Math.floor(Date.now() / 1000)) {
  const created = now;
  const expires = now + 300;
  const digest = crypto.createHash('blake2b512').update(body).digest('base64');
  const signingString = `(created): ${created}\n(expires): ${expires}\ndigest: BLAKE-512=${digest}`;
  const signature = crypto.sign(null, Buffer.from(signingString), cfg.key).toString('base64');
  return `Signature keyId="${cfg.subscriberId}|${cfg.uniqueKeyId}|ed25519",algorithm="ed25519",created="${created}",expires="${expires}",headers="(created) (expires) digest",signature="${signature}"`;
}
