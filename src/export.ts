import {
  resolvedFrame,
  resolve,
  type DesignFile,
  type DesignNode,
  type Frame,
  type Ref,
  type TextStyle,
  type Tokens,
} from './model';
export interface SpecNode extends DesignNode {
  resolved: {
    x: number;
    y: number;
    w: number;
    h: number;
    fill: string;
    stroke: string;
    strokeWidth: number;
    radius: number;
    textStyle: Omit<TextStyle, 'color'> & { color: string };
    shadow: { x: number; y: number; blur: number; color: string } | null;
  };
  children: SpecNode[];
}
export interface FrameSpecification {
  schemaVersion: 1;
  file: { id: string; name: string; version: number };
  page: { id: string; name: string };
  frame: Omit<Frame, 'nodes'> & { resolvedBackground: string };
  tokens: Tokens;
  components: { id: string; name: string }[];
  nodes: SpecNode[];
}
export interface FrameExport {
  markdown: string;
  spec: FrameSpecification;
  png?: { data: string; mimeType: 'image/png' };
}
function isRef(value: unknown): value is Ref {
  return (
    typeof value === 'object' &&
    value !== null &&
    'token' in value &&
    typeof value.token === 'string'
  );
}
function usedValue<T>(source: T | Ref, all: Record<string, T>, used: Record<string, T>): T {
  const value = resolve(source, all);
  if (isRef(source))
    Object.defineProperty(used, source.token, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  return value;
}
// Escape user content as prose/table text rather than allowing names or design copy to create markup.
function md(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/[\\`*_[\]{}()#+.!|~-]/g, '\\$&');
}
function shown(source: unknown, value: unknown, category: string): string {
  const literal = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return md(isRef(source) ? `${category}.${source.token} → ${literal}` : literal);
}
export function exportFrameSpec(file: DesignFile, frameId: string, version: number): FrameExport {
  const frame = resolvedFrame(file, frameId);
  const page = file.pages.find((p) => p.frames.some((f) => f.id === frameId))!;
  const used: Tokens = { colors: {}, spacing: {}, radii: {}, textStyles: {} };
  const color = (value: DesignNode['fill']) => usedValue(value, file.tokens.colors, used.colors);
  const spacing = (value: DesignNode['w']) => usedValue(value, file.tokens.spacing, used.spacing);
  const resolvedBackground = color(frame.background);
  const byParent = new Map<string | null, DesignNode[]>();
  for (const node of frame.nodes) {
    const siblings = byParent.get(node.parentId) ?? [];
    siblings.push(node);
    byParent.set(node.parentId, siblings);
  }
  const children = (parentId: string | null): SpecNode[] =>
    (byParent.get(parentId) ?? []).map((node) => {
      const style = usedValue(node.textStyle, file.tokens.textStyles, used.textStyles);
      return {
        ...node,
        resolved: {
          x: spacing(node.x),
          y: spacing(node.y),
          w: spacing(node.w),
          h: spacing(node.h),
          fill: color(node.fill),
          stroke: color(node.stroke),
          strokeWidth: spacing(node.strokeWidth),
          radius: usedValue(node.radius, file.tokens.radii, used.radii),
          textStyle: { ...style, color: color(style.color) },
          shadow: node.shadow ? { ...node.shadow, color: color(node.shadow.color) } : null,
        },
        children: children(node.id),
      };
    });
  const nodes = children(null);
  const referenced = new Set(
    frame.nodes.flatMap((n) => (n.type === 'instance' && n.componentId ? [n.componentId] : [])),
  );
  const components = (file.components ?? [])
    .filter((c) => referenced.has(c.id))
    .map((c) => ({ id: c.id, name: c.name }));
  const spec: FrameSpecification = {
    schemaVersion: 1,
    file: { id: file.id, name: file.name, version },
    page: { id: page.id, name: page.name },
    frame: {
      id: frame.id,
      name: frame.name,
      width: frame.width,
      height: frame.height,
      background: frame.background,
      resolvedBackground,
    },
    tokens: used,
    components,
    nodes,
  };
  const lines = [
    `# フレーム仕様: ${md(frame.name)}`,
    '',
    `- ファイル: ${md(file.name)} (${md(file.id)})`,
    `- ページ: ${md(page.name)} (${md(page.id)})`,
    `- 版: ${version}`,
    `- フレームID: ${md(frame.id)}`,
    `- サイズ: ${frame.width} × ${frame.height} px`,
    `- 背景: ${shown(frame.background, resolvedBackground, 'colors')}`,
    '',
    '座標は親ノード基準、単位はpx。文字の行間は倍率です。groupとinstanceの子は1:1で描画し、フレーム境界で切り取ります。ノードの順序は描画順です。',
    '',
    '## 参照トークン',
    '',
  ];
  for (const category of ['colors', 'textStyles', 'spacing', 'radii'] as const) {
    lines.push(`### ${category}`, '', '| 名前 | 定義 |', '| --- | --- |');
    for (const [name, value] of Object.entries(used[category]))
      lines.push(`| ${md(name)} | ${md(JSON.stringify(value))} |`);
    if (Object.keys(used[category]).length === 0) lines.push('| — | 参照なし |');
    lines.push('');
  }
  lines.push('## コンポーネント', '');
  for (const component of components) lines.push(`- ${md(component.name)} (${md(component.id)})`);
  if (!components.length) lines.push('参照なし');
  lines.push('', '## ノードツリー', '');
  const describe = (node: SpecNode, depth: number) => {
    const indent = '  '.repeat(depth);
    const r = node.resolved;
    lines.push(`${indent}- **${md(node.name)}** (${md(node.id)}) / ${node.type}`);
    lines.push(
      `${indent}  - x: ${shown(node.x, r.x, 'spacing')}, y: ${shown(node.y, r.y, 'spacing')}, w: ${shown(node.w, r.w, 'spacing')}, h: ${shown(node.h, r.h, 'spacing')}`,
    );
    lines.push(
      `${indent}  - 塗り: ${shown(node.fill, r.fill, 'colors')}; 線: ${shown(node.stroke, r.stroke, 'colors')}; 線幅: ${shown(node.strokeWidth, r.strokeWidth, 'spacing')}; 角丸: ${shown(node.radius, r.radius, 'radii')}; 不透明度: ${node.opacity}`,
    );
    if (node.shadow)
      lines.push(
        `${indent}  - 影: ${md(JSON.stringify(node.shadow))} → ${md(JSON.stringify(r.shadow))}`,
      );
    if (node.type === 'text')
      lines.push(
        `${indent}  - テキスト: ${md(JSON.stringify(node.text))}`,
        `${indent}  - 文字スタイル: ${shown(node.textStyle, r.textStyle, 'textStyles')}`,
      );
    if (node.type === 'image') lines.push(`${indent}  - 画像ID: ${md(node.imageId!)}`);
    if (node.type === 'instance') lines.push(`${indent}  - 部品ID: ${md(node.componentId!)}`);
    for (const child of node.children) describe(child, depth + 1);
  };
  for (const node of nodes) describe(node, 0);
  if (!nodes.length) lines.push('ノードなし');
  lines.push(
    '',
    'JSON仕様には元のトークン参照とresolvedの実値を併記しています。展開済みの部品の子ノードは読み取り専用です。',
    '',
  );
  return { markdown: lines.join('\n'), spec };
}
