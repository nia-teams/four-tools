import { AgentRuntime, InMemoryConversationStore } from '@nia-teams/agent-core';
import { OpenAIClient } from '@nia-teams/ai';
import { createNodeTools } from '@nia-teams/four-tools/node';

if (!process.env.DEEPSEEK_API_KEY) throw new Error('Set DEEPSEEK_API_KEY');
const client = new OpenAIClient({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
});
const tools = createNodeTools({ cwd: process.cwd(), terminals: false });
const store = InMemoryConversationStore.fromUserMessage(
  'Read package.json and summarize this project. Do not modify files.',
);
const runtime = new AgentRuntime({ store, sessionId: 'quickstart' });
try {
  await runtime.run({
    client,
    systemPrompt: 'You are a coding assistant. Inspect files before answering.',
    tools,
    onEvent(event) {
      if (event.type === 'text_delta') process.stdout.write(event.delta);
      if (event.type === 'tool_call_start') console.log(`\n[${event.name}]`, event.input);
    },
  });
  console.log();
} finally {
  await tools.dispose();
  await client.close();
}
