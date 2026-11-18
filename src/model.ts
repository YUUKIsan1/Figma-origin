import { z } from 'zod';
export const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const name = z.string().trim().min(1).max(200);
const color = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/);
const number = z.number().finite();
const size = number.min(0).max(4096);
const ref = z.object({ token: id }).strict();
const paint = z.union([color, ref]);
const scalar = z.union([number.min(0).max(4096), ref]);
export const textStyle = z
  .object({
    font: z.enum(['sans', 'serif', 'mono']).default('sans'),
    size: number.min(1).max(512).default(16),
    weight: z.enum(['normal', 'bold']).default('normal'),
    lineHeight: number.min(0.5).max(4).default(1.5),
    color: paint.default('#111827'),
    align: z.enum(['left', 'center', 'right']).default('left'),
  })
  .strict();
export const tokensSchema = z
  .object({
    colors: z.record(id, color).default({}),
    spacing: z.record(id, number.min(0).max(4096)).default({}),
    radii: z.record(id, number.min(0).max(4096)).default({}),
    textStyles: z.record(id, textStyle).default({}),
  })
  .strict();
export const nodeSchema = z
  .object({
    id: id.default(() => crypto.randomUUID()),
    name: name.default('Node'),
    type: z.enum(['rect', 'text', 'image', 'group', 'instance']),
    parentId: id.nullable().default(null),
    x: z.union([number.min(-16384).max(16384), ref]).default(0),
    y: z.union([number.min(-16384).max(16384), ref]).default(0),
    w: z.union([size, ref]).default(100),
    h: z.union([size, ref]).default(100),
    fill: paint.default('#ffffff'),
    stroke: paint.default('#00000000'),
    strokeWidth: scalar.default(0),
    radius: scalar.default(0),
    opacity: number.min(0).max(1).default(1),
    shadow: z
      .object({
        x: number.min(-512).max(512),
        y: number.min(-512).max(512),
        blur: number.min(0).max(128),
        color: paint,
      })
      .strict()
      .nullable()
      .default(null),
    text: z.string().max(10000).default(''),
    textStyle: z.union([textStyle, ref]).default(() => textStyle.parse({})),
    imageId: id.optional(),
    componentId: id.nullable().optional(),
  })
  .strict();
export const componentSchema = z
  .object({
    id: id.default(() => crypto.randomUUID()),
    name,
    nodes: z
      .array(
        nodeSchema.refine(
          (node) => node.type !== 'instance',
          'Nested component instances are not supported',
        ),
      )
      .min(1)
      .max(200),
  })
  .strict();
export const instanceSchema = nodeSchema
  .pick({ id: true, parentId: true, x: true, y: true, w: true, h: true, opacity: true })
  .extend({ componentId: id, name: name.optional() })
  .strict();
export type Component = z.infer<typeof componentSchema>;
// Strip creation defaults from patches; omitted properties must stay unchanged.
const fields = nodeSchema.shape;
export const nodePatchSchema = z
  .object({
    id,
    type: fields.type.optional(),
    imageId: fields.imageId,
    componentId: fields.componentId,
    name: fields.name.removeDefault().optional(),
    parentId: fields.parentId.removeDefault().optional(),
    x: fields.x.removeDefault().optional(),
    y: fields.y.removeDefault().optional(),
    w: fields.w.removeDefault().optional(),
    h: fields.h.removeDefault().optional(),
    fill: fields.fill.removeDefault().optional(),
    stroke: fields.stroke.removeDefault().optional(),
    strokeWidth: fields.strokeWidth.removeDefault().optional(),
    radius: fields.radius.removeDefault().optional(),
    opacity: fields.opacity.removeDefault().optional(),
    shadow: fields.shadow.removeDefault().optional(),
    text: fields.text.removeDefault().optional(),
    textStyle: fields.textStyle.removeDefault().optional(),
  })
  .strict();
export const frameInput = z
  .object({
    name,
    width: number.int().min(1).max(4096),
    height: number.int().min(1).max(4096),
    background: paint.default('#ffffff'),
  })
  .strict()
  .refine((v) => v.width * v.height <= 8_000_000, 'Frame exceeds 8 million pixels');
