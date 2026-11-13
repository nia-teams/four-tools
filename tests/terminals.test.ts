import { test, expect } from 'vitest';
import { createShellTool, type TerminalExitEvent } from '../src/index.js';
import { fixture, delay } from './helpers.js';

test('fast foreground completion suppresses callbacks and removes ephemeral logs', async () => {
  const events: TerminalExitEvent[] = [];
  const f = await fixture({
    onTerminalExit: (event) => {
      events.push(event);
    },
  });
  try {
    const result = await f.env.terminals!.execWithHandoff({
      command: 'printf fast',
      handoffAfterMs: 1000,
    });
    expect(result).toMatchObject({
      completed: true,
      output: 'fast',
      exitCode: 0,
    });
    expect(await f.env.terminals!.list()).toEqual([]);
    expect(events).toEqual([]);
  } finally {
    await f.cleanup();
  }
});
test('timeout hands off without killing and emits one exit notification', async () => {
  const events: TerminalExitEvent[] = [];
  const f = await fixture({
    onTerminalExit: (event) => {
      events.push(event);
    },
  });
  try {
    const result = await f.env.terminals!.execWithHandoff({
      command: 'printf start; sleep 0.15; printf finish; exit 7',
      handoffAfterMs: 10,
    });
    expect(result.completed).toBe(false);
    if (result.completed) throw new Error('Expected handoff');
    expect(result.terminal.status).toBe('running');
    await expect.poll(() => events.length).toBe(1);
    expect(events[0]).toMatchObject({
      exitCode: 7,
      status: 'exited',
      outputPreview: 'startfinish',
    });
    expect(
      await f.env.terminals!.read({ id: result.terminal.id }),
    ).toMatchObject({ content: 'startfinish', exitCode: 7 });
    await delay(30);
    expect(events.length).toBe(1);
  } finally {
    await f.cleanup();
  }
});
test('create/list/read/signal/destroy and notification suppression', async () => {
  const events: TerminalExitEvent[] = [];
  const f = await fixture({
    onTerminalExit: (event) => {
      events.push(event);
    },
  });
  try {
    const backend = f.env.terminals!;
    const terminal = await backend.create({
      command: 'printf "one\ntwo\nthree\n"; sleep 5',
      name: 'worker',
    });
    expect((await backend.list())[0]).toMatchObject({
      name: 'worker',
      status: 'running',
    });
    await expect
      .poll(
        async () =>
          (await backend.read({ id: terminal.id, offset: 1, limit: 1 }))
            .content,
      )
      .toBe('two\n');
    await backend.signal({ id: terminal.id, signal: 'SIGTERM' });
    await expect.poll(() => events.length).toBe(1);
    expect(events[0].signal).toBe('SIGTERM');
    await backend.destroy({ id: terminal.id });
    expect(await backend.list()).toEqual([]);
    const destroyed = await backend.create({ command: 'sleep 5' });
    await backend.destroy({ id: destroyed.id });
    expect(events.length).toBe(1);
    await expect(backend.read({ id: destroyed.id })).rejects.toThrow(
      'Unknown terminal',
    );
    await backend.dispose();
    await expect(backend.create({ command: 'true' })).rejects.toThrow(
      'disposed',
    );
  } finally {
    await f.cleanup();
  }
});
test('abort handoff versus abort kill and pre-aborted request', async () => {
  const events: TerminalExitEvent[] = [];
  const f = await fixture({
    onTerminalExit: (event) => {
      events.push(event);
    },
  });
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30);
    const result = await f.env.terminals!.execWithHandoff({
      command: 'sleep 0.15; printf survived',
      handoffAfterMs: 5000,
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    expect(result.completed).toBe(false);
    await expect.poll(() => events.length).toBe(1);
    expect(events[0].outputPreview).toBe('survived');
    const kill = new AbortController();
    const timer2 = setTimeout(() => kill.abort(), 30);
    expect(
      await f.env.terminals!.execWithHandoff({
        command: 'sleep 5',
        handoffAfterMs: 5000,
        signal: kill.signal,
        onAbort: 'kill',
      }),
    ).toMatchObject({ completed: true, signal: 'SIGKILL' });
    clearTimeout(timer2);
    await expect(
      f.env.terminals!.execWithHandoff({
        command: 'sleep 5',
        handoffAfterMs: 1,
        signal: AbortSignal.abort(),
      }),
    ).resolves.toMatchObject({ completed: false, handoffReason: 'abort' });
    expect(events.length).toBe(1);
  } finally {
    await f.cleanup();
  }
});
test('shell schema reflects backend availability and per-call env is isolated', async () => {
  const f = await fixture({ terminals: false });
  try {
    const tool = createShellTool(f.env, {
      name: 'bash',
      hooks: {
        resolveEnv: (ctx) => ({
          FOUR_TOOLS_SECRET: String(ctx.metadata?.secret),
        }),
      },
    });
    expect(tool.name).toBe('bash');
    expect(Object.keys(tool.inputSchema.properties as object)).toEqual([
      'command',
      'cwd',
      'timeout',
    ]);
    const result = await tool.execute(
      { command: 'printf "$FOUR_TOOLS_SECRET"' },
      { metadata: { secret: 'credential' } },
    );
    expect(result).toMatch(
      /\n---\ncredential\n---\nexit_code: 0, duration: \d+ms$/,
    );
    expect(process.env.FOUR_TOOLS_SECRET).toBeUndefined();
    expect(await tool.execute({ action: 'terminal_list' })).toContain(
      'unavailable',
    );
  } finally {
    await f.cleanup();
  }
});
test('background shell dispatch works and foreground overflow remains readable', async () => {
  const f = await fixture();
  try {
    const tool = createShellTool(f.env);
    expect(
      (tool.inputSchema.properties as Record<string, unknown>).action,
    ).toBeDefined();
    const created = String(
      await tool.execute({
        action: 'terminal_create',
        command: 'printf hi; sleep 5',
        notifyOnExit: false,
      }),
    );
    const terminal = { id: created.match(/  ID: (.+)/)![1] };
    expect(String(await tool.execute({ action: 'terminal_list' }))).toContain(
      terminal.id,
    );
    await expect
      .poll(async () =>
        String(
          await tool.execute({ action: 'terminal_read', id: terminal.id }),
        ),
      )
      .toContain('hi');
    expect(
      await tool.execute({
        action: 'terminal_signal',
        id: terminal.id,
        signal: 'SIGKILL',
      }),
    ).toBe('Sent SIGKILL');
    expect(
      await tool.execute({ action: 'terminal_destroy', id: terminal.id }),
    ).toBe('Terminal destroyed');
    const result = await f.env.terminals!.execWithHandoff({
      command: `${JSON.stringify(process.execPath)} -e 'process.stdout.write("z".repeat(10000))'`,
      handoffAfterMs: 5000,
      maxOutputBytes: 100,
    });
    expect(result).toMatchObject({ completed: true, truncated: true });
    if (result.completed)
      expect(await f.env.readText(result.spillPath!)).toBe('z'.repeat(10000));
  } finally {
    await f.cleanup();
  }
});

