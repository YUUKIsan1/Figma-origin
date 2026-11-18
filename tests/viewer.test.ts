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
    ratelimits: {
      API_RATE_LIMITER: {
        namespace_id: '1001',
        simple: { limit: 60, period: 60 },
      },
      AUTH_RATE_LIMITER: {
        namespace_id: '1002',
        simple: { limit: 120, period: 60 },
      },
      LOGIN_RATE_LIMITER: {
        namespace_id: '1003',
        simple: { limit: 5, period: 60 },
      },
      WRITE_RATE_LIMITER: {
        namespace_id: '1004',
        simple: { limit: 12, period: 60 },
      },
    },
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
    await db.prepare(await readFile('migrations/0002_remove_d1_rate_limits.sql', 'utf8')).run();
    const env = {
      ...(await mf.getBindings()),
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
    const { file } = (await call('create_file', { name: 'ReNote' })) as {
      file: { id: string };
    };
    const { page } = (await call('create_page', {
      fileId: file.id,
      name: 'Home',
    })) as {
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
    await tab.setViewport({
      width: 390,
      height: 844,
      isMobile: true,
      hasTouch: true,
    });
    const errors: string[] = [];
    tab.on('pageerror', (e) => errors.push(String(e)));
    await tab.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    await tab.waitForSelector('#login:not([hidden])');
    await tab.type('#password', 'incorrect-password');
    await tab.click('#login-form button');
    await tab.waitForFunction(
      () => document.querySelector('#status')?.textContent === 'パスワードが違います',
    );
    await tab.$eval('#password', (el) => {
      (el as HTMLInputElement).value = '';
    });
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
    const layout = () =>
      tab.evaluate(() => {
        const stage = document.querySelector<HTMLElement>('#stage')!;
        const space = document.querySelector<HTMLElement>('#frame-space')!;
        const preview = document.querySelector<HTMLIFrameElement>('#preview')!;
        const style = window.getComputedStyle(stage);
        const horizontalPadding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
        const verticalPadding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
        return {
          clientWidth: stage.clientWidth,
          clientHeight: stage.clientHeight,
          scrollWidth: stage.scrollWidth,
          scrollHeight: stage.scrollHeight,
          spaceWidth: space.getBoundingClientRect().width,
          spaceHeight: space.getBoundingClientRect().height,
          renderedWidth: preview.getBoundingClientRect().width,
          renderedHeight: preview.getBoundingClientRect().height,
          frameWidth: Number(preview.width),
          frameHeight: Number(preview.height),
          horizontalPadding,
          verticalPadding,
          zoom: Number(document.querySelector<HTMLInputElement>('#zoom')!.value),
          documentWidth: document.documentElement.scrollWidth,
          viewport: window.innerWidth,
        };
      });
    async function expectFit() {
      const box = await layout();
      expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1);
      expect(box.scrollHeight).toBeLessThanOrEqual(box.clientHeight + 1);
      expect(box.renderedWidth).toBeCloseTo(box.spaceWidth, 1);
      expect(box.renderedHeight).toBeCloseTo(box.spaceHeight, 1);
      expect(box.renderedWidth).toBeCloseTo((box.frameWidth * box.zoom) / 100, 1);
      expect(box.renderedHeight).toBeCloseTo((box.frameHeight * box.zoom) / 100, 1);
      expect(box.zoom).toBe(
        Math.max(
          1,
          Math.floor(
            Math.min(
              1,
              (box.clientWidth - box.horizontalPadding) / box.frameWidth,
              (box.clientHeight - box.verticalPadding) / box.frameHeight,
            ) * 100,
          ),
        ),
      );
      expect(box.documentWidth).toBeLessThanOrEqual(box.viewport);
    }
    expect(await tab.$eval('#preview', (el) => (el as HTMLIFrameElement).width)).toBe('390');
    await tab.click('#fit');
    await expectFit();
    const options = await tab.$$eval('#frames option', (options) =>
      options.map((o) => (o as HTMLOptionElement).value),
    );
    await tab.select('#frames', options[1]);
    await tab.waitForFunction(
      () => document.querySelector<HTMLIFrameElement>('#preview')?.width === '1440',
    );
    await expectFit();
    const portraitZoom = await tab.$eval('#zoom', (el) => (el as HTMLInputElement).value);
    await tab.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true });
    await tab.waitForFunction(
      (value) => document.querySelector<HTMLInputElement>('#zoom')!.value !== value,
      {},
      portraitZoom,
    );
    await expectFit();
    await tab.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await tab.waitForFunction(
      (value) => document.querySelector<HTMLInputElement>('#zoom')!.value === value,
      {},
      portraitZoom,
    );
    await expectFit();
    for (const value of [50, 200]) {
      await tab.$eval(
        '#zoom',
        (el, value) => {
          (el as HTMLInputElement).value = String(value);
          el.dispatchEvent(new Event('input'));
        },
        value,
      );
      expect(await tab.$eval('#zoom-value', (el) => el.textContent)).toBe(`${value}%`);
      const box = await layout();
      expect(box.renderedWidth).toBeCloseTo((1440 * value) / 100, 1);
      expect(box.renderedHeight).toBeCloseTo((900 * value) / 100, 1);
      expect(box.scrollWidth).toBeGreaterThan(box.clientWidth);
      expect(box.scrollWidth).toBeLessThanOrEqual(box.renderedWidth + box.horizontalPadding + 2);
      expect(box.scrollHeight).toBeLessThanOrEqual(
        Math.max(box.clientHeight, box.renderedHeight + box.verticalPadding) + 2,
      );
      expect(box.documentWidth).toBeLessThanOrEqual(box.viewport);
    }
    await tab.click('#fit');
    await expectFit();
    await tab.waitForFunction(() =>
      document
        .querySelector<HTMLIFrameElement>('#preview')
        ?.contentDocument?.body.textContent?.includes('今日のアイデア'),
    );
    await tab.frames()[1].evaluate(async () => {
      await document.fonts.ready;
    });
    await tab.screenshot({
      path: '/tmp/canvas-note-viewer.png',
      fullPage: true,
    });
    expect(errors).toEqual([]);
    await tab.click('#logout');
    await tab.waitForSelector('#login:not([hidden])');
    expect(await tab.$eval('#status', (el) => el.textContent)).toBe('');
    expect(await tab.$eval('#preview', (el) => el.getAttribute('src'))).toBe(null);
    expect(await tab.$eval('#password', (el) => (el as HTMLInputElement).value)).toBe('');
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await mf.dispose();
  }
}, 30000);
