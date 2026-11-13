import { test, expect, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import type { Tool } from '@nia-teams/agent-core';
import {
  createFourTools,
  createReadTool,
  createShellTool,
  type ExecutionEnv,
  type ManagedTerminalBackend,
  type TerminalInfo,
  type NativeToolContext,
  type Guidance,
} from '../src/index.js';
import { fixture } from './helpers.js';
const terminal: TerminalInfo = {
  id: 'term_123',
  name: '',
  command: 'printf hi',
  cwd: '/demo',
  status: 'running',
  exitCode: null,
  signal: null,
  startedAt: 0,
};
function backend(): ManagedTerminalBackend {
  return {
    execWithHandoff: vi.fn(async () => ({
      completed: true as const,
      output: 'out\nerr\n',
      stdout: 'out\n',
      stderr: 'err\n',
      exitCode: 7,
      signal: null,
      truncated: false,
      durationMs: 12,
    })),
    create: vi.fn(async () => ({ ...terminal })),
    list: vi.fn(async () => []),
    read: vi.fn(async () => ({
      content: 'one\ntwo\n',
      startLine: 1,
      endLine: 2,
      totalLines: 3,
      status: 'running' as const,
      exitCode: null,
      nextOffset: 2,
    })),
    signal: vi.fn(async () => ({ ...terminal })),
    destroy: vi.fn(async () => {}),
  };
}
function env(terminals = backend()): ExecutionEnv {
  const files = new Map<string, string>();
  return {
    id: 'fixture',
    platform: 'linux',
    cwd: '/demo',
    terminals,
    resolvePath: async (p) => ({
      resolvedPath: p.startsWith('/') ? p : '/demo/' + p,
      canonicalPath: p.startsWith('/') ? p : '/demo/' + p,
    }),
    stat: async () => ({
      exists: true,
      isDirectory: false,
      isSymbolicLink: false,
      size: 0,
      mode: 0o644,
      mtimeMs: 0,
    }),
    readText: async (p) => files.get(p) ?? '',
    readRange: async (p) => ({
      content: files.get(p) ?? '',
      startLine: 1,
      endLine: 1,
      totalLines: 1,
      truncatedByBytes: false,
    }),
    writeText: async (p, s) => {
      files.set(p, s);
      return { bytesWritten: new TextEncoder().encode(s).length };
    },
    exec: async () => ({
      output: 'out',
      stdout: 'out',
      stderr: '',
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      truncated: false,
      durationMs: 12,
    }),
  };
}
test('schemas and descriptions match source-derived fixtures, including optional shell fields', async () => {
  const golden = JSON.parse(
    await fs.readFile('tests/fixtures/tool-contracts.json', 'utf8'),
  );
  for (const tool of createFourTools(env()))
    expect({
      description: tool.description,
      inputSchema: tool.inputSchema,
    }).toEqual(golden[tool.name]);
});
test('completed exec preserves exact separators, stderr label, cwd suffix and duration footer', async () => {
  const tool = createShellTool(env());
  expect(await tool.execute({ command: 'printf hi', cwd: 'sub' })).toBe(
    '$ printf hi (cwd: sub)\n---\nout\n\n[stderr] err\n\n---\nexit_code: 7, duration: 12ms',
  );
});
test('handoff text, partial-output cap and abort reason match the native shell', async () => {
  const b = backend();
  b.execWithHandoff = vi.fn(async () => ({
    completed: false as const,
    terminal,
    partialOutput: 'x'.repeat(2001),
    handoffReason: 'timeout' as const,
  }));
  const tool = createShellTool(env(b));
  const out = String(await tool.execute({ command: 'sleep 4', timeout: 2 }));
  expect(out).toBe(
    'Command timed out after 2s — process still running in background.\nTerminal ID: term_123\n\nPartial output so far:\n' +
      'x'.repeat(2000) +
      '\n... (truncated)\n\nUse terminal_read with id="term_123" to check progress.\nUse terminal_signal with id="term_123" to send signals (SIGINT/SIGTERM/SIGKILL).\nUse terminal_destroy with id="term_123" to clean up when done.',
  );
  b.execWithHandoff = vi.fn(async () => ({
    completed: false as const,
    terminal,
    partialOutput: '',
    handoffReason: 'abort' as const,
  }));
  expect(
    await tool.execute({ command: 'sleep 4' }, { signal: AbortSignal.abort() }),
  ).toMatch(
    /^Foreground turn ended — process still running in background\.\nTerminal ID:/,
  );
});
test('all terminal action text and missing-field responses match the source contract', async () => {
  const b = backend(),
    e = env(b),
    tool = createShellTool(e);
  expect(await tool.execute({})).toBe('Error: command is required for exec');
  expect(await tool.execute({ action: 'terminal_create' })).toBe(
    'Error: command is required for terminal_create',
  );
  expect(await tool.execute({ action: 'terminal_read' })).toBe(
    'Error: id is required for terminal_read',
  );
  expect(await tool.execute({ action: 'terminal_signal' })).toBe(
    'Error: id and signal are required for terminal_signal',
  );
  expect(await tool.execute({ action: 'terminal_destroy' })).toBe(
    'Error: id is required for terminal_destroy',
  );
  expect(await tool.execute({ action: 'other' })).toBe('Unknown action: other');
  expect(await tool.execute({ action: 'terminal_list' })).toBe(
    'No active terminals',
  );
  expect(
    await tool.execute({
      action: 'terminal_create',
      command: 'printf hi',
      cwd: 'sub',
    }),
  ).toBe(
    'Terminal created\n  ID: term_123\n  Name: (unnamed)\n  Status: running\n  Command: printf hi',
  );
  expect(b.create).toHaveBeenCalledWith(
    expect.objectContaining({ cwd: '/demo/sub', notifyOnExit: true }),
  );
  b.list = async () => [
    terminal,
    { ...terminal, id: 'term_456', name: 'done', status: 'exited' },
  ];
  expect(await tool.execute({ action: 'terminal_list' })).toBe(
    '[running] term_123 - (unnamed) (printf hi) [0 lines]\n[stopped] term_456 - done (printf hi) [0 lines]',
  );
  expect(await tool.execute({ action: 'terminal_read', id: terminal.id })).toBe(
    'one\ntwo\n---\nstatus: running, total_lines: 3, next_offset: 2',
  );
  expect(
    await tool.execute({
      action: 'terminal_signal',
      id: terminal.id,
      signal: 'SIGTERM',
    }),
  ).toBe('Sent SIGTERM');
  expect(
    await tool.execute({ action: 'terminal_destroy', id: terminal.id }),
  ).toBe('Terminal destroyed');
});
test('file strings retain UTF-16 chars count, exact edit status, and error newlines', async () => {
  const tools = createFourTools(env());
  expect(await tools[1].execute({ path: 'a', content: '😀' })).toBe(
    'File written: a (2 chars)',
  );
  expect(
    await tools[2].execute({
      path: 'a',
      old_string: 'missing',
      new_string: 'x',
    }),
  ).toBe('ERROR: old_string not found in file\n');
  expect(
    await tools[2].execute({ file_path: 'a', oldText: '😀', newText: 'x' }),
  ).toBe('OK: replacement applied');
  await tools[1].execute({ path: 'a', content: 'xx' });
  expect(
    await tools[2].execute({ path: 'a', old_string: 'x', new_string: 'z' }),
  ).toBe('ERROR: old_string found 2 times, must be unique\n');
});
test('native string-only bridge is structurally assignable and receives post-context without parsing', async () => {
  interface NativeTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    execute(
      input: Record<string, unknown>,
      ctx: NativeToolContext,
    ): Promise<string>;
  }
  const tools = createFourTools(env(), {
    hooks: {
      afterMutate: () => [{ kind: 'text', text: 'host advisory' }],
      afterExec: () => ['shell advisory'],
    },
  });
  const native: NativeTool = tools[1];
  const runtime: Tool = tools[1];
  expect(runtime.name).toBe('write');
  const ctx = {
    workspaceId: 'workspace',
    teamId: 'team',
    model: 'model',
    aiPostContext: [] as Guidance[],
  };
  const result: string = await native.execute(
    { path: 'a', content: 'hello' },
    ctx,
  );
  expect(result).toBe('File written: a (5 chars)');
  expect(ctx.aiPostContext).toEqual([{ kind: 'text', text: 'host advisory' }]);
});
test('read returns requested slices verbatim; only tool-imposed caps add continuation text', async () => {
  const f = await fixture();
  try {
    await f.env.writeText(f.file('a'), 'a\nb\nc\n');
    expect(await createReadTool(f.env).execute({ path: 'a', limit: 1 })).toBe(
      'a\n',
    );
    expect(
      await createReadTool(f.env, { maxLines: 1 }).execute({ path: 'a' }),
    ).toBe('a\n\n\n[Showing lines 1-1 of 3. Use offset=2 to continue.]');
    const large = 'x'.repeat(60000) + '\n';
    await f.env.writeText(f.file('a'), large);
    expect(
      await createReadTool(f.env, { truncate: false }).execute({ path: 'a' }),
    ).toBe(large);
    expect(
      await createReadTool(f.env, { maxLines: false, maxBytes: false }).execute(
        { path: 'a' },
      ),
    ).toBe(large);
  } finally {
    await f.cleanup();
  }
});
test('production file-change regex accepts success and rejects failure and handoff', async () => {
  const success = (content: string) =>
    !/^Terminal ID:/m.test(content) &&
    /\nexit_code: 0, duration: [\d.]+ms\s*$/.test(content);
  const f = await fixture({ terminals: false });
  try {
    const tool = createShellTool(f.env);
    expect(success(String(await tool.execute({ command: 'printf ok' })))).toBe(
      true,
    );
    expect(success(String(await tool.execute({ command: 'exit 7' })))).toBe(
      false,
    );
  } finally {
    await f.cleanup();
  }
});
test('terminal reads validate safe integer pages and permit limit=0; signals use canonical exit codes', async () => {
  const f = await fixture();
  try {
    const info = await f.env.terminals!.create({
      command: 'printf "one\\ntwo\\n"; sleep 5',
      notifyOnExit: false,
    });
    await expect
      .poll(
        async () => (await f.env.terminals!.read({ id: info.id })).totalLines,
      )
      .toBe(2);
    expect(
      await createShellTool(f.env).execute({
        action: 'terminal_read',
        id: info.id,
        limit: 0,
      }),
    ).toBe('---\nstatus: running, total_lines: 2, next_offset: 0');
    await expect(
      f.env.terminals!.read({ id: info.id, offset: -1 }),
    ).rejects.toThrow('non-negative safe integer');
    await expect(
      f.env.terminals!.read({ id: info.id, limit: 0.5 }),
    ).rejects.toThrow('non-negative safe integer');
    await f.env.terminals!.signal({ id: info.id, signal: 'SIGTERM' });
    await expect
      .poll(async () => (await f.env.terminals!.read({ id: info.id })).exitCode)
      .toBe(143);
    expect(
      await createShellTool(f.env).execute({
        action: 'terminal_read',
        id: info.id,
      }),
    ).toContain('status: stopped');
  } finally {
    await f.cleanup();
  }
});

