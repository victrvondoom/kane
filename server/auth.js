import crypto from 'node:crypto';
import { now } from './db.js';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const hashToken = sha;

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex'), b = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const COOKIE = 'sp_session';
const TTL = 14 * 24 * 3600 * 1000;

export function createSession(db, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.run('INSERT INTO sessions VALUES (?, ?, ?)', sha(token), userId, new Date(Date.now() + TTL).toISOString());
  const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL / 1000}${secure}`);
}
export function destroySession(db, req, res) {
  const t = readCookie(req);
  if (t) db.run('DELETE FROM sessions WHERE token_hash = ?', sha(t));
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
function readCookie(req) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? m[1] : null;
}
export function currentUser(db, req) {
  const t = readCookie(req);
  if (!t) return null;
  const s = db.get('SELECT * FROM sessions WHERE token_hash = ?', sha(t));
  if (!s || s.expires_at < now()) return null;
  return db.get('SELECT id, email, name, created_at FROM users WHERE id = ?', s.user_id);
}

// Small in-memory limiter for credential endpoints.
const hits = new Map();
export function rateLimit(key, max = 12, windowMs = 60_000) {
  const t = Date.now();
  const list = (hits.get(key) || []).filter((x) => t - x < windowMs);
  list.push(t); hits.set(key, list);
  return list.length <= max;
}
