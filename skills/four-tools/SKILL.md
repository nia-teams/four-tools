---
name: four-tools
description: Build agents with @nia-teams/four-tools (read, write, edit, shell) on macOS/Linux via createNodeTools, or implement ExecutionEnv for remote sandboxes. Use when code imports @nia-teams/four-tools or @nia-teams/four-tools/node.
---

`@nia-teams/four-tools` provides the four operating-system tools (`read`, `write`, `edit`, `shell`) for general-purpose and coding agents with zero runtime dependencies.
`@nia-teams/four-tools` (root) contains OS-free tool factories (`createFourTools`), `applyUniqueEdit`, `FileMutationQueue`, and the `ExecutionEnv` interface with no `node:fs`, `node:path`, or `node:os` imports.
`@nia-teams/four-tools/node` implements `ExecutionEnv` on macOS and Linux using Node.js POSIX syscalls and process groups.

For a local macOS/Linux agent, call `createNodeTools({ cwd })` from `@nia-teams/four-tools/node`, pass the returned tool array to `AgentRuntime` or `AgentHost` (`@nia-teams/agent-core`), and call `await tools.dispose()` on shutdown.
To handle background terminal exit events, construct the backend with `createNodeEnv({ cwd, onTerminalExit })` and pass it to `createFourTools(env)` (or call `createNodeFourTools({ cwd, onTerminalExit })`). On completion, forward `onTerminalExit` into `host.injectMessage({ sessionId, eventType: 'terminal_exit', content: JSON.stringify(event), ... })` to wake the agent.
To run over SSH, containers, or remote sandboxes, implement `ExecutionEnv` and pass it to `createFourTools(env)`.
`createFourTools` shares one `FileMutationQueue` between `write` and `edit` in the same group; pass a shared `mutationQueue` across groups to serialize writes by `(env.id, realpath)`.
Tools execute with the host process's permissions; `cwd` is only the base for relative paths. Path sandboxing, user approvals, and secret redaction belong in the host `ExecutionEnv`.

`read` uses 1-based line `offset` (default cap: 2,000 lines / 50 KiB; pass `read: { truncate: false }` to delegate output truncation to the runtime).
`terminal_read` uses 0-based line `offset`.
`edit` requires one unique match of `old_string` (exact match first, then Unicode-normalized fallback) and returns `OK: replacement applied`.
`shell` waits 30 seconds by default (`timeout: 0` also uses 30s). When `env.terminals` is enabled, a timed-out command continues running in the background and returns `Terminal ID: <id>`; when `terminals: false` or `allowBackground: false` is set, timeout or abort kills the process group.

Exact signatures: `node_modules/@nia-teams/four-tools/dist/**/*.d.ts`. Reference manual & TypeScript examples: `node_modules/@nia-teams/four-tools/README.md` and `examples/` (`quickstart.ts`, `local-agent.ts`, `web-agent.ts`, run with `npx tsx`).
