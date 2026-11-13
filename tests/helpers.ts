import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeEnv, type NodeEnvOptions } from '../src/node/index.js';
export async function fixture(options: NodeEnvOptions = {}) {
  const dir = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'four-tools-test-')),
  );
  const env = createNodeEnv({
    cwd: dir,
    homeDir: dir,
    spillDir: join(dir, 'logs'),
    ...options,
  });
  return {
    dir,
    env,
    file: (name: string) => join(dir, name),
    async cleanup() {
      await env.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
export const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
