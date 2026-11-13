# Four Tools

English | [简体中文](./README_CN.md)

The common way to extend an AI agent is to keep adding specialized tools and MCP servers: every new integration brings another set of schemas until tool definitions consume tens of thousands of tokens, crowding the context window, raising argument error rates, and still leaving the agent stuck as soon as a task falls outside its preset tool list.

Large language models are already good at reading files, writing files, and running commands. Give an agent four operating-system tools—`read`, `write`, `edit`, and `shell` (under 1,000 tokens of schema in total)—and it can handle nearly any task: read documents, edit code, call APIs, run tests, or write and execute a script when no dedicated tool exists. These four tools are not just coding tools; they are the foundational toolset for a general-purpose agent operating on a computer.

In production environments—local workstations, cloud sandboxes, headless containers, or chat-driven services—existing implementations of these four tools run into three limitations:
- **Bundled inside interactive CLI products**: Community implementations (such as Pi's `coding-agent`) package the four tools inside a full terminal CLI application alongside TUI renderers and WASM image libraries rather than as a standalone, zero-dependency SDK.
- **Coupled to specific external shell commands**: Implementations that shell out to `python3`, `setsid`, `stdbuf -oL`, `sed`, or `base64 -w0` fail on macOS (BSD userland) or minimal Alpine containers when those commands or flags are absent, and can lose `0755` executable permissions, overwrite symlinks during atomic writes, or allow parent shells on macOS to run subsequent commands during process-group teardown.
- **No unattended background terminal management**: Interactive CLIs assume a human is watching `tmux`. Agents running in cloud services or chat channels executing 30+ second builds, test suites, or long-running tasks need timed-out commands to move into a background terminal without disconnecting, keep child log descriptors open, and wake the agent via an exit event when finished.

`@nia-teams/four-tools` extracts these four tools into a standalone package with zero runtime dependencies and a two-layer structure:
- **Core layer (`@nia-teams/four-tools`)**: Depends only on the `ExecutionEnv` interface with no `node:fs`, `node:path`, or `node:os` imports. Includes a TypeScript two-stage unique match edit engine (preserving UTF-8 BOM and existing CRLF/LF line endings), a `FileMutationQueue` serialized by environment ID and canonical path, and tool definitions compatible with `@nia-teams/agent-core` and Nia Teams.
- **Native macOS / Linux syscall backend (`@nia-teams/four-tools/node`)**: Uses Node.js POSIX syscalls for line-paginated reads, atomic writes that preserve symlinks and target file modes, cross-kernel process-group signaling (`SIGSTOP` before `SIGKILL` on macOS), and background terminal lifecycle management (`exec` hands off after 30s by default, plus `terminal_create / list / read / signal / destroy`).

```sh
npm install @nia-teams/four-tools
```

AI coding assistants can load the bundled skill: `node_modules/@nia-teams/four-tools/skills/four-tools/SKILL.md` ([`skills/four-tools/SKILL.md`](./skills/four-tools/SKILL.md)).

---

## Quick Start

Requires Node.js 20+ on macOS or Linux. Install the dependencies and run [`examples/quickstart.ts`](./examples/quickstart.ts):

```sh
npm install @nia-teams/agent-core @nia-teams/ai
npm install -D tsx
DEEPSEEK_API_KEY=sk-... npx tsx examples/quickstart.ts
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

## Tool Behavior

- **`read`**: Paginates text by line (1-based `offset`), capped at 2,000 lines and 50 KiB by default. Configure caps via `read: { maxLines, maxBytes }` or pass `read: { truncate: false }` to let the runtime manage output budgets.
- **`write`**: Creates missing parent directories and writes the file, returning `File written: <path> (<n> chars)` (`n` is UTF-16 code units). When targeting a resolvable symlink, preserves the symlink and existing target file mode.
- **`edit`**: Matches one unique exact substring first, falling back to a line-mapped Unicode-normalized match (NFC, curly quotes, narrow no-break spaces). Preserves UTF-8 BOM and untouched CRLF/LF line endings, rejects files over 16 MiB by default, and returns `OK: replacement applied`.
- **`shell`**: Runs a command and returns formatted text containing `$ <command>`, stdout, optional `[stderr]`, and `exit_code: <code>, duration: <ms>ms`.
- **Write serialization**: `createFourTools` shares a `FileMutationQueue` between `write` and `edit` in the same group; pass a shared `mutationQueue` across groups to serialize writes by environment ID and `realpath`.
- **Hooks**: `afterRead`, `afterMutate`, and `afterExec` (on exit code 0) can return `@nia-teams/ai/protocol` guidance; `resolveEnv` supplies per-command environment overrides.

---

## Managed Background Terminals

`createNodeEnv()` enables background terminals by default:

- **Timeout handoff**: Foreground `shell` waits 30 seconds by default (`timeout: 0` also uses 30 seconds). On timeout, the process continues running in the background and returns `Terminal ID: <id>`.
- **Terminal actions**: Manage background processes with `terminal_create`, `terminal_list`, `terminal_read` (0-based `offset`), `terminal_signal` (`SIGINT` / `SIGTERM` / `SIGKILL` map to exit codes `130` / `143` / `137`), and `terminal_destroy`.
- **Exit events and log retention**: Child processes inherit log file descriptors and can continue writing after the top-level shell exits. `onTerminalExit` fires once when the top-level shell exits (suppressed on `destroy`); `env.dispose()` kills managed process groups and removes logs. Full output from truncated foreground commands is written to `spillPath`.
- **Foreground-only mode**: Passing `createNodeTools({ cwd, terminals: false })`, `createFourTools(env, { shell: { allowBackground: false, name: 'bash' } })`, or an `ExecutionEnv` without `env.terminals` exposes a foreground-only schema and kills the process group on timeout or abort.

---

## Local Examples

### 1. Interactive CLI Agent (`examples/local-agent.ts`)

Streams assistant text, reasoning, and tool calls in the terminal, and feeds background terminal exits into `host.injectMessage` to wake follow-up turns:

```sh
OPENAI_API_KEY=sk-... OPENAI_BASE_URL=https://api.deepseek.com/v1 \
  MODEL=deepseek-chat npx tsx examples/local-agent.ts
```

Selects a client from `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY` in that order (`MODEL` overrides the default model). Press `Ctrl+C` once to cancel the active turn; press twice within 1.2s or type `/exit` to shut down and dispose terminals.

### 2. Browser Workbench (`examples/web-agent.ts`)

Starts a local HTTP server (`127.0.0.1:18880` by default; configurable via `HOST`, `PORT`, `WORKSPACE_DIR`, `WEB_AGENT_TOKEN`) with chat streaming, tool cards, workspace file previews, and live terminal status:

```sh
OPENAI_API_KEY=sk-... OPENAI_BASE_URL=https://api.deepseek.com/v1 \
  MODEL=deepseek-chat npx tsx examples/web-agent.ts
```

Open the printed token URL in a browser. SSE reconnect replay is backed by `createSnapshotStream`. The token grants local command execution; place the server behind an authenticated TLS proxy before exposing it beyond loopback.

---

## Custom Execution Environments & Exports

To run over SSH, containers, or remote sandboxes, implement `ExecutionEnv` and pass it to `createFourTools(env)`. Omit `env.terminals` when background process management is not supported.

| Subpath | Exports |
| --- | --- |
| `@nia-teams/four-tools` | `createFourTools`, `createReadTool`, `createWriteTool`, `createEditTool`, `createShellTool`, `applyUniqueEdit`, `FileMutationQueue`, `ExecutionEnv`, and types |
| `@nia-teams/four-tools/node` | `createNodeEnv`, `createNodeTools` (tool array with `.env` and `.dispose()`), `createNodeFourTools`, `PosixNodeExecutionEnv`, `PosixTerminalManager` |

Tools run with the host process's permissions. `cwd` is the base directory for relative paths; path sandboxing, approvals, and secret redaction are enforced by the host `ExecutionEnv`.

---

## Build & Test

```sh
npm ci --registry=https://registry.npmjs.org
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

## License

[MIT](./LICENSE)
