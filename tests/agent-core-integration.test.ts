import { test, expect } from 'vitest';
import {
  AgentRuntime,
  InMemoryConversationStore,
  type Tool,
} from '@nia-teams/agent-core';
import {
  createAgentHost,
  createMemoryDocStore,
  createMemoryPubSub,
} from '@nia-teams/agent-core/host';
import type {
  ILLMClient,
  LLMChatRequest,
  LLMChatResponse,
} from '@nia-teams/ai';
import { createFourTools } from '../src/index.js';
import { fixture } from './helpers.js';
function mock(
  chat: (request: LLMChatRequest) => Promise<LLMChatResponse>,
): ILLMClient {
  return { chat, getProviderName: () => 'test', getModelName: () => 'mock' };
}
test('real AgentRuntime executes four tools, aliased arguments, and public guidance shapes', async () => {
  const f = await fixture({ terminals: false });
  try {
    // This assignment is the compile-time zero-glue acceptance check.
    const tools: Tool[] = createFourTools(f.env, {
      hooks: {
        afterMutate: () => [{ kind: 'text', text: 'mutation completed' }],
      },
    });
    const actions = [
      { name: 'write', input: { file_path: 'a', content: 'hello' } },
      { name: 'read', input: { file_path: 'a' } },
      {
        name: 'edit',
        input: { file_path: 'a', oldText: 'hello', newText: 'world' },
      },
      { name: 'shell', input: { command: 'printf foreground' } },
    ];
    let n = 0;
    const client = mock(async () => {
      const action = actions[n++];
      return action
        ? {
            content: null,
            stopReason: 'tool_use',
            toolCalls: [
              {
                id: `call-${n}`,
                name: action.name,
                arguments: JSON.stringify(action.input),
              },
            ],
          }
        : { content: 'done', stopReason: 'end_turn' };
    });
    const store = InMemoryConversationStore.fromUserMessage(
      'Run the four tools.',
    );
    const runtime = new AgentRuntime({ store, sessionId: 'integration' });
    await runtime.run({ client, tools, systemPrompt: 'Use tools.' });
    expect(await f.env.readText(f.file('a'))).toBe('world');
    const results = (await store.loadAll()).filter(
      (message) => message.type === 'tool',
    );
    expect(results).toHaveLength(4);
    expect(results[1].content).toBe('hello');
    expect(results[3].content).toContain('foreground');
    expect(results[0].guidance).toEqual([
      { kind: 'text', text: 'mutation completed' },
    ]);
  } finally {
    await f.cleanup();
  }
});
test('AgentHost wakes and runs a follow-up turn after a background terminal exits', async () => {
  let wake!: (content: string) => Promise<unknown>;
  const f = await fixture({
    onTerminalExit: (event) => wake(JSON.stringify(event)).then(() => {}),
  });
  let followup = false,
    calls = 0,
    ended = 0;
  const client = mock(async (request) => {
    const exitEvent = request.messages.find(
      (message) =>
        message.type === 'event' && message.eventType === 'terminal_exit',
    );
    if (exitEvent) {
      followup = true;
      return { content: 'Background finished.', stopReason: 'end_turn' };
    }
    if (!calls++)
      return {
        content: null,
        stopReason: 'tool_use',
        toolCalls: [
          {
            id: 'long',
            name: 'shell',
            arguments: JSON.stringify({
              command: 'sleep 0.2; printf background-done',
              timeout: 0.01,
            }),
          },
        ],
      };
    return {
      content: 'Command continues in background.',
      stopReason: 'end_turn',
    };
  });
  const host = createAgentHost({
    docStore: createMemoryDocStore(),
    pubSub: createMemoryPubSub(),
    resolveAgentConfig: () => ({
      client,
      tools: createFourTools(f.env),
      systemPrompt: 'Use tools.',
    }),
    onEvent: ({ event }) => {
      if (event.type === 'turn_end') ended++;
    },
  });
  wake = (content) =>
    host.injectMessage({
      sessionId: 'host-test',
      userId: 'terminal',
      userName: 'Terminal',
      eventType: 'terminal_exit',
      content,
    });
  try {
    await host.start();
    await host.injectMessage({
      sessionId: 'host-test',
      userId: 'user',
      userName: 'Alice',
      content: 'Start a long command.',
    });
    await expect.poll(() => followup, { timeout: 5000 }).toBe(true);
    await expect.poll(() => ended, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
    const terminal = (await f.env.terminals!.list())[0];
    expect(await f.env.terminals!.read({ id: terminal.id })).toMatchObject({
      content: 'background-done',
      exitCode: 0,
    });
  } finally {
    await f.env.dispose();
    await host.stop();
    await f.cleanup();
  }
});
