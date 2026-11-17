import type { Env } from './env';
import { AppError } from './model';
export async function hash(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
export async function equal(a: string, b: string) {
  const [x, y] = await Promise.all([hash(a), hash(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}
export async function rateLimit(env: Env, key: string, limit = 60) {
  const minute = Math.floor(Date.now() / 60000);
  const row = await env.DB.prepare(
    'INSERT INTO rate_limits(key, window, count) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET count = CASE WHEN window = excluded.window THEN count + 1 ELSE 1 END, window = excluded.window RETURNING count',
  )
    .bind(key, minute)
    .first<{ count: number }>();
  if (row && row.count > limit) throw new AppError(429, 'Rate limit exceeded; retry next minute');
}
export async function bearer(request: Request, env: Env, adminOnly = false) {
  const token = request.headers.get('Authorization')?.match(/^Bearer (\S+)$/)?.[1];
  if (!token) throw new AppError(401, 'Bearer token required');
  if (env.ADMIN_TOKEN && (await equal(token, env.ADMIN_TOKEN))) {
    await rateLimit(env, 'admin');
    return;
  }
  if (adminOnly) throw new AppError(403, 'Admin token required');
  const row = await env.DB.prepare('SELECT id FROM access_tokens WHERE hash = ? AND revoked = 0')
    .bind(await hash(token))
    .first<{ id: string }>();
  if (!row) throw new AppError(401, 'Invalid or revoked token');
  await rateLimit(env, `token:${row.id}`);
}
async function sign(env: Env, value: string) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32)
    throw new AppError(503, 'Session secret must contain at least 32 characters');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
export async function createSession(env: Env) {
  const value = `${Math.floor(Date.now() / 1000) + 86400}.${crypto.randomUUID()}`;
  return `${value}.${await sign(env, value)}`;
}
export async function hasSession(request: Request, env: Env) {
  const cookie = request.headers
    .get('Cookie')
    ?.split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith('session='))
    ?.slice(8);
  if (!cookie || cookie.length > 200) return false;
  const [expires, nonce, signature] = cookie.split('.');
  if (!/^\d+$/.test(expires) || !nonce || !signature || Number(expires) <= Date.now() / 1000)
    return false;
  return equal(signature, await sign(env, `${expires}.${nonce}`));
}
