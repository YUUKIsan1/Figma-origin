import { expect, it } from 'vitest';
import { startTestRuntime } from './helpers/runtime';
import { Store } from '../src/store';
import { execute } from '../src/service';
import { tokensSchema, type DesignFile } from '../src/model';

it.each([
  { label: 'an existing token', colors: { brand: '#123456' } },
  { label: 'a newly introduced token', colors: {} },
])('restores a pre-component snapshot when the master uses $label', async ({ colors }) => {
  const runtime = await startTestRuntime();
  try {
    const store = new Store(runtime.env);
    const legacy: DesignFile = {
      id: crypto.randomUUID(),
      name: 'Legacy file',
      tokens: tokensSchema.parse({ colors }),
      pages: [
        {
          id: 'page',
          name: 'Home',
          frames: [
            {
              id: 'frame',
              name: 'Mobile',
              width: 390,
              height: 844,
              background: '#ffffff',
              nodes: [],
            },
          ],
        },
      ],
    };
    // Simulate a file persisted before create_file started emitting components: [].
    await store.create(legacy);
    const original = await store.get(legacy.id);
    expect(original.file).not.toHaveProperty('components');
    const call = (name: Parameters<typeof execute>[0], args: Record<string, unknown>) =>
      execute(name, { fileId: legacy.id, ...args }, runtime.env, runtime.origin);
    await call('set_tokens', { tokens: { colors: { brand: '#235d46' } } });
    await call('set_component', {
      component: { id: 'card', name: 'Card', nodes: [{ type: 'rect', fill: { token: 'brand' } }] },
    });
    await call('create_instances', { frameId: 'frame', instances: [{ componentId: 'card' }] });
    await store.mutate(legacy.id, (file) => Object.assign(file, { currentOnly: 'newer metadata' }));
    const modern = await store.get(legacy.id);
    expect(modern.file.components).toHaveLength(1);
    const restored = (await call('restore_revision', {
      revision: original.version,
      expectedVersion: modern.version,
    })) as { file: DesignFile; version: number };
    expect(restored).toEqual({ file: { ...legacy, components: [] }, version: modern.version + 1 });
    expect(restored.file).not.toHaveProperty('currentOnly');
    expect(await store.get(legacy.id)).toEqual(restored);
    expect(await call('list_components', {})).toEqual({
      components: [],
      version: restored.version,
    });
    // Restoring the old snapshot must also retain the ability to return to the modern one.
    const roundTrip = (await call('restore_revision', {
      revision: modern.version,
      expectedVersion: restored.version,
    })) as { file: DesignFile; version: number };
    expect(roundTrip.file).toEqual(modern.file);
    expect(roundTrip.version).toBe(restored.version + 1);
  } finally {
    await runtime.close();
  }
});
