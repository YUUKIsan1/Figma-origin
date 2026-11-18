import { expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { startTestRuntime } from './helpers/runtime';
import type { FrameSpecification } from '../src/export';
import { Store } from '../src/store';
vi.mock('@cloudflare/puppeteer', async () => {
  const local = await import('puppeteer-core');
  return {
    default: {
      launch: vi.fn(() =>
        local.default.launch({
          executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
          args: ['--no-sandbox', '--disable-dev-shm-usage'],
        }),
      ),
    },
  };
});
it('exports Markdown, JSON and optional same-version PNG via MCP without a D1 mutation', async () => {
  const runtime = await startTestRuntime();
  const client = new Client({ name: 'export-acceptance', version: '1' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL('/mcp', runtime.origin), {
        requestInit: { headers: { Authorization: `Bearer ${runtime.env.ADMIN_TOKEN}` } },
      }),
    );
    const invoke = async (name: string, args: Record<string, unknown> = {}) =>
      CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
    const json = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await invoke(name, args);
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const block = result.content[0];
      if (block.type !== 'text') throw new Error('Missing JSON');
      return JSON.parse(block.text);
    };
    const { file } = await json('create_file', { name: 'Spec handoff' });
    const fileId: string = file.id;
    const { page } = await json('create_page', { fileId, name: 'Home' });
    await json('set_tokens', {
      fileId,
      tokens: {
        colors: { brand: '#235d46', ink: '#ffffff', unused: '#ff0000' },
        spacing: { gap: 24 },
        textStyles: { heading: { color: { token: 'ink' }, size: 24 } },
      },
    });
    await json('set_component', {
      fileId,
      component: {
        id: 'card',
        name: 'Shared card',
        nodes: [
          {
            id: 'caption',
            type: 'text',
            text: '実装へ引き渡し',
            textStyle: { token: 'heading' },
            fill: { token: 'brand' },
            w: 280,
            h: 100,
          },
        ],
      },
    });
    const { frame } = await json('create_frame', {
      fileId,
      pageId: page.id,
      frame: { name: 'Mobile', width: 390, height: 844 },
    });
    const frameId: string = frame.id;
    await json('create_instances', {
      fileId,
      frameId,
      instances: [{ componentId: 'card', x: { token: 'gap' }, y: 32 }],
    });
    const store = new Store(runtime.env);
    const before = await store.get(fileId);
    const history = await store.revisions(fileId);
    // A denied write binding proves specification exports do not consume the D1 mutation budget.
    runtime.env.WRITE_RATE_LIMITER = { limit: vi.fn(async () => ({ success: false })) };
    const { default: browser } = await import('@cloudflare/puppeteer');
    const plain = await invoke('export_frame_spec', { fileId, frameId });
    expect(plain.isError).not.toBe(true);
    expect(plain.content.map((b) => b.type)).toEqual(['text', 'text']);
    const [markdown, machine] = plain.content;
    if (markdown.type !== 'text' || machine.type !== 'text')
      throw new Error('Missing specification');
    expect(markdown.text).toContain('# フレーム仕様: Mobile');
    expect(markdown.text).toContain('実装へ引き渡し');
    const spec = JSON.parse(machine.text) as FrameSpecification;
    expect(spec.file.version).toBe(before.version);
    expect(spec.frame.width).toBe(390);
    expect(spec.components).toEqual([{ id: 'card', name: 'Shared card' }]);
    expect(spec.tokens.colors).toEqual({ brand: '#235d46', ink: '#ffffff' });
    expect(spec.nodes[0].x).toEqual({ token: 'gap' });
    expect(spec.nodes[0].resolved.x).toBe(24);
    expect(browser.launch).not.toHaveBeenCalled();
    const withPng = await invoke('export_frame_spec', { fileId, frameId, includePng: true });
    expect(withPng.isError, JSON.stringify(withPng)).not.toBe(true);
    expect(withPng.content.map((b) => b.type)).toEqual(['text', 'text', 'image']);
    expect(withPng.content[1]).toEqual(machine);
    expect(
      await runtime.env.IMAGES.head(`renders/${fileId}/${frameId}/${before.version}.png`),
    ).not.toBeNull();
    const image = withPng.content[2];
    if (image.type !== 'image') throw new Error('Missing PNG');
    const data = Buffer.from(image.data, 'base64');
    expect(image.mimeType).toBe('image/png');
    expect(data.readUInt32BE(16)).toBe(390);
    expect(data.readUInt32BE(20)).toBe(844);
    expect(browser.launch).toHaveBeenCalledTimes(1);
    const render = await invoke('render_frame', { fileId, frameId });
    expect(render.content[0]).toEqual(image);
    expect(browser.launch).toHaveBeenCalledTimes(1);
    expect(await store.get(fileId)).toEqual(before);
    expect(await store.revisions(fileId)).toEqual(history);
    expect(runtime.env.WRITE_RATE_LIMITER.limit).not.toHaveBeenCalled();
    expect((await invoke('export_frame_spec', { fileId, frameId: 'missing' })).isError).toBe(true);
    const rest = await fetch(`${runtime.origin}/api/tools/export_frame_spec`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${runtime.env.ADMIN_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fileId, frameId }),
    });
    expect(rest.status).toBe(200);
    const result = (await rest.json()) as { markdown: string; spec: FrameSpecification };
    expect(result.markdown).toBe(markdown.text);
    expect(result.spec).toEqual(spec);
  } finally {
    await client.close();
    await runtime.close();
  }
}, 60000);
