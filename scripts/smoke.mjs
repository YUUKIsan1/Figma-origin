import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Run explicitly after deployment. Every run creates one persistent demo file.
const token = process.env.CANVAS_MCP_TOKEN;
const password = process.env.CANVAS_VIEWER_PASSWORD;
const base = new URL(process.env.CANVAS_BASE_URL || 'http://localhost:8787');
assert(
  !base.username && !base.password && !base.search && !base.hash && base.pathname === '/',
  'CANVAS_BASE_URL must be an origin URL without credentials, path, query or fragment',
);
assert(
  base.protocol === 'https:' ||
    (base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)),
  'Use HTTPS for remote deployments',
);
assert(token, 'Set CANVAS_MCP_TOKEN to an issued Bot token');
const client = new Client({ name: 'canvas-note-smoke', version: '0.1.0' });
const report = {
  fileId: null,
  frames: [],
  checks: [],
  viewer: 'skipped (CANVAS_VIEWER_PASSWORD is unset)',
};
let output;
function pass(check) {
  report.checks.push(check);
  console.log(`OK ${check}`);
}
async function http(path, init = {}) {
  return fetch(new URL(path, base), {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
}
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert(!result.isError, `${name} failed: ${JSON.stringify(result.content)}`);
  return result.content;
}
async function json(name, args) {
  const content = await call(name, args);
  const block = content.find((block) => block.type === 'text');
  assert(block, `${name} did not return JSON text`);
  return JSON.parse(block.text);
}
async function png(frame, suffix) {
  const content = await call('render_frame', { fileId: report.fileId, frameId: frame.id });
  const block = content.find((block) => block.type === 'image');
  assert(block?.mimeType === 'image/png', 'render_frame did not return PNG image content');
  const data = Buffer.from(block.data, 'base64');
  assert(
    data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    'Invalid PNG signature',
  );
  assert.equal(data.readUInt32BE(16), frame.width, 'PNG width mismatch');
  assert.equal(data.readUInt32BE(20), frame.height, 'PNG height mismatch');
  await writeFile(join(output, `${frame.label}-${suffix}.png`), data, { mode: 0o600 });
  return createHash('sha256').update(data).digest('hex');
}
async function run() {
  output =
    process.env.CANVAS_SMOKE_OUTPUT_DIR || (await mkdtemp(join(tmpdir(), 'canvas-note-smoke-')));
  await mkdir(output, { recursive: true });
  assert.equal((await http('/api/files')).status, 401, 'Viewer data must require login');
  assert.equal(
    (
      await http('/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    401,
    'MCP must require authentication',
  );
  pass('unauthenticated data and MCP access denied');
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', base), {
      requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' },
    }),
  );
  const { tools } = await client.listTools();
  for (const name of [
    'list_files',
    'create_file',
    'get_file',
    'create_page',
    'create_frame',
    'create_nodes',
    'update_nodes',
    'delete_nodes',
    'set_tokens',
    'get_tokens',
    'get_frame_tree',
    'render_frame',
    'upload_image',
    'list_revisions',
    'restore_revision',
  ])
    assert(
      tools.some((t) => t.name === name),
      `Missing MCP tool ${name}`,
    );
  pass('MCP SDK connection and tool discovery');
  const { file } = await json('create_file', {
    name: `Connection check ${new Date().toISOString()}`,
  });
  report.fileId = file.id;
  console.log(`Created file ${file.id}`);
  const { page } = await json('create_page', { fileId: file.id, name: 'Acceptance' });
  const tokens = {
    colors: { brand: '#235d46', ink: '#ffffff' },
    radii: { card: 16 },
    spacing: { inset: 24 },
    textStyles: {
      title: {
        font: 'sans',
        size: 28,
        weight: 'bold',
        lineHeight: 1.4,
        color: { token: 'ink' },
        align: 'left',
      },
    },
  };
  await json('set_tokens', { fileId: file.id, tokens });
  const { imageId } = await json('upload_image', {
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=',
    mimeType: 'image/png',
  });
  for (const [label, width, height] of [
    ['mobile', 390, 844],
    ['desktop', 1440, 900],
  ]) {
    const { frame } = await json('create_frame', {
      fileId: file.id,
      pageId: page.id,
      frame: { name: label, width, height, background: '#f6f8f5' },
    });
    const groupId = `${label}-card`;
    await json('create_nodes', {
      fileId: file.id,
      frameId: frame.id,
      nodes: [
        {
          id: groupId,
          type: 'group',
          x: { token: 'inset' },
          y: 32,
          w: width - 48,
          h: 220,
          fill: { token: 'brand' },
          radius: { token: 'card' },
          shadow: { x: 0, y: 4, blur: 12, color: '#00000022' },
        },
        {
          id: `${label}-title`,
          type: 'text',
          parentId: groupId,
          x: 20,
          y: 28,
          w: width - 88,
          h: 100,
          fill: '#00000000',
          text: 'ReNote\n今日のアイデア',
          textStyle: { token: 'title' },
        },
        {
          id: `${label}-image`,
          type: 'image',
          parentId: groupId,
          x: 20,
          y: 160,
          w: 32,
          h: 32,
          imageId,
          opacity: 0.5,
        },
      ],
    });
    const tree = await json('get_frame_tree', { fileId: file.id, frameId: frame.id });
    assert.equal(tree.frame.nodes[0].children.length, 2, 'Group tree mismatch');
    report.frames.push({ id: frame.id, label, width, height });
  }
  pass('mobile and desktop created through MCP with tokens, groups, text and image');
  const mobile = report.frames[0];
  const initial = await png(mobile, 'initial');
  await png(report.frames[1], 'initial');
  pass('mobile and desktop PNG image content and dimensions');
  assert.equal(await png(mobile, 'cached'), initial, 'Repeated rendering changed without edits');
  pass('unchanged frame returns identical PNG');
  await json('update_nodes', {
    fileId: file.id,
    frameId: mobile.id,
    nodes: [{ id: 'mobile-title', text: '更新済み\n今日のアイデア' }],
  });
  const updated = await png(mobile, 'updated');
  assert.notEqual(updated, initial, 'Node edit was not reflected in PNG');
  pass('node edits reflected in PNG');
  tokens.colors.brand = '#ae3450';
  await json('set_tokens', { fileId: file.id, tokens });
  assert.notEqual(await png(mobile, 'tokens'), updated, 'Token edit was not reflected in PNG');
  await png(report.frames[1], 'tokens');
  pass('token edits reflected in PNG');
  const current = await json('get_file', { fileId: file.id });
  assert.equal(current.file.pages[0].frames[0].nodes[1].x, 20, 'Partial update reset geometry');
  const revisions = await json('list_revisions', { fileId: file.id });
  assert(revisions.length > 0, 'Revisions were not persisted');
  pass('file readback, partial update and revision history');
  if (password) {
    const login = await http('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base.origin },
      body: JSON.stringify({ password }),
    });
    assert.equal(login.status, 200, 'Viewer login failed');
    const session = login.headers.get('set-cookie');
    assert(
      session?.includes('HttpOnly') && session.includes('SameSite=Strict'),
      'Session cookie flags missing',
    );
    if (base.protocol === 'https:')
      assert(session.includes('Secure'), 'HTTPS cookie must be Secure');
    const headers = { Cookie: session.split(';')[0] };
    const files = await http('/api/files', { headers });
    assert.equal(files.status, 200, 'Authenticated viewer cannot list files');
    assert(
      (await files.json()).some((f) => f.id === file.id),
      'Created file not visible in viewer',
    );
    for (const frame of report.frames) {
      const response = await http(`/preview/${file.id}/${frame.id}`, { headers });
      assert.equal(response.status, 200, 'Viewer preview failed');
      const html = await response.text();
      assert(html.includes('#ae3450'), 'Viewer does not reflect token update');
      if (frame.label === 'mobile')
        assert(html.includes('更新済み'), 'Viewer does not reflect node update');
    }
    const font = await http('/fonts/NotoSansJP.ttf', { headers: { Origin: 'null' } });
    assert(
      font.ok && font.headers.get('access-control-allow-origin') === '*',
      'Public font unavailable to PNG renderer',
    );
    await font.body?.cancel();
    const asset = await http(`/images/${imageId}`, { headers });
    assert.equal(asset.status, 200, 'Uploaded image unavailable to viewer');
    await asset.body?.cancel();
    const logout = await http('/logout', { method: 'POST', headers });
    assert.equal(logout.status, 200, 'Logout failed');
    assert(logout.headers.get('set-cookie')?.includes('Max-Age=0'), 'Logout did not clear cookie');
    report.viewer = 'passed';
    pass('viewer login, both previews, changes, font, image and logout');
  } else console.log(`SKIP viewer login checks: ${report.viewer}`);
  await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
  console.log(`Saved PNGs and result.json to ${output}`);
  console.log(`Open ${new URL('/', base)} and select file ${file.id} to check on a phone.`);
}
try {
  await run();
} catch (error) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [token, password].filter(Boolean))
    message = message.replaceAll(secret, '[REDACTED]');
  console.error(`Smoke check failed: ${message}`);
  if (report.fileId) console.error(`Partial demo file retained: ${report.fileId}`);
  process.exitCode = 1;
} finally {
  await client.close();
}
