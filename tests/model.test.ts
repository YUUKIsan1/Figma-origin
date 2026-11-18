import { describe, expect, it } from 'vitest';
import {
  nodeSchema,
  componentSchema,
  resolvedFrame,
  nodePatchSchema,
  tokensSchema,
  validateFile,
  type DesignFile,
} from '../src/model';
import { renderDocument } from '../src/render';
function fixture(): DesignFile {
  return {
    id: 'file',
    name: 'Test',
    tokens: tokensSchema.parse({ colors: { brand: '#123456' } }),
    pages: [
      {
        id: 'page',
        name: 'Page',
        frames: [
          {
            id: 'frame',
            name: 'Mobile',
            width: 390,
            height: 844,
            background: '#ffffff',
            nodes: [nodeSchema.parse({ id: 'node', type: 'rect', fill: { token: 'brand' } })],
          },
        ],
      },
    ],
  };
}
describe('design validation', () => {
  it('accepts references and rejects deleting a referenced token', () => {
    const f = fixture();
    validateFile(f);
    f.tokens.colors = {};
    expect(() => validateFile(f)).toThrow('Unknown token');
  });
  it('rejects group cycles, cross-frame parents, and duplicate IDs', () => {
    const f = fixture();
    const nodes = f.pages[0].frames[0].nodes;
    nodes.push(nodeSchema.parse({ id: 'group', type: 'group', parentId: 'group' }));
    expect(() => validateFile(f)).toThrow('Group cycle');
    nodes[1].parentId = 'missing';
    expect(() => validateFile(f)).toThrow('Parent must be');
    nodes[1].parentId = null;
    nodes[1].id = 'node';
    expect(() => validateFile(f)).toThrow('Duplicate ID');
  });
  it('patches omit defaults instead of resetting geometry', () => {
    expect(nodePatchSchema.parse({ id: 'node', fill: '#123456' })).toEqual({
      id: 'node',
      fill: '#123456',
    });
  });
  it('escapes text and names in rendered HTML', () => {
    const f = fixture();
    f.pages[0].frames[0].nodes[0] = nodeSchema.parse({
      id: 'text',
      type: 'text',
      text: '<script>alert(1)</script>',
      name: '" onload="bad',
    });
    const html = renderDocument(f.pages[0].frames[0], f.tokens, {}, '/font.ttf');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('component invariants', () => {
  it('keeps legacy files valid and namespaces derived children without copying masters into storage', () => {
    const f = fixture();
    validateFile(f);
    f.components = [
      componentSchema.parse({
        id: 'card',
        name: 'Card',
        nodes: [{ id: 'node', type: 'rect', fill: { token: 'brand' } }],
      }),
    ];
    f.pages[0].frames[0].nodes.push(
      nodeSchema.parse({ id: 'first', type: 'instance', componentId: 'card' }),
      nodeSchema.parse({ id: 'second', type: 'instance', componentId: 'card' }),
    );
    validateFile(f);
    const frame = resolvedFrame(f, 'frame');
    expect(frame.nodes.map((n) => n.id)).toEqual([
      'node',
      'first',
      'first/node',
      'second',
      'second/node',
    ]);
    expect(f.pages[0].frames[0].nodes).toHaveLength(3);
  });
  it('rejects nested instances, unknown components and direct edits beneath an instance', () => {
    const f = fixture();
    f.components = [
      componentSchema.parse({ id: 'card', name: 'Card', nodes: [{ id: 'child', type: 'rect' }] }),
    ];
    const frame = f.pages[0].frames[0];
    frame.nodes = [nodeSchema.parse({ id: 'instance', type: 'instance', componentId: 'missing' })];
    expect(() => validateFile(f)).toThrow('Unknown component');
    frame.nodes[0].componentId = 'card';
    frame.nodes.push(nodeSchema.parse({ id: 'injected', type: 'text', parentId: 'instance' }));
    expect(() => validateFile(f)).toThrow('Parent must be a group');
    expect(() =>
      componentSchema.parse({
        id: 'nested',
        name: 'Nested',
        nodes: [{ type: 'instance', componentId: 'card' }],
      }),
    ).toThrow('Nested component instances');
    frame.nodes.pop();
    f.components[0].nodes = [
      nodeSchema.parse({ id: 'self', type: 'instance', componentId: 'card' }),
    ];
    expect(() => validateFile(f)).toThrow('Nested component instances');
  });
  it('enforces the expanded frame budget on both placements and master updates', () => {
    const f = fixture();
    f.components = [
      componentSchema.parse({
        id: 'card',
        name: 'Card',
        nodes: Array.from({ length: 199 }, (_, i) => ({ id: `child-${i}`, type: 'rect' })),
      }),
    ];
    f.pages[0].frames[0].nodes = Array.from({ length: 5 }, (_, i) =>
      nodeSchema.parse({ id: `instance-${i}`, type: 'instance', componentId: 'card' }),
    );
    validateFile(f); // Exactly 5 * (1 instance + 199 children) = 1000.
    f.components[0].nodes.push(nodeSchema.parse({ id: 'extra', type: 'rect' }));
    expect(() => validateFile(f)).toThrow('Maximum 1000 expanded nodes');
  });
});
