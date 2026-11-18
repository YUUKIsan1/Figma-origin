import { expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestRuntime } from './helpers/runtime';
vi.mock('@cloudflare/puppeteer', async () => {
  const local = await import('puppeteer-core');
  return {
    default: {
      launch: () =>
        local.default.launch({
          executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
          args: ['--no-sandbox', '--disable-dev-shm-usage'],
        }),
    },
  };
});

it('runs the deployed-site smoke command using the MCP SDK, real HTTP, D1/R2 and Chromium', async () => {
  const runtime = await startTestRuntime();
  const output = await mkdtemp(join(tmpdir(), 'canvas-smoke-test-'));
  try {
    const issued = await fetch(`${runtime.origin}/admin/tokens`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${runtime.env.ADMIN_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Acceptance test' }),
    });
    expect(issued.status).toBe(201);
    const { token } = (await issued.json()) as { token: string };
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ['scripts/smoke.mjs'], {
      env: {
        ...process.env,
        CANVAS_BASE_URL: runtime.origin,
        CANVAS_MCP_TOKEN: token,
        CANVAS_VIEWER_PASSWORD: runtime.env.VIEWER_PASSWORD,
        CANVAS_SMOKE_OUTPUT_DIR: output,
      },
      timeout: 55000,
    });
    expect(stderr).toBe('');
    expect(stdout).not.toContain(token);
    expect(stdout).not.toContain(runtime.env.VIEWER_PASSWORD);
    const report = JSON.parse(await readFile(join(output, 'result.json'), 'utf8'));
    expect(report.frames).toHaveLength(2);
    expect(report.viewer).toBe('passed');
    expect(report.checks).toHaveLength(9);
    expect((await readdir(output)).filter((p) => p.endsWith('.png'))).toHaveLength(6);
    const mobile = await readFile(join(output, 'mobile-tokens.png'));
    expect(mobile.readUInt32BE(16)).toBe(390);
    expect(mobile.readUInt32BE(20)).toBe(844);
  } finally {
    await runtime.close();
    await rm(output, { recursive: true, force: true });
  }
}, 60000);
