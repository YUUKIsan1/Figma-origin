// Opt-in research only: never imported by the Worker or run during deployment.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const prefix = process.argv[2];
assert(prefix, 'Usage: node scripts/benchmark-png.mjs <temporary npm install prefix>');
assert(process.threadCpuUsage, 'Use Node.js 24.6+ with process.threadCpuUsage');
const packageDir = resolve(prefix, 'node_modules/@resvg/resvg-wasm');
const manifest = JSON.parse(await readFile(resolve(packageDir, 'package.json'), 'utf8'));
assert.equal(manifest.version, '2.6.2', 'This experiment pins @resvg/resvg-wasm 2.6.2');
const { Resvg, initWasm } = await import(pathToFileURL(resolve(packageDir, 'index.mjs')).href);
const wasm = await readFile(resolve(packageDir, 'index_bg.wasm'));
const font = await readFile(new URL('../public/fonts/NotoSansJP.ttf', import.meta.url));
const elapsed = (start) => {
  const used = process.threadCpuUsage(start);
  return (used.user + used.system) / 1000;
};
const round = (n) => Math.round(n * 1000) / 1000;
const start = process.threadCpuUsage();
await initWasm(wasm);
console.log(
  JSON.stringify({
    node: process.version,
    renderer: `@resvg/resvg-wasm@${manifest.version}`,
    metric: 'main-thread CPU milliseconds (local Node, not production Workers)',
    wasmInitCpuMs: round(elapsed(start)),
  }),
);

function svg(width, height, shadow) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
      <feDropShadow dx="0" dy="4" stdDeviation="4" flood-color="#000000" flood-opacity="0.2"/>
    </filter></defs>
    <rect width="100%" height="100%" fill="#f3f4f6"/>
    <rect x="24" y="24" width="300" height="150" rx="16" fill="#235d46"${shadow ? ' filter="url(#shadow)"' : ''}/>
    <text x="40" y="65" font-family="Noto Sans JP" font-size="24" fill="white">今日のアイデア</text>
  </svg>`;
}
function sample(source, width, height) {
  let renderer;
  let image;
  try {
    let start = process.threadCpuUsage();
    renderer = new Resvg(source, {
      font: { fontBuffers: [font], defaultFontFamily: 'Noto Sans JP' },
    });
    const parseCpuMs = elapsed(start);
    start = process.threadCpuUsage();
    image = renderer.render();
    const rasterCpuMs = elapsed(start);
    start = process.threadCpuUsage();
    const png = image.asPng();
    const pngCpuMs = elapsed(start);
    // Verify that every measurement produced a real image at the requested size.
    const header = new DataView(png.buffer, png.byteOffset, png.byteLength);
    assert.equal(header.getUint32(0), 0x89504e47);
    assert.equal(header.getUint32(16), width);
    assert.equal(header.getUint32(20), height);
    return {
      parseCpuMs,
      rasterCpuMs,
      pngCpuMs,
      totalCpuMs: parseCpuMs + rasterCpuMs + pngCpuMs,
      pngBytes: png.length,
    };
  } finally {
    image?.free();
    renderer?.free();
  }
}
function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return round(sorted[Math.ceil(sorted.length * fraction) - 1]);
}
for (const [width, height] of [
  [390, 844],
  [1440, 900],
]) {
  for (const shadow of [false, true]) {
    const source = svg(width, height, shadow);
    const first = sample(source, width, height);
    for (let n = 0; n < 8; n++) sample(source, width, height);
    const samples = Array.from({ length: 20 }, () => sample(source, width, height));
    console.log(
      JSON.stringify({
        width,
        height,
        shadow,
        warmups: 8,
        samples: samples.length,
        firstCpuMs: round(first.totalCpuMs),
        minCpuMs: percentile(
          samples.map((s) => s.totalCpuMs),
          0.05,
        ),
        medianCpuMs: percentile(
          samples.map((s) => s.totalCpuMs),
          0.5,
        ),
        p95CpuMs: percentile(
          samples.map((s) => s.totalCpuMs),
          0.95,
        ),
        medianParseCpuMs: percentile(
          samples.map((s) => s.parseCpuMs),
          0.5,
        ),
        medianRasterCpuMs: percentile(
          samples.map((s) => s.rasterCpuMs),
          0.5,
        ),
        medianPngCpuMs: percentile(
          samples.map((s) => s.pngCpuMs),
          0.5,
        ),
        pngBytes: samples[0].pngBytes,
      }),
    );
  }
}
