# Four Tools

English | [简体中文](./README_CN.md)

[Pi](https://github.com/badlogic/pi-mono)-like agent tools—`read`, `write`, `edit`, `shell`—for [`@nia-teams/agent-core`](https://github.com/nia-teams/cloud-agent) or any custom agent loop.

Pi ships its tools inside the `pi-coding-agent` CLI and `pi-durable` runtime rather than as a standalone zero-dependency package. `@nia-teams/four-tools` is an independent implementation, with the same interfaces Nia Teams runs in production:

1. **Standalone package, zero runtime dependencies**: No `dependencies` or `peerDependencies` in `package.json` and no CLI / TUI bundle, ready to embed in backend agents.
2. **One toolset across execution environments**: The tool layer depends only on a unified `ExecutionEnv` interface. Use the built-in `/node` backend on local macOS / Linux, or write an adapter for SSH, containers, or remote sandboxes.
3. **No external shell helper commands**: File and process operations use Node.js syscalls instead of shelling out to `python3`, `setsid`, `stdbuf`, or `sed`, behaving consistently on macOS and Linux while preserving symlinks and `0755` file modes.
4. **Unattended long-running tasks**: `shell` waits 30 seconds in the foreground, hands unfinished commands to a background terminal, and wakes the agent via `onTerminalExit` when they finish.

```sh
npm install @nia-teams/four-tools
```

AI coding assistants can load `node_modules/@nia-teams/four-tools/skills/four-tools/SKILL.md` ([`skills/four-tools/SKILL.md`](./skills/four-tools/SKILL.md)).

---

## Quick Start

Node.js >= 20 (macOS or Linux). Save the snippet below as `quickstart.ts` (or run [`examples/quickstart.ts`](./examples/quickstart.ts) from a repo checkout):

```sh
npm install @nia-teams/four-tools @nia-teams/agent-core @nia-teams/ai
npm install -D tsx
DEEPSEEK_API_KEY=sk-... npx tsx quickstart.ts
```

```ts
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
```

---

## Tools

Each tool is a plain `{ name, description, inputSchema, execute }` object:

- **`read`**: Reads text files only, line-paginated (1-based `offset`), defaulting to 2,000 lines and 50 KiB (`read: { maxLines, maxBytes }`, or `read: { truncate: false }` to let the runtime truncate).
- **`write`**: Creates parent directories and writes the file, returning `File written: <path> (<n> chars)`. Preserves resolvable symlinks and existing file modes.
- **`edit`**: Takes `{ path, old_string, new_string }` and replaces one uniquely matched span, preserving UTF-8 BOM and untouched CRLF/LF line endings (16 MiB default cap) and returning `OK: replacement applied`.
- **`shell`**: Runs a command and returns `$ <command>`, stdout, `[stderr]`, and `exit_code: <code>, duration: <ms>ms`. Supports 6 `action` values:
  - `exec` (default): Waits 30 seconds in the foreground, then hands off to a background terminal (`Terminal ID: <id>`).
  - `terminal_create` / `terminal_list` / `terminal_read` (0-based `offset`) / `terminal_signal` (`SIGINT` / `SIGTERM` / `SIGKILL`) / `terminal_destroy`: Manage background processes.
  - Passing `terminals: false`, `allowBackground: false`, or an `ExecutionEnv` without `env.terminals` hides `terminal_*` actions and kills the process group on timeout or abort.

---

## `edit` Tool Design

Pi's `edit` takes a nested `{ path, edits: [{ oldText, newText }] }` array and matches multiple edits against the original file in one call. `@nia-teams/four-tools` uses a simpler three-field schema—`{ path, old_string, new_string }`—replacing one uniquely matched span per call so models avoid malformed nested arguments.

To edit multiple places in the same file, call `edit` multiple times. Writes to the same file run sequentially through a queue, so each call matches against the result of the previous edit without overlapping edit ranges.

When an exact match misses, `edit` retries once after normalizing NFKC forms, curly quotes, dashes, special spaces, and trailing whitespace, replacing only the matched span while leaving the rest of the line untouched.

---

## Subpath Exports

| Subpath | Exports |
| --- | --- |
| `@nia-teams/four-tools` | `createFourTools(env, options?)`, `createReadTool`, `createWriteTool`, `createEditTool`, `createShellTool`, `applyUniqueEdit`, `FileMutationQueue`, `ExecutionEnv` |
| `@nia-teams/four-tools/node` | `createNodeTools(options?)` (tool array with `.env` and `.dispose()`), `createNodeEnv(options?)` (`PosixNodeExecutionEnv`), `PosixNodeExecutionEnv`, `PosixTerminalManager` |

Each `createFourTools` call shares one `FileMutationQueue` between `write` and `edit`; pass a shared `options.mutationQueue` across groups to serialize writes to the same file.

---

## Repository Examples

From a repository checkout, run the interactive examples:

- **CLI agent ([`examples/local-agent.ts`](./examples/local-agent.ts))**:
  ```sh
  DEEPSEEK_API_KEY=sk-... npx tsx examples/local-agent.ts
  ```
- **Web workbench ([`examples/web-agent.ts`](./examples/web-agent.ts), listens on `127.0.0.1:18880` by default)**:
  ```sh
  DEEPSEEK_API_KEY=sk-... npx tsx examples/web-agent.ts
  ```

---

## Security

Tools run with the host process's permissions. `cwd` is only the base directory for relative paths and does not sandbox access; enforce path restrictions, user approvals, and secret redaction in the host `ExecutionEnv`.

---

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

## License

[MIT](./LICENSE)
