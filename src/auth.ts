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
export function validateSecrets(env: Env) {
  for (const name of ['ADMIN_TOKEN', 'VIEWER_PASSWORD', 'SESSION_SECRET'] as const) {
    if (!env[name] || env[name].length < 32)
      throw new AppError(503, `${name} must contain at least 32 characters`);
  }
}
export async function rateLimit(limiter: RateLimit, key: string) {
  if (!limiter) throw new AppError(503, 'Rate limit binding is not configured');
  if (!(await limiter.limit({ key })).success)
    throw new AppError(429, 'Rate limit exceeded; retry next minute');
}
export async function requestIP(request: Request) {
  // Cloudflare supplies this header; do not trust client-supplied X-Forwarded-For.
  return hash(request.headers.get('CF-Connecting-IP') ?? 'local');
}
export function sessionCookie(request: Request, value: string, maxAge: number) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}
export async function bearer(request: Request, env: Env, adminOnly = false) {
  await rateLimit(env.AUTH_RATE_LIMITER, `ip:${await requestIP(request)}`);
  const token = request.headers.get('Authorization')?.match(/^Bearer (\S+)$/)?.[1];
  if (!token) throw new AppError(401, 'Bearer token required');
  if (env.ADMIN_TOKEN && (await equal(token, env.ADMIN_TOKEN))) {
    await rateLimit(env.API_RATE_LIMITER, 'admin');
    return;
  }
  if (adminOnly) throw new AppError(403, 'Admin token required');
  const row = await env.DB.prepare('SELECT id FROM access_tokens WHERE hash = ? AND revoked = 0')
    .bind(await hash(token))
    .first<{ id: string }>();
  if (!row) throw new AppError(401, 'Invalid or revoked token');
  await rateLimit(env.API_RATE_LIMITER, `token:${row.id}`);
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
