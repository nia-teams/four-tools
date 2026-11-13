import { test, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import { Script } from 'node:vm';
import type { ILLMClient, LLMChatResponse } from '@nia-teams/ai';
import { startWebAgent, selectWebClient } from '../examples/web-agent.js';
import { fixture } from './helpers.js';

const answer = (content: string): LLMChatResponse => ({
  content,
  stopReason: 'end_turn',
});

test('model selection follows credentials, base URL, and explicit model', async () => {
  for (const [vars, model] of [
    [
      {
        OPENAI_API_KEY: 'test',
        OPENAI_BASE_URL: 'https://api.deepseek.com/v1',
      },
      'deepseek-chat',
    ],
    [{ OPENAI_API_KEY: 'test' }, 'gpt-4.1'],
    [{ ANTHROPIC_API_KEY: 'test' }, 'claude-sonnet-4-5'],
    [{ GEMINI_API_KEY: 'test', MODEL: 'custom' }, 'custom'],
  ] as const) {
    const client = selectWebClient(vars);
    expect(client.getModelName()).toBe(model);
    if ('close' in client && typeof client.close === 'function')
      await client.close();
  }
  expect(() => selectWebClient({})).toThrow('Set');
});

test('Web Agent HTTP/SSE/tool/file lifecycle, reconnect replay, token and path isolation', async () => {
  const f = await fixture();
  let step = 0,
    followup = false;
  const actions = [
    { name: 'write', input: { path: 'demo.txt', content: 'before' } },
    { name: 'read', input: { path: 'demo.txt' } },
    {
      name: 'edit',
      input: { file_path: 'demo.txt', oldText: 'before', newText: 'after' },
    },
    {
      name: 'shell',
      input: { command: 'sleep 0.35; printf web-background', timeout: 0.01 },
    },
  ];
  const client: ILLMClient = {
    getProviderName: () => 'test',
    getModelName: () => 'mock-web',
    async chat(request) {
      if (
        request.messages.some(
          (message) =>
            message.type === 'event' && message.eventType === 'terminal_exit',
        )
      ) {
        followup = true;
        request.onStreamDelta?.({
          type: 'text',
          content: 'Background follow-up complete.',
        });
        return answer('Background follow-up complete.');
      }
      const action = actions[step++];
      if (action)
        return {
          content: null,
          stopReason: 'tool_use',
          toolCalls: [
            {
              id: `web-${step}`,
              name: action.name,
              arguments: JSON.stringify(action.input),
            },
          ],
        };
      request.onStreamDelta?.({
        type: 'text',
        content: 'Working in the background.',
      });
      return answer('Working in the background.');
    },
  };
  const app = await startWebAgent({
    client,
    host: '127.0.0.1',
    port: 0,
    workspaceDir: f.dir,
  });
  const headers = {
    Authorization: `Bearer ${app.token}`,
    'Content-Type': 'application/json',
  };
  const controllers: AbortController[] = [];
  const streams: Array<Promise<void>> = [];
  async function openStream(path: string, events: Record<string, unknown>[]) {
    const ctrl = new AbortController();
    controllers.push(ctrl);
    const response = await fetch(app.url + path, {
      headers,
      signal: ctrl.signal,
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reading = (async () => {
      const reader = response.body!.getReader(),
        decoder = new TextDecoder();
      let pending = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        let i;
        while ((i = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, i);
          pending = pending.slice(i + 2);
          for (const line of frame.split('\n'))
            if (line.startsWith('data: '))
              events.push(JSON.parse(line.slice(6)));
        }
      }
    })().catch((error) => {
      if (!ctrl.signal.aborted) throw error;
    });
    streams.push(reading);
    return ctrl;
  }
  try {
    expect(app.workspace).toBe(await fs.realpath(f.dir));
    expect(
      (await fetch(app.url + '/api/sessions', { method: 'POST' })).status,
    ).toBe(401);
    expect(
      (
        await fetch(app.url + '/api/sessions', {
          method: 'POST',
          headers: { ...headers, Origin: 'http://untrusted.example' },
        })
      ).status,
    ).toBe(403);
    const page = await (await fetch(app.url)).text();
    expect(page).toContain('data-prompt="2"');
    expect(page).toContain('@media(max-width:760px)');
    const javascript = page.match(/<script>([\s\S]*?)<\/script>/)![1];
    expect(() => new Script(javascript)).not.toThrow();
    const created = await fetch(app.url + '/api/sessions', {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(created.status).toBe(201);
    const { sessionId } = (await created.json()) as { sessionId: string };
    const suffix = `?sessionId=${sessionId}`;
    const events: Record<string, unknown>[] = [];
    const first = await openStream('/api/stream' + suffix, events);
    await expect
      .poll(() => events.some((e) => e.type === 'snapshot'))
      .toBe(true);
    expect(
      (
        await fetch(app.url + '/api/messages' + suffix, {
          method: 'POST',
          headers,
          body: JSON.stringify({ content: 'Use all four tools.' }),
        })
      ).status,
    ).toBe(202);
    await expect
      .poll(() => events.some((e) => e.type === 'tool_call_end'), {
        timeout: 5000,
      })
      .toBe(true);
    const checkpoint = Math.max(...events.map((e) => Number(e._eventId) || 0));
    first.abort();
    await expect.poll(() => followup, { timeout: 5000 }).toBe(true);
    const replay: Record<string, unknown>[] = [];
    await openStream('/api/stream' + suffix + '&since=' + checkpoint, replay);
    await expect
      .poll(() => JSON.stringify(replay), { timeout: 5000 })
      .toContain('follow-up');
    expect(
      replay
        .filter((e) => e._eventId)
        .every((e) => Number(e._eventId) > checkpoint),
    ).toBe(true);
    const complete: Record<string, unknown>[] = [];
    await openStream('/api/stream' + suffix, complete);
    await expect
      .poll(() => complete.filter((e) => e.type === 'tool_call_start').length)
      .toBe(4);
    expect(
      complete.filter((e) => e.type === 'tool_call_start').map((e) => e.name),
    ).toEqual(['write', 'read', 'edit', 'shell']);
    expect(complete.find((e) => e.type === 'tool_call_end')?.output).toContain(
      'File written:',
    );
    expect(complete.filter((e) => e.type === 'user_message')).toHaveLength(1);
    const files = (await (
      await fetch(app.url + '/api/files' + suffix, { headers })
    ).json()) as { files: { path: string }[] };
    expect(files.files.some((e) => e.path === 'demo.txt')).toBe(true);
    expect(
      await (
        await fetch(app.url + '/api/files' + suffix + '&path=demo.txt', {
          headers,
        })
      ).json(),
    ).toMatchObject({ content: 'after' });
    expect(
      (await fetch(app.url + '/api/files' + suffix + '&path=..', { headers }))
        .status,
    ).toBe(400);
    await fs.symlink('..', f.file('outside'));
    expect(
      (
        await fetch(app.url + '/api/files' + suffix + '&path=outside', {
          headers,
        })
      ).status,
    ).toBe(400);
    expect(
      await (
        await fetch(app.url + '/api/terminals' + suffix, { headers })
      ).json(),
    ).toMatchObject([{ status: 'exited', exitCode: 0 }]);
  } finally {
    controllers.forEach((ctrl) => ctrl.abort());
    await Promise.all(streams);
    await app.close();
    await f.cleanup();
  }
}, 20000);

test('Web Agent default workspace is a separate temporary directory, not cwd', async () => {
  const client: ILLMClient = {
    getProviderName: () => 'test',
    getModelName: () => 'mock',
    chat: async () => answer('done'),
  };
  const app = await startWebAgent({ client, host: '127.0.0.1', port: 0 });
  try {
    expect(app.workspace).not.toBe(process.cwd());
    expect(app.workspace).toContain('four-tools-web-');
  } finally {
    await app.close();
    await fs.rm(app.workspace, { recursive: true, force: true });
  }
});
