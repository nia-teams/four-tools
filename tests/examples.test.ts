import { test, expect } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { resolve } from 'node:path';
import { fixture } from './helpers.js';

for (const example of ['quickstart', 'local-agent']) {
  test(`${example} runs with real ai client HTTP streaming and public package imports`, async () => {
    const f = await fixture();
    let calls = 0;
    const requests: string[] = [];
    const server = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      requests.push(raw);
      const first = calls++ === 0;
      const fn =
        example === 'quickstart'
          ? {
              name: 'read',
              arguments: JSON.stringify({ path: 'package.json' }),
            }
          : {
              name: 'shell',
              arguments: JSON.stringify({
                command: 'sleep 0.2; printf example-background-done',
                timeout: 0.01,
              }),
            };
      const content =
        example === 'local-agent' && requests.length >= 3
          ? 'Follow-up report.'
          : 'Example complete.';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const delta = first
        ? {
            role: 'assistant',
            tool_calls: [
              { index: 0, id: 'example-call', type: 'function', function: fn },
            ],
          }
        : { role: 'assistant', content };
      for (const chunk of [
        { choices: [{ index: 0, delta, finish_reason: null }] },
        {
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: first ? 'tool_calls' : 'stop',
            },
          ],
        },
      ])
        res.write(
          `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model: 'mock', ...chunk })}\n\n`,
        );
      res.end('data: [DONE]\n\n');
    });
    await new Promise<void>((yes) => server.listen(0, '127.0.0.1', yes));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing server address');
    const url = `http://127.0.0.1:${address.port}`;
    const preload = f.file('redirect.mjs');
    await fs.writeFile(
      preload,
      `const original = globalThis.fetch; globalThis.fetch = (input, init) => original(new URL(new URL(String(input)).pathname, ${JSON.stringify(url)}), init);`,
    );
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--import',
        preload,
        resolve(`examples/${example}.ts`),
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: '',
          GEMINI_API_KEY: '',
          OPENAI_API_KEY: 'test-only',
          DEEPSEEK_API_KEY: 'test-only',
          OPENAI_BASE_URL: url,
          MODEL: 'mock',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (data) => {
      output += data;
    });
    child.stderr.on('data', (data) => {
      output += data;
    });
    const done = new Promise<number | null>((yes, no) => {
      child.on('close', yes);
      child.on('error', no);
    });
    try {
      if (example === 'local-agent') {
        await expect
          .poll(() => output, { timeout: 15000 })
          .toContain('Local agent');
        child.stdin.write('Start the background command.\n');
        await expect
          .poll(() => output, { timeout: 15000 })
          .toContain('Follow-up report.');
        expect(output).toContain('[shell]');
        expect(output).toContain('[terminal');
        child.stdin.write('/exit\n');
      }
      expect(
        await Promise.race([
          done,
          new Promise((resolve) =>
            setTimeout(() => resolve('timeout'), 20000).unref(),
          ),
        ]),
        output,
      ).toBe(0);
      expect(output).toContain('Example complete.');
      expect(calls).toBeGreaterThanOrEqual(example === 'quickstart' ? 2 : 3);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await done;
      await new Promise<void>((yes, no) =>
        server.close((error) => (error ? no(error) : yes())),
      );
      await f.cleanup();
    }
  }, 45000);
}
