import { test, expect } from 'vitest';
import * as fs from 'node:fs/promises';
test('README quick-start blocks match the runnable example verbatim', async () => {
  const example = await fs.readFile('examples/quickstart.ts', 'utf8');
  for (const file of ['README.md', 'README_CN.md']) {
    const source = await fs.readFile(file, 'utf8');
    expect(source.startsWith('# Four Tools\n')).toBe(true);
    expect(source.match(/```ts\n([\s\S]*?)```/)?.[1]).toBe(example);
  }
});
test('package has only public-registry development dependencies and bounded AI docs', async () => {
  const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
  expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
  const lock = JSON.parse(await fs.readFile('package-lock.json', 'utf8'));
  for (const value of Object.values(lock.packages) as Array<{
    resolved?: string;
  }>)
    if (value.resolved)
      expect(value.resolved).toMatch(/^https:\/\/registry\.npmjs\.org\//);
  expect(
    (await fs.readFile('AGENTS.md', 'utf8')).split('\n').length,
  ).toBeLessThan(45);
  expect(
    (await fs.readFile('skills/four-tools/SKILL.md', 'utf8')).split('\n')
      .length,
  ).toBeLessThan(60);
});
