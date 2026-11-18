import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { Env } from './env';
import {
  bearer,
  createSession,
  equal,
  hasSession,
  hash,
  rateLimit,
  requestIP,
  sessionCookie,
  validateSecrets,
} from './auth';
import { AppError, findFrame } from './model';
import { Store } from './store';
import { execute, inputs, type ToolName } from './service';
import { handleMcp } from './mcp';
import { imageSources, renderDocument } from './render';
const app = new Hono<{ Bindings: Env }>();
app.use('*', async (c, next) => {
  const origin = c.req.header('Origin');
  if (origin && origin !== new URL(c.req.url).origin && !['GET', 'HEAD'].includes(c.req.method))
    return c.json({ error: 'Cross-origin request denied' }, 403);
  validateSecrets(c.env);
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header(
    'Cache-Control',
    c.req.path.startsWith('/fonts/') ? 'public, max-age=86400' : 'no-store',
  );
  // Browser Rendering starts from about:blank, so public fonts need CORS.
  if (c.req.path.startsWith('/fonts/')) c.header('Access-Control-Allow-Origin', '*');
  const preview = c.req.path.startsWith('/preview/');
  c.header(
    'Content-Security-Policy',
    `default-src 'self'; script-src 'self'; style-src 'self'${preview ? " 'unsafe-inline'" : ''}; font-src 'self' data:; img-src 'self' data:; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'`,
  );
});
app.use(
  '*',
  bodyLimit({ maxSize: 3_000_000, onError: (c) => c.json({ error: 'Request too large' }, 413) }),
);
app.post('/login', async (c) => {
  await rateLimit(c.env.LOGIN_RATE_LIMITER, `login:${await requestIP(c.req.raw)}`);
  const { password } = z.object({ password: z.string().max(1024) }).parse(await c.req.json());
  if (!c.env.VIEWER_PASSWORD || !(await equal(password, c.env.VIEWER_PASSWORD)))
    throw new AppError(401, 'パスワードが違います');
  c.header('Set-Cookie', sessionCookie(c.req.raw, await createSession(c.env), 86400));
  return c.json({ ok: true });
});
app.post('/logout', (c) => {
  c.header('Set-Cookie', sessionCookie(c.req.raw, '', 0));
  return c.json({ ok: true });
});
app.all('/mcp', async (c) => {
  await bearer(c.req.raw, c.env);
  return handleMcp(c.req.raw, c.env);
});
app.use('/admin/*', async (c, next) => {
  await bearer(c.req.raw, c.env, true);
  await next();
});
app.get('/admin/tokens', async (c) =>
  c.json(
    (
      await c.env.DB.prepare(
        'SELECT id, name, revoked, created_at FROM access_tokens ORDER BY created_at DESC',
      ).all()
    ).results,
  ),
);
app.post('/admin/tokens', async (c) => {
  const { name } = z.object({ name: z.string().trim().min(1).max(200) }).parse(await c.req.json());
  await rateLimit(c.env.WRITE_RATE_LIMITER, 'workspace');
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const id = crypto.randomUUID();
  await c.env.DB.prepare('INSERT INTO access_tokens(id, name, hash) VALUES (?, ?, ?)')
    .bind(id, name, await hash(token))
    .run();
  return c.json({ id, name, token }, 201);
});
app.delete('/admin/tokens/:id', async (c) => {
  await rateLimit(c.env.WRITE_RATE_LIMITER, 'workspace');
  const result = await c.env.DB.prepare('UPDATE access_tokens SET revoked = 1 WHERE id = ?')
    .bind(c.req.param('id'))
    .run();
  if (!result.meta.changes) throw new AppError(404, 'Token not found');
  return c.json({ ok: true });
});
app.post('/api/tools/:name', async (c) => {
  await bearer(c.req.raw, c.env);
  const name = c.req.param('name');
  if (!Object.hasOwn(inputs, name)) throw new AppError(404, 'Unknown tool');
  return c.json(
    await execute(name as ToolName, await c.req.json(), c.env, new URL(c.req.url).origin),
  );
});
app.use('/api/*', async (c, next) => {
  if (!(await hasSession(c.req.raw, c.env))) throw new AppError(401, 'Login required');
  await next();
});
app.get('/api/files', async (c) => c.json(await new Store(c.env).list()));
app.get('/api/files/:id', async (c) => c.json(await new Store(c.env).get(c.req.param('id'))));
app.get('/preview/:fileId/:frameId', async (c) => {
  if (!(await hasSession(c.req.raw, c.env))) throw new AppError(401, 'Login required');
  const { file } = await new Store(c.env).get(c.req.param('fileId'));
  const frame = findFrame(file, c.req.param('frameId'));
  return c.html(
    renderDocument(
      frame,
      file.tokens,
      await imageSources(frame, c.env, false),
      '/fonts/NotoSansJP.ttf',
    ),
  );
});
app.get('/images/:id', async (c) => {
  if (!(await hasSession(c.req.raw, c.env))) throw new AppError(401, 'Login required');
  const image = await c.env.IMAGES.get(c.req.param('id'));
  if (!image) throw new AppError(404, 'Image not found');
  return new Response(image.body, {
    headers: { 'Content-Type': image.httpMetadata?.contentType ?? 'application/octet-stream' },
  });
});
app.get('*', (c) => c.env.ASSETS.fetch(c.req.raw));
app.onError((error, c) => {
  if (error instanceof z.ZodError) return c.json({ error: error.issues }, 400);
  if (error instanceof SyntaxError) return c.json({ error: 'Invalid JSON' }, 400);
  if (error instanceof AppError) {
    if (error.status === 401) c.header('WWW-Authenticate', 'Bearer');
    if (error.status === 429) c.header('Retry-After', '60');
    return c.json({ error: error.message }, error.status as 400);
  }
  console.error('Request failed:', error.name);
  return c.json({ error: 'Internal server error' }, 500);
});
export default app;