test('read and successful-exec host hooks receive context without affecting wire strings', async () => {
  const f = await fixture({ terminals: false });
  try {
    const afterRead = vi.fn(() => ['title advisory']);
    const afterExec = vi.fn(() => ['context advisory']);
    const tools = createFourTools(f.env, { hooks: { afterRead, afterExec } });
    await f.env.writeText(f.file('a'), 'a\nb\n');
    expect(await tools[0].execute({ path: 'a' })).toEqual({
      content: 'a\nb\n',
      guidance: ['title advisory'],
    });
    expect(afterRead).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: 'a\nb\n' }),
    );
    await tools[0].execute({ path: 'a', limit: 1 });
    expect(afterRead).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: undefined }),
    );
    const ctx = {
      workspaceId: 'workspace',
      teamId: 'team',
      model: 'model',
      aiPostContext: [] as Guidance[],
    };
    expect(await tools[3].execute({ command: 'true' }, ctx)).toMatch(
      /exit_code: 0, duration: \d+ms$/,
    );
    expect(ctx.aiPostContext).toEqual(['context advisory']);
    await tools[3].execute({ command: 'exit 1' }, ctx);
    expect(afterExec).toHaveBeenCalledTimes(1);
  } finally {
    await f.cleanup();
  }
});
test('terminal_create passes an actual cwd to the Node backend', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(f.file('sub'));
    const tool = createShellTool(f.env);
    expect(
      await tool.execute({
        action: 'terminal_create',
        command: 'pwd',
        cwd: 'sub',
        notifyOnExit: false,
      }),
    ).toMatch(/^Terminal created\n  ID:/);
    const info = (await f.env.terminals!.list())[0];
    expect(info.cwd).toBe(f.file('sub'));
    await expect
      .poll(async () =>
        (await f.env.terminals!.read({ id: info.id })).content.trim(),
      )
      .toBe(await fs.realpath(f.file('sub')));
  } finally {
    await f.cleanup();
  }
});

test('raw reads preserve the UTF-8 BOM, CRLF and trailing spaces', async () => {
  const f = await fixture();
  try {
    const original = '\uFEFFone  \r\ntwo \r\n';
    await f.env.writeText(f.file('bom'), original);
    const read = createReadTool(f.env);
    expect(await read.execute({ path: 'bom' })).toBe(original);
    expect(await read.execute({ path: 'bom', limit: 1 })).toBe(
      '\uFEFFone  \r\n',
    );
  } finally {
    await f.cleanup();
  }
});
