import { describe, expect, it } from 'vitest';
import {
  nodeSchema,
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