export type DesignNode = z.infer<typeof nodeSchema>;
export type Tokens = z.infer<typeof tokensSchema>;
export type TextStyle = z.infer<typeof textStyle>;
export type Ref = z.infer<typeof ref>;
export type Frame = z.infer<typeof frameInput> & { id: string; nodes: DesignNode[] };
export interface Page {
  id: string;
  name: string;
  frames: Frame[];
}
export interface DesignFile {
  id: string;
  name: string;
  pages: Page[];
  tokens: Tokens;
  components?: Component[];
}
export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AppError(400, message);
}
export function resolve<T>(value: T | Ref, values: Record<string, T>): T {
  if (typeof value === 'object' && value !== null && 'token' in value) {
    const token = (value as Ref).token;
    const found = Object.hasOwn(values, token) ? values[token] : undefined;
    assert(found !== undefined, `Unknown token: ${(value as Ref).token}`);
    return found;
  }
  return value as T;
}
function validateNodes(
  nodes: DesignNode[],
  tokens: Tokens,
  components: Component[],
  unique: (id: string) => void,
  expanded = false,
  allowInstances = true,
) {
  const map = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    unique(node.id);
    for (const value of [node.x, node.y, node.w, node.h]) resolve(value, tokens.spacing);
    resolve(node.fill, tokens.colors);
    resolve(node.stroke, tokens.colors);
    resolve(node.radius, tokens.radii);
    resolve(node.strokeWidth, tokens.spacing);
    resolve(resolve(node.textStyle, tokens.textStyles).color, tokens.colors);
    if (node.shadow) resolve(node.shadow.color, tokens.colors);
    if (node.type === 'image') assert(node.imageId, 'Image nodes require imageId');
    if (node.type === 'instance') {
      assert(allowInstances, 'Nested component instances are not supported');
      assert(
        node.componentId && components.some((c) => c.id === node.componentId),
        'Unknown component',
      );
    } else assert(!node.componentId, 'Only instances may reference a component');
    let parent = node.parentId;
    const seen = new Set([node.id]);
    let depth = 0;
    while (parent) {
      assert(!seen.has(parent), 'Group cycle');
      seen.add(parent);
      const group = map.get(parent);
      assert(
        group?.type === 'group' || (expanded && group?.type === 'instance'),
        'Parent must be a group in the same frame',
      );
      assert(++depth <= 20, 'Maximum group depth 20');
      parent = group.parentId;
    }
  }
}
function uniqueIds(initial: string[] = []) {
  const ids = new Set(initial);
  return (value: string) => {
    assert(!ids.has(value), `Duplicate ID: ${value}`);
    ids.add(value);
  };
}
export function expandFrame(frame: Frame, components: Component[] = []): Frame {
  const nodes: DesignNode[] = [];
  for (const node of frame.nodes) {
    const master =
      node.type === 'instance' ? components.find((c) => c.id === node.componentId) : undefined;
    if (node.type === 'instance') assert(master, 'Unknown component');
    assert(
      nodes.length + 1 + (master?.nodes.length ?? 0) <= 1000,
      'Maximum 1000 expanded nodes per frame',
    );
    nodes.push(node);
    if (master)
      for (const child of master.nodes)
        nodes.push({
          ...child,
          id: `${node.id}/${child.id}`,
          parentId: child.parentId ? `${node.id}/${child.parentId}` : node.id,
        });
  }
  return { ...frame, nodes };
}
export function validateFile(file: DesignFile) {
  assert(file.pages.length <= 100, 'Maximum 100 pages');
  const components = file.components ?? [];
  assert(components.length <= 100, 'Maximum 100 components per file');
  const componentIds = uniqueIds();
  for (const component of components) {
    componentIds(component.id);
    assert(
      component.nodes.length >= 1 && component.nodes.length <= 200,
      'Components require 1 to 200 nodes',
    );
    validateNodes(component.nodes, file.tokens, components, uniqueIds(), false, false);
  }
  const unique = uniqueIds([file.id]);
  for (const style of Object.values(file.tokens.textStyles))
    resolve(style.color, file.tokens.colors);
  for (const page of file.pages) {
    unique(page.id);
    assert(page.frames.length <= 100, 'Maximum 100 frames per page');
    for (const frame of page.frames) {
      unique(frame.id);
      resolve(frame.background, file.tokens.colors);
      assert(frame.nodes.length <= 1000, 'Maximum 1000 nodes per frame');
      validateNodes(frame.nodes, file.tokens, components, unique);
      if (frame.nodes.some((node) => node.type === 'instance'))
        validateNodes(
          expandFrame(frame, components).nodes,
          file.tokens,
          components,
          uniqueIds(),
          true,
        );
    }
  }
  assert(JSON.stringify(file).length <= 1_000_000, 'File exceeds 1 MB');
}
export function resolvedFrame(file: DesignFile, frameId: string) {
  return expandFrame(findFrame(file, frameId), file.components);
}
export function findFrame(file: DesignFile, frameId: string): Frame {
  const frame = file.pages.flatMap((p) => p.frames).find((f) => f.id === frameId);
  if (!frame) throw new AppError(404, 'Frame not found');
  return frame;
}
export function frameTree(frame: Frame) {
  const children = (parentId: string | null): unknown[] =>
    frame.nodes
      .filter((n) => n.parentId === parentId)
      .map((n) => ({ ...n, children: children(n.id) }));
  return { ...frame, nodes: children(null) };
}
