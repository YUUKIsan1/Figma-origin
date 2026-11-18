import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { Miniflare } from 'miniflare';
import app from '../../src/index';
import type { Env } from '../../src/env';

// Serve the Worker and its public assets over real HTTP for external-client tests.
export async function startTestRuntime({ writeLimit = 12 } = {}) {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: '2026-08-01',
    d1Databases: ['DB'],
    r2Buckets: ['IMAGES'],
    ratelimits: {
      API_RATE_LIMITER: { namespace_id: '1001', simple: { limit: 60, period: 60 } },
      AUTH_RATE_LIMITER: { namespace_id: '1002', simple: { limit: 120, period: 60 } },
      LOGIN_RATE_LIMITER: { namespace_id: '1003', simple: { limit: 5, period: 60 } },
      WRITE_RATE_LIMITER: { namespace_id: '1004', simple: { limit: writeLimit, period: 60 } },
    },
  });
  const db = await mf.getD1Database('DB');
  const sql = await readFile('migrations/0001_initial.sql', 'utf8');
  for (const statement of sql.match(/CREATE TRIGGER[\s\S]*?END;|CREATE TABLE[\s\S]*?\);/g)!)
    await db.prepare(statement).run();
  await db.prepare(await readFile('migrations/0002_remove_d1_rate_limits.sql', 'utf8')).run();
  const env = {
    ...(await mf.getBindings()),
    DB: db,
    IMAGES: await mf.getR2Bucket('IMAGES'),
    BROWSER: {},
    ADMIN_TOKEN: crypto.randomUUID(),
    VIEWER_PASSWORD: crypto.randomUUID(),
    SESSION_SECRET: crypto.randomUUID(),
    ASSETS: {
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        const filename = path === '/' ? '/index.html' : path;
        const mime = filename.endsWith('.css')
          ? 'text/css'
          : filename.endsWith('.js')
            ? 'application/javascript'
            : filename.endsWith('.ttf')
              ? 'font/ttf'
              : 'text/html';
        try {
          return new Response(await readFile(`public${filename}`), {
            headers: { 'Content-Type': mime },
          });
        } catch {
          return new Response('Not found', { status: 404 });
        }
      },
    },
  } as unknown as Env;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const result = await app.fetch(
        new Request(`http://${request.headers.host}${request.url}`, {
          method: request.method,
          headers: request.headers as Record<string, string>,
          body: ['GET', 'HEAD'].includes(request.method!) ? undefined : Buffer.concat(chunks),
        }),
        env,
      );
      response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      response.writeHead(500);
      response.end('Test runtime error');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    env,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await mf.dispose();
    },
  };
}
