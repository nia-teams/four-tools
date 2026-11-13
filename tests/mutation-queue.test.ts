import { test, expect } from 'vitest';
import { FileMutationQueue, createFourTools } from '../src/index.js';
import { fixture } from './helpers.js';
test('FIFO locks survive aborts until in-flight writes settle; other namespaces do not block', async () => {
  const queue = new FileMutationQueue();
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ctrl = new AbortController();
  const a = queue.run(
    'a',
    '/file',
    async () => {
      calls.push('start');
      await gate;
      calls.push('end');
    },
    ctrl.signal,
  );
  await Promise.resolve();
  ctrl.abort();
  const b = queue.run('a', '/file', async () => {
    calls.push('second');
  });
  const c = queue.run('a', '/other', async () => {
    calls.push('other');
  });
  const d = queue.run('b', '/file', async () => {
    calls.push('namespace');
  });
  const skipped = queue.run(
    'a',
    '/file',
    async () => {
      calls.push('wrong');
    },
    ctrl.signal,
  );
  const rejection = expect(skipped).rejects.toThrow();
  await Promise.all([c, d]);
  expect(calls).toEqual(['start', 'other', 'namespace']);
  release();
  await Promise.all([a, b, rejection]);
  expect(calls).toEqual(['start', 'other', 'namespace', 'end', 'second']);
});
test('write and edit share canonical-path FIFO and return mutation guidance', async () => {
  const f = await fixture();
  try {
    const tools = createFourTools(f.env, {
      hooks: { afterMutate: () => [{ kind: 'text', text: 'updated' }] },
    });
    const write = await tools[1].execute({ filepath: 'a', content: 'old' });
    expect(write).toMatchObject({
      guidance: [{ kind: 'text', text: 'updated' }],
    });
    await Promise.all([
      tools[1].execute({ path: 'a', content: 'second' }),
      tools[2].execute({ file_path: 'a', oldText: 'second', newText: 'third' }),
    ]);
    expect(await f.env.readText(f.file('a'))).toBe('third');
  } finally {
    await f.cleanup();
  }
});

test('explicit mutationQueue coordinates multiple createFourTools groups', async () => {
  const f = await fixture();
  try {
    await f.env.writeText(f.file('shared'), 'initial');
    const mutationQueue = new FileMutationQueue();
    let acquired!: () => void, release!: () => void;
    const started = new Promise<void>((yes) => {
      acquired = yes;
    });
    const gate = new Promise<void>((yes) => {
      release = yes;
    });
    const first = createFourTools(f.env, {
      mutationQueue,
      hooks: {
        afterMutate: async () => {
          acquired();
          await gate;
        },
      },
    });
    const second = createFourTools(f.env, { mutationQueue });
    const write = first[1].execute({ path: 'shared', content: 'first' });
    await started;
    const edit = second[2].execute({
      path: 'shared',
      old_string: 'first',
      new_string: 'second',
    });
    await Promise.resolve();
    expect(await f.env.readText(f.file('shared'))).toBe('first');
    release();
    await Promise.all([write, edit]);
    expect(await f.env.readText(f.file('shared'))).toBe('second');
  } finally {
    await f.cleanup();
  }
});
