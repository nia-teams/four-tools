import { createInterface } from 'node:readline';
import {
  createAgentHost,
  createMemoryDocStore,
  createMemoryPubSub,
} from '@nia-teams/agent-core/host';
import {
  AnthropicClient,
  OpenAIClient,
  GeminiClient,
  type ILLMClient,
} from '@nia-teams/ai';
import { createFourTools } from '@nia-teams/four-tools';
import { createNodeEnv } from '@nia-teams/four-tools/node';

const vars = process.env;
function selectClient(): ILLMClient {
  if (vars.ANTHROPIC_API_KEY)
    return new AnthropicClient({
      apiKey: vars.ANTHROPIC_API_KEY,
      model: vars.MODEL ?? 'claude-sonnet-4-5',
    });
  if (vars.OPENAI_API_KEY)
    return new OpenAIClient({
      apiKey: vars.OPENAI_API_KEY,
      baseURL: vars.OPENAI_BASE_URL,
      model: vars.MODEL ?? 'gpt-4.1',
    });
  if (vars.GEMINI_API_KEY)
    return new GeminiClient({
      apiKey: vars.GEMINI_API_KEY,
      model: vars.MODEL ?? 'gemini-2.5-flash',
    });
  throw new Error(
    'Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY; MODEL overrides the default.',
  );
}
const upstream = selectClient();
const sessionId = 'local';
let active: AbortController | undefined;
let closing = false;
let lastInterrupt = 0;
// agent-core 0.1.x exposes injectMessage, not submit, and has no turn-cancel API.
// A shared controller cancels both model requests and tool operations for this local session.
const client: ILLMClient = {
  getProviderName: () => upstream.getProviderName(),
  getModelName: () => upstream.getModelName(),
  chat: (request) =>
    upstream.chat({
      ...request,
      signal: combine(request.signal, active?.signal),
    }),
};
function combine(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  const signals = [a, b].filter((s): s is AbortSignal => Boolean(s));
  return signals.length ? AbortSignal.any(signals) : undefined;
}
const env = createNodeEnv({
  cwd: process.cwd(),
  onTerminalExit: async (event) => {
    if (closing) return;
    console.log(
      `\n[terminal ${event.name || '(unnamed)'}] ${event.status} (${event.exitCode ?? event.signal})`,
    );
    await host.injectMessage({
      sessionId,
      userId: 'terminal',
      userName: 'Terminal',
      eventType: 'terminal_exit',
      content: JSON.stringify(event),
    });
  },
  onTerminalError: (error) => console.error('\n[terminal error]', error),
});
const tools = createFourTools(env).map((tool) => ({
  ...tool,
  execute: (
    input: Record<string, unknown>,
    ctx: Parameters<typeof tool.execute>[1] = {},
  ) =>
    tool.execute(input, {
      ...ctx,
      signal: combine(ctx.signal, active?.signal),
    }),
}));
const host = createAgentHost({
  docStore: createMemoryDocStore(),
  pubSub: createMemoryPubSub(),
  resolveAgentConfig: () => ({
    client,
    tools,
    systemPrompt:
      'You are a local coding assistant. Read before editing. Ask before destructive or external actions. Report terminal_exit events to the user. Commands that exceed the shell timeout continue in managed terminals.',
  }),
  onEvent({ event }) {
    if (event.type === 'turn_start') {
      active = new AbortController();
      process.stdout.write('\nAgent> ');
    }
    if (event.type === 'text_delta') process.stdout.write(event.delta);
    if (event.type === 'thinking_delta')
      process.stdout.write(`\x1b[2m${event.delta}\x1b[0m`);
    if (event.type === 'tool_call_start')
      console.log(`\n[${event.name}]`, event.input);
    if (event.type === 'tool_call_end' && event.error)
      console.error(`\n[tool error] ${event.error}`);
    if (event.type === 'error') console.error(`\n[error] ${event.message}`);
    if (event.type === 'turn_end') {
      active = undefined;
      rl.prompt();
    }
  },
});
async function shutdown() {
  if (closing) return;
  closing = true;
  active?.abort();
  rl.close();
  process.stdin.destroy();
  await env.dispose();
  await host.stop();
  if ('close' in upstream && typeof upstream.close === 'function')
    await upstream.close();
}
function interrupt() {
  const now = Date.now();
  if (now - lastInterrupt < 1200 || !active) {
    void shutdown().catch(console.error);
    return;
  }
  lastInterrupt = now;
  active.abort();
  console.log('\n[interrupted; Ctrl+C again to exit]');
}
await host.start();
const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '\nYou> ',
});
rl.on('SIGINT', interrupt);
process.on('SIGINT', interrupt);
rl.on('line', (line) => {
  if (line.trim() === '/exit') {
    void shutdown().catch(console.error);
    return;
  }
  if (!line.trim() || closing) return;
  void host
    .injectMessage({
      sessionId,
      userId: 'local-user',
      userName: 'You',
      content: line,
    })
    .catch(console.error);
});
rl.on('close', () => {
  void shutdown().catch(console.error);
});
console.log(
  `Local agent · ${upstream.getModelName()} · ${env.cwd}\nTools run with your local account permissions. /exit quits.`,
);
rl.prompt();
