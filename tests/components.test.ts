import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestRuntime } from './helpers/runtime';
import type { DesignFile } from '../src/model';
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

it('defines and updates a component through MCP; mobile/PC PNGs, viewer and history follow it', async () => {
  // The scenario intentionally exercises more mutations than the production minute budget.
  const runtime = await startTestRuntime({ writeLimit: 1000 });
  const client = new Client({ name: 'component-acceptance', version: '1' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL('/mcp', runtime.origin), {
        requestInit: { headers: { Authorization: `Bearer ${runtime.env.ADMIN_TOKEN}` } },
      }),
    );
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const text = result.content.find((block) => block.type === 'text');
      if (!text || text.type !== 'text') throw new Error('Missing JSON content');
      return JSON.parse(text.text);
    };
    const png = async (frameId: string) => {
      const result = CallToolResultSchema.parse(
        await client.callTool({
          name: 'render_frame',
          arguments: { fileId, frameId },
        }),
      );
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const block = result.content.find((block) => block.type === 'image');
      if (!block || block.type !== 'image') throw new Error('Missing PNG content');
      const data = Buffer.from(block.data, 'base64');
      expect(block.mimeType).toBe('image/png');
      expect([...data.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      return {
        hash: createHash('sha256').update(data).digest('hex'),
        width: data.readUInt32BE(16),
        height: data.readUInt32BE(20),
      };
    };
    const { file } = await call('create_file', { name: 'Component acceptance' });
    const fileId: string = file.id;
    const { page } = await call('create_page', { fileId, name: 'Home' });
    const tokens = {
      colors: { brand: '#235d46', ink: '#ffffff' },
      spacing: { inset: 24 },
      radii: { card: 16 },
      textStyles: { title: { size: 24, color: { token: 'ink' } } },
    };
    await call('set_tokens', { fileId, tokens });
    const nodes = [
      {
        id: 'panel',
        type: 'group',
        w: 300,
        h: 180,
        fill: { token: 'brand' },
        radius: { token: 'card' },
      },
      {
        id: 'title',
        type: 'text',
        parentId: 'panel',
        x: 16,
        y: 20,
        w: 268,
        h: 100,
        fill: '#00000000',
        text: 'Original master',
        textStyle: { token: 'title' },
      },
    ];
    await call('set_component', { fileId, component: { id: 'card', name: 'Card', nodes } });
    expect((await call('list_components', { fileId })).components).toHaveLength(1);
    const frames: string[] = [];
    for (const [label, width, height] of [
      ['mobile', 390, 844],
      ['desktop', 1440, 900],
    ]) {
      const { frame } = await call('create_frame', {
        fileId,
        pageId: page.id,
        frame: { name: label, width, height },
      });
      frames.push(frame.id);
      await call('create_instances', {
        fileId,
        frameId: frame.id,
        instances: [
          { id: `${label}-card`, componentId: 'card', x: { token: 'inset' }, y: 30, opacity: 0.8 },
        ],
      });
      const tree = await call('get_frame_tree', { fileId, frameId: frame.id });
      expect(tree.frame.nodes[0].type).toBe('instance');
      expect(tree.frame.nodes[0].componentId).toBe('card');
      expect(tree.frame.nodes[0].children[0].children[0].text).toBe('Original master');
    }
    await call('update_nodes', {
      fileId,
      frameId: frames[0],
      nodes: [{ id: 'mobile-card', x: 48 }],
    });
    const before = await Promise.all(frames.map(png));
    expect(before.map((p) => [p.width, p.height])).toEqual([
      [390, 844],
      [1440, 900],
    ]);
    const { default: browser } = await import('@cloudflare/puppeteer');
    const launchCount = vi.mocked(browser.launch).mock.calls.length;
    expect((await png(frames[0])).hash).toBe(before[0].hash);
    expect(browser.launch).toHaveBeenCalledTimes(launchCount);
    const snapshot = await call('get_file', { fileId });
    nodes[1].text = 'Updated master';
    nodes[0].w = 320;
    await call('set_component', {
      fileId,
      expectedVersion: snapshot.version,
      component: { id: 'card', name: 'Card', nodes },
    });
    const after = await Promise.all(frames.map(png));
    for (let i = 0; i < 2; i++) expect(after[i].hash).not.toBe(before[i].hash);
    const login = await fetch(`${runtime.origin}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: runtime.env.VIEWER_PASSWORD }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    for (const frameId of frames) {
      const view = await fetch(`${runtime.origin}/preview/${fileId}/${frameId}`, {
        headers: { Cookie: cookie },
      });
      expect(view.status).toBe(200);
      const html = await view.text();
      expect(html).toContain('Updated master');
      expect(html).toContain('width:320px');
      expect(html).toContain('#235d46');
    }
    const changed = (await call('get_file', { fileId })) as { file: DesignFile; version: number };
    expect(changed.file.pages[0].frames.map((f) => f.nodes.length)).toEqual([1, 1]);
    expect(changed.file.pages[0].frames[0].nodes[0].opacity).toBe(0.8);
    expect(changed.file.pages[0].frames[0].nodes[0].x).toBe(48);
    await call('restore_revision', {
      fileId,
      revision: snapshot.version,
      expectedVersion: changed.version,
    });
    const restored = await Promise.all(frames.map(png));
    expect(restored.map((p) => p.hash)).toEqual(before.map((p) => p.hash));
    const invalid = await client.callTool({
      name: 'delete_component',
      arguments: { fileId, componentId: 'card' },
    });
    expect(invalid.isError).toBe(true);
    expect((await call('list_components', { fileId })).components).toHaveLength(1);
    tokens.colors.brand = '#ad3450';
    await call('set_tokens', { fileId, tokens });
    const recolored = await Promise.all(frames.map(png));
    for (let i = 0; i < 2; i++) expect(recolored[i].hash).not.toBe(before[i].hash);
    const persisted = await call('get_file', { fileId });
    const badBatch = await client.callTool({
      name: 'create_instances',
      arguments: {
        fileId,
        frameId: frames[0],
        instances: [
          { id: 'would-be-valid', componentId: 'card' },
          { id: 'invalid-reference', componentId: 'missing' },
        ],
      },
    });
    expect(badBatch.isError).toBe(true);
    expect(await call('get_file', { fileId })).toEqual(persisted);
    const stale = await client.callTool({
      name: 'set_component',
      arguments: {
        fileId,
        expectedVersion: snapshot.version,
        component: { id: 'card', name: 'Stale', nodes },
      },
    });
    expect(stale.isError).toBe(true);
    expect(await call('get_file', { fileId })).toEqual(persisted);
    const bad = await client.callTool({
      name: 'set_component',
      arguments: {
        fileId,
        component: {
          id: 'card',
          name: 'Invalid',
          nodes: [{ type: 'rect', fill: { token: 'missing' } }],
        },
      },
    });
    expect(bad.isError).toBe(true);
    expect(await call('get_file', { fileId })).toEqual(persisted);
    for (const [index, frameId] of frames.entries())
      await call('delete_nodes', {
        fileId,
        frameId,
        nodeIds: [index === 0 ? 'mobile-card' : 'desktop-card'],
      });
    await call('delete_component', { fileId, componentId: 'card' });
    expect((await call('list_components', { fileId })).components).toEqual([]);
  } finally {
    await client.close();
    await runtime.close();
  }
}, 60000);
