import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { Miniflare } from 'miniflare';
import puppeteer from 'puppeteer-core';
import app from '../src/index';
import { execute } from '../src/service';
import type { Env } from '../src/env';

it('logs in on a phone viewport, opens a frame, switches to PC and zooms', async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: '2026-08-01',
    d1Databases: ['DB'],
    r2Buckets: ['IMAGES'],
  });
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  let server: ReturnType<typeof createServer> | undefined;
  try {
    const db = await mf.getD1Database('DB');
    const sql = await readFile('migrations/0001_initial.sql', 'utf8');
    for (const stmt of sql.match(/CREATE TRIGGER[\s\S]*?END;|CREATE TABLE[\s\S]*?\);/g)!)
      await db.prepare(stmt).run();
    const env = {
      DB: db,
      IMAGES: await mf.getR2Bucket('IMAGES'),
      ADMIN_TOKEN: crypto.randomUUID(),
      SESSION_SECRET: crypto.randomUUID(),
      VIEWER_PASSWORD: crypto.randomUUID(),
      ASSETS: {
        fetch: async (req: Request) => {
          const path = new URL(req.url).pathname;
          const filename = path === '/' ? '/index.html' : path;
          const type = filename.endsWith('.css')
            ? 'text/css'
            : filename.endsWith('.js')
              ? 'application/javascript'
              : filename.endsWith('.ttf')
                ? 'font/ttf'
                : 'text/html';
          try {
            return new Response(await readFile(`public${filename}`), {
              headers: { 'Content-Type': type },
            });
          } catch {
            return new Response('Not found', { status: 404 });
          }
        },
      },
    } as unknown as Env;
    const call = (name: Parameters<typeof execute>[0], args: unknown) =>
      execute(name, args, env, 'https://canvas.test');
    const { file } = (await call('create_file', { name: 'ReNote' })) as { file: { id: string } };
    const { page } = (await call('create_page', { fileId: file.id, name: 'Home' })) as {
      page: { id: string };
    };
    for (const [name, width, height] of [
      ['Mobile', 390, 844],
      ['PC', 1440, 900],
    ]) {
      const { frame } = (await call('create_frame', {
        fileId: file.id,
        pageId: page.id,
        frame: { name, width, height },
      })) as { frame: { id: string } };
      await call('create_nodes', {
        fileId: file.id,
        frameId: frame.id,
        nodes: [{ type: 'text', text: '今日のアイデア', w: 300, h: 100 }],
      });
    }
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const origin = `http://${req.headers.host}`;
      const request = new Request(origin + req.url, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: ['GET', 'HEAD'].includes(req.method!) ? undefined : Buffer.concat(chunks),
      });
      const response = await app.fetch(request, env);
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      res.end(Buffer.from(await response.arrayBuffer()));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const tab = await browser.newPage();
    tab.setDefaultTimeout(10000);
    await tab.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    const errors: string[] = [];
    tab.on('pageerror', (e) => errors.push(String(e)));
    await tab.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    await tab.waitForSelector('#login:not([hidden])');
    await tab.type('#password', env.VIEWER_PASSWORD);
    await tab.click('#login-form button');
    await tab.waitForSelector('.card');
    await tab.click('.card');
    await tab.waitForFunction(() => document.querySelector('.card strong')?.textContent === 'Home');
    await tab.click('.card');
    await tab.waitForFunction(
      () => document.querySelector('.card strong')?.textContent === 'Mobile',
    );
    await tab.click('.card');
    await tab.waitForSelector('#frame-view:not([hidden])');
    await tab.waitForFunction(() =>
      document
        .querySelector<HTMLIFrameElement>('#preview')
        ?.contentDocument?.body.textContent?.includes('今日のアイデア'),
    );
    expect(await tab.$eval('#preview', (el) => (el as HTMLIFrameElement).width)).toBe('390');
    const options = await tab.$$eval('#frames option', (options) =>
      options.map((o) => (o as HTMLOptionElement).value),
    );
    await tab.select('#frames', options[1]);
    await tab.waitForFunction(
      () => document.querySelector<HTMLIFrameElement>('#preview')?.width === '1440',
    );
    await tab.$eval('#zoom', (el) => {
      (el as HTMLInputElement).value = '50';
      el.dispatchEvent(new Event('input'));
    });
    expect(await tab.$eval('#zoom-value', (el) => el.textContent)).toBe('50%');
    await tab.waitForFunction(() =>
      document
        .querySelector<HTMLIFrameElement>('#preview')
        ?.contentDocument?.body.textContent?.includes('今日のアイデア'),
    );
    await tab.frames()[1].evaluate(async () => {
      await document.fonts.ready;
    });
    await tab.screenshot({ path: '/tmp/canvas-note-viewer.png', fullPage: true });
    expect(errors).toEqual([]);
    await tab.click('#logout');
    await tab.waitForSelector('#login:not([hidden])');
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await mf.dispose();
  }
}, 30000);
