# Contributing to Four Tools

Use Node.js 20 or newer on macOS or Linux. Install from the public registry:

```sh
npm ci --registry=https://registry.npmjs.org
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

- `src/core/` and `src/index.ts` own the OS-free tool factories, `applyUniqueEdit`, `FileMutationQueue`, and `ExecutionEnv` contract. They must not import `node:fs`, `node:path`, `node:os`, or `node:child_process`, or read `process.*` (`tests/boundary.test.ts` enforces this). Keep `dependencies` empty in `package.json`.
- `src/node/` implements the macOS/Linux `ExecutionEnv` and `TerminalManager` using Node.js `fs` file handles and process-group signals (`SIGSTOP` before `SIGKILL` on macOS), without shelling out to `python3`, `setsid`, `stdbuf`, or `sed`.
- `FileMutationQueue` serializes `write` and `edit` by `${env.id}\0${canonicalPath}` and awaits in-flight writes before releasing the lock. Writes preserve UTF-8 BOM, untouched CRLF/LF line endings, symlinks, and existing file modes (such as `0755`).
- Managed background terminals inherit regular log file descriptors so child output continues after the top-level shell exits. `onTerminalExit` fires once on top-level shell exit and is suppressed for foreground completion and `terminal_destroy`.
- Tool schemas and result strings in `src/core/contracts.ts` are pinned by `tests/source-contract.test.ts` (`$ <cmd>`, `---`, `exit_code: <code>, duration: <ms>ms`, `File written: <path> (<n> chars)`, `OK: replacement applied`). `FourTool` must remain assignable to `Tool` from `@nia-teams/agent-core`.

README TypeScript snippets run via `npx tsx`. Keep `README.md` and `README_CN.md` Quick Start blocks byte-identical to `examples/quickstart.ts` (`tests/docs.test.ts`), and update `README.md`, `README_CN.md`, and `skills/four-tools/SKILL.md` together whenever public APIs or defaults change.
