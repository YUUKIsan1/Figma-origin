import { describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import type { Env } from '../src/env';

function counter(limit: number): RateLimit {
  const counts = new Map<string, number>();
  return {
    limit: vi.fn(async ({ key }) => {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { success: count <= limit };
    }),
  };
}
function fixture() {
  const run = vi.fn(async () => ({ meta: { changes: 1 } }));
  const first = vi.fn(async () => null);
  const prepare = vi.fn((sql: string) => {
    if (!sql) throw new Error('SQL is required');
    return { bind: vi.fn(() => ({ run, first })) };
  });
  const env = {
    ADMIN_TOKEN: crypto.randomUUID(),
    VIEWER_PASSWORD: crypto.randomUUID(),
    SESSION_SECRET: crypto.randomUUID(),
    DB: { prepare },
    API_RATE_LIMITER: counter(60),
    AUTH_RATE_LIMITER: counter(120),
    LOGIN_RATE_LIMITER: counter(5),
    WRITE_RATE_LIMITER: counter(12),
  } as unknown as Env;
  return { env, prepare, run };
}
function post(env: Env, path: string, body: unknown, token?: string) {
  return app.request(
    `https://canvas.test${path}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    },
    env,
  );
}
describe('authentication and free-tier quotas', () => {
  it('rejects weak secrets before routing or accessing D1', async () => {
    for (const name of ['ADMIN_TOKEN', 'VIEWER_PASSWORD', 'SESSION_SECRET'] as const) {
      const { env, prepare } = fixture();
      env[name] = 'weak-value';
      const response = await post(env, '/login', { password: env.VIEWER_PASSWORD });
      expect(response.status).toBe(503);
      const error = await response.text();
      expect(error).toContain(name);
      expect(error).not.toContain('weak-value');
      expect(prepare).not.toHaveBeenCalled();
    }
  });
  it('blocks repeated failed logins without any D1 access', async () => {
    const { env, prepare } = fixture();
    for (let i = 0; i < 5; i++)
      expect((await post(env, '/login', { password: 'wrong' })).status).toBe(401);
    const blocked = await post(env, '/login', { password: 'wrong' });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('60');
    expect(prepare).not.toHaveBeenCalled();
  });
  it('bounds invalid Bearer attempts by IP before a D1 lookup', async () => {
    const { env, prepare, run } = fixture();
    for (let i = 0; i < 120; i++)
      expect((await post(env, '/mcp', {}, `invalid-${i}`)).status).toBe(401);
    expect((await post(env, '/mcp', {}, 'another-invalid-token')).status).toBe(429);
    expect(prepare).toHaveBeenCalledTimes(120);
    expect(run).not.toHaveBeenCalled();
    expect(prepare.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true);
  });
  it('shares the 12-per-minute D1 mutation budget across tools and token management', async () => {
    const { env, prepare } = fixture();
    for (let i = 0; i < 12; i++) {
      const path = i % 2 ? '/admin/tokens' : '/api/tools/create_file';
      expect((await post(env, path, { name: 'Quota test' }, env.ADMIN_TOKEN)).status).toBe(
        i % 2 ? 201 : 200,
      );
    }
    expect(
      (await post(env, '/api/tools/create_file', { name: 'Blocked' }, env.ADMIN_TOKEN)).status,
    ).toBe(429);
    expect(prepare).toHaveBeenCalledTimes(12);
  });
});
