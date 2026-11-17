import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import type { Env } from '../src/env';
import type { DesignFile } from '../src/model';
// Real Chromium replaces only Cloudflare's remote browser binding during tests.
vi.mock('@cloudflare/puppeteer', async () => {
  const local = await import('puppeteer-core');
  return {
    default: {
      launch: async () => {
        const browser = await local.default.launch({
          executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
          args: ['--no-sandbox', '--disable-dev-shm-usage'],
        });
        const newPage = browser.newPage.bind(browser);
        browser.newPage = async () => {
          const page = await newPage();
          const setContent = page.setContent.bind(page);
          // Use the same bundled font without requiring a public deployment in tests.
          const font = await readFile('public/fonts/NotoSansJP.ttf');
          page.setContent = (html, options) =>
            setContent(
              html.replace(
                'https://canvas.test/fonts/NotoSansJP.ttf',
                `data:font/ttf;base64,${font.toString('base64')}`,
              ),
              options,
            );
          return page;
        };
        return browser;
      },
    },
  };
});
const { default: app } = await import('../src/index');
let mf: Miniflare, env: Env;
let fileId: string, pageId: string, mobileId: string, desktopId: string;
const admin: string = crypto.randomUUID();
let accessToken: string, accessId: string, cookie: string;
const json = (value: unknown) => JSON.stringify(value);
async function request(
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(
    `https://canvas.test${path}`,
    {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? json(body) : undefined,
    },
    env,
  );
}
async function tool(name: string, body: unknown = {}, token = admin) {
  return request(`/api/tools/${name}`, 'POST', body, { Authorization: `Bearer ${token}` });
}
async function rpc(method: string, params?: unknown, token = admin) {
  return request(
    '/mcp',
    'POST',
    { jsonrpc: '2.0', id: crypto.randomUUID(), method, params },
    {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-03-26',
    },
  );
}
beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default {fetch() {return new Response("ok")}}',
    compatibilityDate: '2026-08-01',
    d1Databases: ['DB'],
    r2Buckets: ['IMAGES'],
  });
  const db = await mf.getD1Database('DB');
  const sql = await readFile('migrations/0001_initial.sql', 'utf8');
  // D1 exec is line-oriented; prepare each SQL statement including the trigger.
  const statements = sql.match(/CREATE TRIGGER[\s\S]*?END;|CREATE TABLE[\s\S]*?\);/g)!;
  for (const statement of statements) await db.prepare(statement).run();
  env = {
    DB: db,
    IMAGES: await mf.getR2Bucket('IMAGES'),
    BROWSER: {} as Env['BROWSER'],
    ADMIN_TOKEN: admin,
    VIEWER_PASSWORD: crypto.randomUUID(),
    SESSION_SECRET: crypto.randomUUID(),
    ASSETS: {
      fetch: async () => new Response(await readFile('public/fonts/NotoSansJP.ttf')),
    } as unknown as Fetcher,
  } as unknown as Env;
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});

