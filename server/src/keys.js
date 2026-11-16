'use strict';
/** Khoá gateway (≥ 128 bit) và JWT HS256 của core LAVIPCO Server — chỉ dùng node:crypto. */
const crypto = require('node:crypto');

function newGatewayKey() { return crypto.randomBytes(24).toString('base64url'); }     // 192 bit

function hashKey(key) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(key, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${h.toString('base64')}`;
}
function verifyKey(key, stored) {
  if (typeof key !== 'string' || typeof stored !== 'string') return false;
  const p = stored.split('$');
  if (p.length !== 6 || p[0] !== 'scrypt') return false;
  const h = crypto.scryptSync(key, Buffer.from(p[4], 'base64'), 32, { N: +p[1], r: +p[2], p: +p[3] });
  const want = Buffer.from(p[5], 'base64');
  return want.length === h.length && crypto.timingSafeEqual(h, want);
}

const b64u = b => Buffer.from(b).toString('base64url');
function signJwt(payload, secret) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), p = b64u(JSON.stringify(payload));
  return `${h}.${p}.${crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`;
}
/** Xác thực JWT do core cấp. Trả claims hoặc null. */
function verifyJwt(token, secret, { aud = 'lavipco', now = Date.now() } = {}) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let head; try { head = JSON.parse(Buffer.from(parts[0], 'base64url')); } catch { return null; }
  if (!head || head.alg !== 'HS256') return null;
  const sig = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  const got = Buffer.from(parts[2], 'base64url');
  if (got.length !== sig.length || !crypto.timingSafeEqual(got, sig)) return null;
  let c; try { c = JSON.parse(Buffer.from(parts[1], 'base64url')); } catch { return null; }
  if (!c || c.aud !== aud || !Number.isFinite(c.exp) || c.exp * 1000 <= now || typeof c.sub !== 'string') return null;
  return c;
}

module.exports = { newGatewayKey, hashKey, verifyKey, signJwt, verifyJwt };
