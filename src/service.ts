import { rateLimit } from './auth';
import { z } from 'zod';
import { base64 } from './encoding';
import type { Env } from './env';
import {
  AppError,
  assert,
  findFrame,
  frameInput,
  frameTree,
  id,
  nodeSchema,
  nodePatchSchema,
  tokensSchema,
  type DesignNode,
} from './model';
import { Store } from './store';
import { renderFrame } from './render';
const fileId = { fileId: id };
const frameId = { ...fileId, frameId: id };
const version = { expectedVersion: z.number().int().positive().optional() };
export const inputs = {
  list_files: z.object({}).strict(),
  create_file: z.object({ name: z.string().trim().min(1).max(200) }).strict(),
  get_file: z.object(fileId).strict(),
  create_page: z
    .object({ ...fileId, ...version, name: z.string().trim().min(1).max(200) })
    .strict(),
  create_frame: z.object({ ...fileId, ...version, pageId: id, frame: frameInput }).strict(),
  create_nodes: z
    .object({ ...frameId, ...version, nodes: z.array(nodeSchema).min(1).max(200) })
    .strict(),
  update_nodes: z
    .object({ ...frameId, ...version, nodes: z.array(nodePatchSchema).min(1).max(200) })
    .strict(),
  delete_nodes: z.object({ ...frameId, ...version, nodeIds: z.array(id).min(1).max(200) }).strict(),
  set_tokens: z.object({ ...fileId, ...version, tokens: tokensSchema }).strict(),
  get_tokens: z.object(fileId).strict(),
  get_frame_tree: z.object(frameId).strict(),
  render_frame: z.object(frameId).strict(),
  upload_image: z
    .object({
      data: z.string().min(1).max(2_800_000),
      mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    })
    .strict(),
  list_revisions: z.object(fileId).strict(),
  restore_revision: z
    .object({
      ...fileId,
      revision: z.number().int().positive(),
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
};
export type ToolName = keyof typeof inputs;
export const descriptions: Record<ToolName, string> = {
  list_files: 'List design files',
  create_file: 'Create an empty design file',
  get_file: 'Read file and current version',
  create_page: 'Add page to file',
  create_frame: 'Add mobile or desktop frame to page',
  create_nodes: 'Add up to 200 nodes atomically; group coordinates are relative to parent',
  update_nodes: 'Patch nodes atomically; unspecified properties are preserved',
  delete_nodes: 'Delete nodes and descendants atomically',
  set_tokens: 'Replace all file tokens; references must remain valid',
  get_tokens: 'Read file design tokens',
  get_frame_tree: 'Read nested frame tree with file tokens',
  render_frame: 'Render frame as PNG image',
  upload_image: 'Upload base64 PNG, JPEG or WebP (2 MB maximum)',
  list_revisions: 'List last 20 file revisions',
  restore_revision: 'Restore a previous revision as a new version',
};

export async function execute(
  name: ToolName,
  raw: unknown,
  env: Env,
  origin: string,
): Promise<unknown> {
  if (
    [
      'create_file',
      'create_page',
      'create_frame',
      'create_nodes',
      'update_nodes',
      'delete_nodes',
      'set_tokens',
      'restore_revision',
    ].includes(name)
  )
    await rateLimit(env.WRITE_RATE_LIMITER, 'workspace');
  const store = new Store(env);
  switch (name) {
    case 'list_files':
      inputs[name].parse(raw);
      return store.list();
    case 'create_file': {
      const a = inputs[name].parse(raw);
      return store.create({
        id: crypto.randomUUID(),
        name: a.name,
        pages: [],
        tokens: tokensSchema.parse({}),
      });
    }
    case 'get_file':
      return store.get(inputs[name].parse(raw).fileId);
    case 'create_page': {
      const a = inputs[name].parse(raw);
      const page = { id: crypto.randomUUID(), name: a.name, frames: [] };
      const result = await store.mutate(
        a.fileId,
        (f) => {
          f.pages.push(page);
        },
        a.expectedVersion,
      );
      return { page, version: result.version };
    }
    case 'create_frame': {
      const a = inputs[name].parse(raw);
      const frame = { ...a.frame, id: crypto.randomUUID(), nodes: [] };
      const result = await store.mutate(
        a.fileId,
        (f) => {
          const page = f.pages.find((p) => p.id === a.pageId);
          if (!page) throw new AppError(404, 'Page not found');
          page.frames.push(frame);
        },
        a.expectedVersion,
      );
      return { frame, version: result.version };
    }
    case 'create_nodes': {
      const a = inputs[name].parse(raw);
      await checkImages(a.nodes, env);
      const result = await store.mutate(
        a.fileId,
        (f) => {
          findFrame(f, a.frameId).nodes.push(...a.nodes);
        },
        a.expectedVersion,
      );
      return { nodes: a.nodes, version: result.version };
    }
    case 'update_nodes': {
      const a = inputs[name].parse(raw);
      assert(new Set(a.nodes.map((n) => n.id)).size === a.nodes.length, 'Duplicate update IDs');
      await checkImages(a.nodes, env);
      const result = await store.mutate(
        a.fileId,
        (f) => {
          const frame = findFrame(f, a.frameId);
          for (const patch of a.nodes) {
            const index = frame.nodes.findIndex((n) => n.id === patch.id);
            if (index < 0) throw new AppError(404, 'Node not found');
            frame.nodes[index] = nodeSchema.parse({ ...frame.nodes[index], ...patch });
          }
        },
        a.expectedVersion,
      );
      return { version: result.version };
    }
    case 'delete_nodes': {
      const a = inputs[name].parse(raw);
      const result = await store.mutate(
        a.fileId,
        (f) => {
          const frame = findFrame(f, a.frameId);
          const remove = new Set(a.nodeIds);
          for (const nodeId of remove)
            assert(
              frame.nodes.some((n) => n.id === nodeId),
              `Node not found: ${nodeId}`,
            );
          let changed = true;
          while (changed) {
            changed = false;
            for (const n of frame.nodes)
              if (n.parentId && remove.has(n.parentId) && !remove.has(n.id)) {
                remove.add(n.id);
                changed = true;
              }
          }
          frame.nodes = frame.nodes.filter((n) => !remove.has(n.id));
        },
        a.expectedVersion,
      );
      return { version: result.version };
    }
    case 'set_tokens': {
      const a = inputs[name].parse(raw);
      const result = await store.mutate(
        a.fileId,
        (f) => {
          f.tokens = a.tokens;
        },
        a.expectedVersion,
      );
      return { tokens: a.tokens, version: result.version };
    }
    case 'get_tokens': {
      const { file, version } = await store.get(inputs[name].parse(raw).fileId);
      return { tokens: file.tokens, version };
    }
    case 'get_frame_tree': {
      const a = inputs[name].parse(raw);
      const { file, version } = await store.get(a.fileId);
      return { frame: frameTree(findFrame(file, a.frameId)), tokens: file.tokens, version };
    }
    case 'render_frame': {
      const a = inputs[name].parse(raw);
      const { file, version } = await store.get(a.fileId);
      const key = `renders/${file.id}/${a.frameId}/${version}.png`;
      const cached = await env.IMAGES.get(key);
      const png = cached
        ? new Uint8Array(await cached.arrayBuffer())
        : await renderFrame(findFrame(file, a.frameId), file.tokens, env, origin);
      if (!cached) await env.IMAGES.put(key, png, { httpMetadata: { contentType: 'image/png' } });
      return { data: base64(png), mimeType: 'image/png' };
    }
    case 'upload_image': {
      const a = inputs[name].parse(raw);
      let data: Uint8Array;
      try {
        data = Uint8Array.from(atob(a.data), (c) => c.charCodeAt(0));
      } catch {
        throw new AppError(400, 'Invalid base64');
      }
      assert(data.byteLength <= 2_000_000, 'Image exceeds 2 MB');
      assert(validImage(data, a.mimeType), 'Image signature does not match MIME type');
      const imageId = crypto.randomUUID();
      await env.IMAGES.put(imageId, data, { httpMetadata: { contentType: a.mimeType } });
      return { imageId };
    }
    case 'list_revisions':
      return store.revisions(inputs[name].parse(raw).fileId);
    case 'restore_revision': {
      const a = inputs[name].parse(raw);
      return store.restore(a.fileId, a.revision, a.expectedVersion);
    }
  }
}
async function checkImages(nodes: Partial<DesignNode>[], env: Env) {
  for (const node of nodes)
    if (node.imageId)
      assert(await env.IMAGES.head(node.imageId), `Image not found: ${node.imageId}`);
}
export function validImage(b: Uint8Array, mime: string) {
  if (mime === 'image/png') return [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => b[i] === v);
  if (mime === 'image/jpeg') return b[0] === 255 && b[1] === 216 && b[2] === 255;
  return (
    b.length >= 12 &&
    String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...b.subarray(8, 12)) === 'WEBP'
  );
}