test('managed descendants keep inherited log FDs after shell exit, including delayed stdout and stderr', async () => {
  const f = await fixture();
  try {
    const terminal = await f.env.terminals!.create({
      command:
        "(sleep 0.35; printf 'late stdout\\n'; printf 'late stderr\\n' >&2; printf success > descendant-ok) & printf 'early\\n'",
      notifyOnExit: false,
    });
    await expect
      .poll(async () => (await f.env.terminals!.list())[0].status)
      .toBe('exited');
    await expect
      .poll(
        async () => (await f.env.terminals!.read({ id: terminal.id })).content,
      )
      .toBe('early\nlate stdout\nlate stderr\n');
    expect(await f.env.readText(f.file('descendant-ok'))).toBe('success');
    expect((await f.env.terminals!.list())[0].id).toBe(terminal.id);
  } finally {
    await f.cleanup();
  }
});
test('foreground managed shell with surviving group becomes a retained terminal instead of unlinking its log', async () => {
  const f = await fixture();
  try {
    const result = await f.env.terminals!.execWithHandoff({
      command: '(sleep 0.35; printf delayed) & printf early',
      handoffAfterMs: 1000,
    });
    expect(result.completed).toBe(false);
    if (result.completed) throw new Error('Expected surviving process group');
    await expect
      .poll(
        async () =>
          (await f.env.terminals!.read({ id: result.terminal.id })).content,
      )
      .toBe('earlydelayed');
  } finally {
    await f.cleanup();
  }
});
