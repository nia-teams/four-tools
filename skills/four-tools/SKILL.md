---
name: four-tools
description: Integrate @nia-teams/four-tools (read, write, edit, shell) into an agent on macOS/Linux or implement a custom ExecutionEnv for SSH, containers, or remote sandboxes. Use when code imports @nia-teams/four-tools or when adding file and shell tools to an agent built on @nia-teams/agent-core or a custom loop.
---

`@nia-teams/four-tools` provides standalone `read`, `write`, `edit`, and `shell` tools with zero runtime dependencies. The returned `FourTool[]` array (`{ name, description, inputSchema, execute }`) plugs directly into `AgentRuntime` / `AgentHost` (`@nia-teams/agent-core`) or any custom agent loop.

## Local macOS / Linux (`@nia-teams/four-tools/node`)

- **Without background terminals**: Call `const tools = createNodeTools({ cwd, terminals: false })`, pass `tools` to `AgentRuntime` or `AgentHost`, and call `await tools.dispose()` on shutdown.
- **With background terminals and wake-up**: Construct the environment with `const env = createNodeEnv({ cwd, onTerminalExit })` and pass `createFourTools(env)` to `AgentHost`. When a command exceeds the 30-second foreground wait, `shell` hands it to a background terminal and fires `onTerminalExit(event)` when the top-level shell exits; forward that event into `host.injectMessage` to wake the session. See `node_modules/@nia-teams/four-tools/examples/local-agent.ts` and `examples/web-agent.ts` for complete wiring.

## Custom Execution Environment (`@nia-teams/four-tools`)

To run tools over SSH, containers, or remote sandboxes, implement `ExecutionEnv` (`id`, `platform`, `cwd`, `resolvePath`, `stat`, `readRange`, `readText`, `writeText`, `exec`, and optional `terminals: ManagedTerminalBackend`) and call `createFourTools(env, options)`. Omit `env.terminals` when the remote transport only supports foreground command execution.

Each `createFourTools` call shares a `FileMutationQueue` between `write` and `edit`; pass a shared `options.mutationQueue` across multiple tool groups to serialize concurrent writes by `(env.id, realpath)`. Pass `read: { truncate: false }` when the host runtime manages tool-output truncation.

## Security & Reference

Tools execute with the host process's permissions; `cwd` only resolves relative paths. Enforce path restrictions, user approvals, and output secret redaction inside your `ExecutionEnv` implementation—gate operations before executing inside `resolvePath`, `writeText`, and `exec` (and `terminals` methods when enabled), rather than in post-execution hooks. To override or clear inherited environment variables per shell call, pass `options.hooks.resolveEnv`.

Type definitions: `node_modules/@nia-teams/four-tools/dist/core/env.d.ts`, `dist/core/types.d.ts`, and `dist/node/index.d.ts`. Runnable examples: `node_modules/@nia-teams/four-tools/examples/` (`quickstart.ts`, `local-agent.ts`, `web-agent.ts`, run with `npx tsx`).
