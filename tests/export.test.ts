import { describe, expect, it } from 'vitest';
import { exportFrameSpec } from '../src/export';
import {
  componentSchema,
  nodeSchema,
  tokensSchema,
  validateFile,
  type DesignFile,
} from '../src/model';
function fixture(): DesignFile {
  return {
    id: 'file',
    name: 'ReNote',
    tokens: tokensSchema.parse({
      colors: {
        canvas: '#f6f8f5',
        brand: '#235d46',
        ink: '#ffffff',
        shadow: '#00000033',
        unused: '#ff0000',
      },
      spacing: { inset: 24, line: 2, unused: 100 },
      radii: { card: 16, unused: 10 },
      textStyles: {
        heading: { size: 24, color: { token: 'ink' } },
        unused: { size: 8, color: '#ff0000' },
      },
    }),
    components: [
      componentSchema.parse({
        id: 'card',
        name: 'Note card',
        nodes: [
          { id: 'caption', type: 'text', text: 'Shared label', textStyle: { token: 'heading' } },
        ],
      }),
      componentSchema.parse({
        id: 'unused',
        name: 'Other component',
        nodes: [{ type: 'rect', fill: { token: 'unused' } }],
      }),
    ],
    pages: [
      {
        id: 'page',
        name: 'Home',
        frames: [
          {
            id: 'mobile',
            name: 'Mobile',
            width: 390,
            height: 844,
            background: { token: 'canvas' },
            nodes: [
              nodeSchema.parse({
                id: 'group',
                type: 'group',
                x: { token: 'inset' },
                y: 20,
                w: 300,
                h: 180,
                fill: { token: 'brand' },
                stroke: { token: 'ink' },
                strokeWidth: { token: 'line' },
                radius: { token: 'card' },
                shadow: { x: 0, y: 4, blur: 12, color: { token: 'shadow' } },
              }),
              nodeSchema.parse({
                id: 'title',
                type: 'text',
                parentId: 'group',
                text: '今日のアイデア',
                textStyle: { token: 'heading' },
              }),
              nodeSchema.parse({
                id: 'image',
                type: 'image',
                parentId: 'group',
                imageId: 'image-asset',
              }),
              nodeSchema.parse({ id: 'instance', type: 'instance', componentId: 'card', y: 240 }),
            ],
          },
          {
            id: 'other',
            name: 'Other',
            width: 100,
            height: 100,
            background: { token: 'unused' },
            nodes: [],
          },
        ],
      },
    ],
  };
}
describe('frame specification', () => {
  it('exports transitive used tokens, component names, original references and resolved values without modifying the file', () => {
    const file = fixture();
    validateFile(file);
    const before = structuredClone(file);
    const { spec, markdown } = exportFrameSpec(file, 'mobile', 7);
    expect(spec.file).toEqual({ id: 'file', name: 'ReNote', version: 7 });
    expect(spec.page).toEqual({ id: 'page', name: 'Home' });
    expect(spec.frame.width).toBe(390);
    expect(spec.frame.height).toBe(844);
    expect(spec.frame.background).toEqual({ token: 'canvas' });
    expect(spec.frame.resolvedBackground).toBe('#f6f8f5');
    expect(Object.keys(spec.tokens.colors).sort()).toEqual(['brand', 'canvas', 'ink', 'shadow']);
    expect(spec.tokens.spacing).toEqual({ inset: 24, line: 2 });
    expect(spec.tokens.radii).toEqual({ card: 16 });
    expect(Object.keys(spec.tokens.textStyles)).toEqual(['heading']);
    expect(spec.tokens.textStyles.heading.color).toEqual({ token: 'ink' });
    expect(spec.components).toEqual([{ id: 'card', name: 'Note card' }]);
    const group = spec.nodes[0];
    expect(group.x).toEqual({ token: 'inset' });
    expect(group.resolved.x).toBe(24);
    expect(group.resolved.radius).toBe(16);
    expect(group.children[0].text).toBe('今日のアイデア');
    expect(group.children[0].resolved.textStyle.color).toBe('#ffffff');
    expect(group.children[1].imageId).toBe('image-asset');
    expect(spec.nodes[1].children[0].id).toBe('instance/caption');
    expect(markdown).toContain('390 × 844 px');
    expect(markdown).toContain('Note card');
    expect(markdown).toContain('今日のアイデア');
    expect(markdown).toContain('spacing\\.inset → 24');
    expect(file).toEqual(before);
  });
  it('escapes design text in Markdown but keeps exact text in JSON', () => {
    const file = fixture();
    const danger = '![image](https://example.invalid) | <script>\n```\n# injected';
    file.pages[0].frames[0].name = danger;
    file.pages[0].frames[0].nodes[1].text = danger;
    const result = exportFrameSpec(file, 'mobile', 1);
    expect(result.markdown).not.toContain('<script>');
    expect(result.markdown).not.toContain('![image]');
    expect(result.markdown).not.toContain('```');
    expect(result.markdown).not.toContain('\n# injected');
    expect(result.spec.nodes[0].children[0].text).toBe(danger);
  });
  it('exports empty legacy frames and rejects missing frame IDs', () => {
    const file = fixture();
    delete file.components;
    file.pages[0].frames[0].nodes = [];
    const result = exportFrameSpec(file, 'mobile', 1);
    expect(result.spec.nodes).toEqual([]);
    expect(result.spec.components).toEqual([]);
    expect(result.markdown).toContain('ノードなし');
    expect(result).not.toHaveProperty('png');
    expect(() => exportFrameSpec(file, 'missing', 1)).toThrow('Frame not found');
  });
});
