import puppeteer from '@cloudflare/puppeteer';
import type { Env } from './env';
import {
  resolve,
  resolvedFrame,
  type DesignFile,
  type DesignNode,
  type Frame,
  type Tokens,
} from './model';
import { base64 } from './encoding';
export function escape(value: string) {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
export function renderDocument(
  frame: Frame,
  tokens: Tokens,
  images: Record<string, string>,
  fontURL: string,
): string {
  const paint = (v: DesignNode['fill']) => resolve(v, tokens.colors);
  const nodes = (parentId: string | null): string =>
    frame.nodes
      .filter((n) => n.parentId === parentId)
      .map((n) => {
        const style = resolve(n.textStyle, tokens.textStyles);
        const shadow = n.shadow
          ? `${n.shadow.x}px ${n.shadow.y}px ${n.shadow.blur}px ${paint(n.shadow.color)}`
          : 'none';
        const common = `position:absolute;box-sizing:border-box;left:${resolve(n.x, tokens.spacing)}px;top:${resolve(n.y, tokens.spacing)}px;width:${resolve(n.w, tokens.spacing)}px;height:${resolve(n.h, tokens.spacing)}px;background:${paint(n.fill)};border:${resolve(n.strokeWidth, tokens.spacing)}px solid ${paint(n.stroke)};border-radius:${resolve(n.radius, tokens.radii)}px;box-shadow:${shadow};opacity:${n.opacity};`;
        const textCSS = `font-family:${style.font === 'sans' ? 'Arial' : style.font === 'serif' ? 'Georgia' : 'monospace'},'Canvas Japanese';font-size:${style.size}px;font-weight:${style.weight};line-height:${style.lineHeight};color:${paint(style.color)};text-align:${style.align};white-space:pre-wrap;overflow-wrap:anywhere;`;
        const content =
          n.type === 'group' || n.type === 'instance'
            ? nodes(n.id)
            : n.type === 'text'
              ? escape(n.text)
              : n.type === 'image'
                ? `<img alt="${escape(n.name)}" src="${escape(images[n.imageId!] ?? '')}" style="width:100%;height:100%;object-fit:cover;display:block;border-radius:inherit">`
                : '';
        return `<div style="${common}${n.type === 'text' ? textCSS + 'overflow:hidden;' : n.type === 'image' ? 'overflow:hidden;' : ''}">${content}</div>`;
      })
      .join('');
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(frame.name)}</title><style>@font-face{font-family:'Canvas Japanese';src:url('${escape(fontURL)}') format('truetype');font-weight:100 900}html,body{margin:0;padding:0;width:${frame.width}px;height:${frame.height}px;overflow:hidden}body{position:relative;background:${paint(frame.background)}}</style></head><body>${nodes(null)}</body></html>`;
}
export async function imageSources(frame: Frame, env: Env, inline: boolean) {
  const images: Record<string, string> = {};
  for (const imageId of new Set(frame.nodes.flatMap((n) => (n.imageId ? [n.imageId] : [])))) {
    if (!inline) {
      images[imageId] = `/images/${imageId}`;
      continue;
    }
    const object = await env.IMAGES.get(imageId);
    if (object)
      images[imageId] =
        `data:${object.httpMetadata?.contentType};base64,${base64(new Uint8Array(await object.arrayBuffer()))}`;
  }
  return images;
}
export async function renderFrame(frame: Frame, tokens: Tokens, env: Env, origin: string) {
  const fontURL = `${origin}/fonts/NotoSansJP.ttf`;
  const html = renderDocument(frame, tokens, await imageSources(frame, env, true), fontURL);
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: frame.width, height: frame.height, deviceScaleFactor: 1 });
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (req.url().startsWith('data:') || req.url() === 'about:blank' || req.url() === fontURL)
        void req.continue();
      else void req.abort();
    });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map((img) => img.decode().catch(() => undefined)));
    });
    return new Uint8Array(await page.screenshot({ type: 'png' }));
  } finally {
    await browser.close();
  }
}

// Share a versioned cache and a single file snapshot between render_frame and specification export.
export async function cachedFramePng(
  file: DesignFile,
  version: number,
  frameId: string,
  env: Env,
  origin: string,
) {
  const frame = resolvedFrame(file, frameId);
  const key = `renders/${file.id}/${frameId}/${version}.png`;
  const cached = await env.IMAGES.get(key);
  const png = cached
    ? new Uint8Array(await cached.arrayBuffer())
    : await renderFrame(frame, file.tokens, env, origin);
  if (!cached) await env.IMAGES.put(key, png, { httpMetadata: { contentType: 'image/png' } });
  return { data: base64(png), mimeType: 'image/png' as const };
}