describe('MVP end to end', () => {
  it('protects all design data and requires same-origin mutations', async () => {
    for (const path of ['/api/files', '/api/files/unknown', '/preview/f/f', '/images/test'])
      expect((await request(path)).status).toBe(401);
    expect((await rpc('tools/list', {}, 'invalid')).status).toBe(401);
    expect(
      (
        await request(
          '/login',
          'POST',
          { password: env.VIEWER_PASSWORD },
          { Origin: 'https://evil.test' },
        )
      ).status,
    ).toBe(403);
    expect((await request('/login', 'POST', { password: 'wrong' })).status).toBe(401);
    const login = await request('/login', 'POST', { password: env.VIEWER_PASSWORD });
    expect(login.status).toBe(200);
    expect(login.headers.get('Set-Cookie')).toContain('HttpOnly');
    expect(login.headers.get('Set-Cookie')).toContain('Secure');
    cookie = login.headers.get('Set-Cookie')!.split(';')[0];
    expect((await request('/api/files', 'GET', undefined, { Cookie: cookie })).status).toBe(200);
    expect((await tool('create_file', { name: 'Denied' }, cookie)).status).toBe(401);
  });
  it('issues revocable tokens and initializes the MCP SDK transport', async () => {
    const issued = await request(
      '/admin/tokens',
      'POST',
      { name: 'Grok' },
      { Authorization: `Bearer ${admin}` },
    );
    const token = (await issued.json()) as { token: string; id: string };
    accessToken = token.token;
    accessId = token.id;
    const init = await rpc(
      'initialize',
      {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
      accessToken,
    );
    expect(init.status).toBe(200);
    expect(
      ((await init.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name,
    ).toBe('canvas-note');
    const list = await rpc('tools/list', {}, accessToken);
    const tools = (await list.json()) as { result: { tools: { name: string }[] } };
    expect(tools.result.tools).toHaveLength(15);
  });
  it('creates mobile and PC frames using only MCP', async () => {
    async function call(name: string, args: unknown) {
      const res = await rpc('tools/call', { name, arguments: args }, accessToken);
      expect(res.status).toBe(200);
      const message = (await res.json()) as {
        result: { isError?: boolean; content: { text: string }[] };
      };
      expect(message.result.isError, json(message)).not.toBe(true);
      return JSON.parse(message.result.content[0].text);
    }
    fileId = (await call('create_file', { name: 'ReNote' })).file.id;
    pageId = (await call('create_page', { fileId, name: 'Home' })).page.id;
    mobileId = (
      await call('create_frame', {
        fileId,
        pageId,
        frame: { name: 'Mobile', width: 390, height: 844 },
      })
    ).frame.id;
    desktopId = (
      await call('create_frame', {
        fileId,
        pageId,
        frame: { name: 'PC', width: 1440, height: 900 },
      })
    ).frame.id;
    await call('set_tokens', {
      fileId,
      tokens: {
        colors: { brand: '#235d46' },
        radii: { card: 16 },
        textStyles: { title: { size: 28, weight: 'bold', color: '#ffffff' } },
      },
    });
    for (const frameId of [mobileId, desktopId])
      await call('create_nodes', {
        fileId,
        frameId,
        nodes: [
          {
            id: frameId === mobileId ? 'mobile-card' : 'pc-card',
            type: 'rect',
            x: 20,
            y: 20,
            w: 350,
            h: 180,
            fill: { token: 'brand' },
            radius: { token: 'card' },
            shadow: { x: 0, y: 4, blur: 12, color: '#00000033' },
          },
          {
            id: frameId === mobileId ? 'mobile-text' : 'pc-text',
            type: 'text',
            x: 40,
            y: 50,
            w: 300,
            h: 100,
            text: 'ReNote\n今日のアイデア',
            textStyle: { token: 'title' },
            fill: '#00000000',
          },
        ],
      });
    const frame = await call('get_frame_tree', { fileId, frameId: mobileId });
    expect(frame.frame.nodes).toHaveLength(2);
  });
  it('returns real PNG via MCP and applies node and token edits to preview and PNG', async () => {
    async function png(frameId: string) {
      const response = await rpc(
        'tools/call',
        { name: 'render_frame', arguments: { fileId, frameId } },
        accessToken,
      );
      const message = (await response.json()) as {
        result: { isError?: boolean; content: { type: string; data: string }[] };
      };
      expect(message.result.isError, json(message)).not.toBe(true);
      expect(message.result.content[0].type).toBe('image');
      return Buffer.from(message.result.content[0].data, 'base64');
    }
    const first = await png(mobileId);
    expect([...first.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(first.readUInt32BE(16)).toBe(390);
    expect(first.readUInt32BE(20)).toBe(844);
    const pc = await png(desktopId);
    expect(pc.readUInt32BE(16)).toBe(1440);
    expect(pc.readUInt32BE(20)).toBe(900);
    const cached = await png(mobileId);
    expect(cached).toEqual(first);
    const patch = await tool('update_nodes', {
      fileId,
      frameId: mobileId,
      nodes: [{ id: 'mobile-text', text: '更新済み' }],
    });
    expect(patch.status).toBe(200);
    const changed = await png(mobileId);
    expect(changed).not.toEqual(first);
    const get = (await (await tool('get_file', { fileId })).json()) as { file: DesignFile };
    expect(get.file.pages[0].frames[0].nodes[1].x).toBe(40);
    get.file.tokens.colors.brand = '#bb2244';
    expect((await tool('set_tokens', { fileId, tokens: get.file.tokens })).status).toBe(200);
    const preview = await request(`/preview/${fileId}/${mobileId}`, 'GET', undefined, {
      Cookie: cookie,
    });
    const html = await preview.text();
    expect(html).toContain('更新済み');
    expect(html).toContain('#bb2244');
    expect(preview.headers.get('Cache-Control')).toBe('no-store');
    expect(await png(mobileId)).not.toEqual(changed);
  }, 60000);
  it('rejects invalid batches atomically, detects stale writes and restores revisions', async () => {
    const before = (await (await tool('get_file', { fileId })).json()) as {
      file: DesignFile;
      version: number;
    };
    const bad = await tool('update_nodes', {
      fileId,
      frameId: mobileId,
      nodes: [
        { id: 'mobile-text', x: 99 },
        { id: 'missing', x: 0 },
      ],
    });
    expect(bad.status).toBe(404);
    const after = await (await tool('get_file', { fileId })).json();
    expect(after).toEqual(before);
    expect((await tool('set_tokens', { fileId, tokens: {} })).status).toBe(400);
    expect((await tool('create_page', { fileId, name: 'stale', expectedVersion: 1 })).status).toBe(
      409,
    );
    const restored = await tool('restore_revision', {
      fileId,
      revision: before.version - 1,
      expectedVersion: before.version,
    });
    expect(restored.status).toBe(200);
    const data = (await restored.json()) as { file: DesignFile; version: number };
    expect(data.version).toBe(before.version + 1);
    expect(data.file.tokens.colors.brand).toBe('#235d46');
    for (let i = 0; i < 23; i++)
      await new (await import('../src/store')).Store(env).mutate(fileId, (f) => {
        f.name = `Revision ${i}`;
      });
    expect((await new (await import('../src/store')).Store(env).revisions(fileId)).length).toBe(20);
  });
  it('stores uploaded images and deletes group descendants', async () => {
    const pixel =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';
    const upload = await tool('upload_image', { data: pixel, mimeType: 'image/png' });
    expect(upload.status).toBe(200);
    const { imageId } = (await upload.json()) as { imageId: string };
    const res = await tool('create_nodes', {
      fileId,
      frameId: mobileId,
      nodes: [
        { id: 'group', type: 'group' },
        { id: 'child', type: 'image', parentId: 'group', imageId },
      ],
    });
    expect(res.status).toBe(200);
    expect((await request(`/images/${imageId}`, 'GET', undefined, { Cookie: cookie })).status).toBe(
      200,
    );
    expect(
      (await tool('delete_nodes', { fileId, frameId: mobileId, nodeIds: ['group'] })).status,
    ).toBe(200);
    const data = (await (await tool('get_file', { fileId })).json()) as { file: DesignFile };
    expect(data.file.pages[0].frames[0].nodes).toHaveLength(2);
    expect((await tool('upload_image', { data: pixel, mimeType: 'image/jpeg' })).status).toBe(400);
  });
  it('enforces limits and revocation', async () => {
    const { rateLimit } = await import('../src/auth');
    for (let i = 0; i < 60; i++) await rateLimit(env, 'limit-test');
    await expect(rateLimit(env, 'limit-test')).rejects.toThrow('Rate limit exceeded');
    expect(
      (
        await request(`/admin/tokens/${accessId}`, 'DELETE', undefined, {
          Authorization: `Bearer ${admin}`,
        })
      ).status,
    ).toBe(200);
    expect((await rpc('tools/list', {}, accessToken)).status).toBe(401);
  });
});
