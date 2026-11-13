# Four Tools

[English](./README.md) | 简体中文

一套类似 [Pi](https://github.com/badlogic/pi-mono) 的 Agent 工具：`read`、`write`、`edit`、`shell`。适配 [`@nia-teams/agent-core`](https://github.com/nia-teams/cloud-agent)，也能接入自己写的 Agent 循环。

Pi 的工具随 `pi-coding-agent` CLI 和 `pi-durable` 运行时一起发布，没有拆成独立的零依赖包。`@nia-teams/four-tools` 是独立实现，接口与 Nia Teams 线上使用的一致：

1. **独立包，零运行时依赖**：`package.json` 无 `dependencies` 与 `peerDependencies`，不带 CLI / TUI，可直接嵌入服务端 Agent。
2. **同一套工具，适配多种执行环境**：工具层只依赖统一的 `ExecutionEnv` 接口。本地 macOS / Linux 使用内置的 `/node` 实现；SSH、容器、远程沙箱各写一个适配器即可。
3. **不依赖系统命令**：文件和进程操作全部通过 Node.js 系统调用完成，不调用 `python3`、`setsid`、`stdbuf`、`sed`，在 macOS 和 Linux 上行为一致（写入保留软链接与 `0755` 权限位）。
4. **长任务无人值守**：`shell` 在前台等待 30 秒，超时未结束则转为后台终端继续运行，退出时通过 `onTerminalExit` 唤醒 Agent。

```sh
npm install @nia-teams/four-tools
```

AI 编程助手可加载 `node_modules/@nia-teams/four-tools/skills/four-tools/SKILL.md`（[`skills/four-tools/SKILL.md`](./skills/four-tools/SKILL.md)）。

---

## 快速开始

Node.js >= 20（macOS 或 Linux）。将下方代码保存为 `quickstart.ts`（或直接运行仓库内的 [`examples/quickstart.ts`](./examples/quickstart.ts)）：

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

## 四个工具

每个工具都是普通 `{ name, description, inputSchema, execute }` 对象：

- **`read`**：只读文本文件，按行分页返回（`offset` 从 1 开始），默认上限 2,000 行、50 KiB。可通过 `read: { maxLines, maxBytes }` 修改上限，或传 `read: { truncate: false }` 交由上层运行时裁剪。
- **`write`**：创建父目录并写入文件，返回 `File written: <path> (<n> chars)`。目标为可解析软链接时，保留软链接与目标文件权限位。
- **`edit`**：接收 `{ path, old_string, new_string }`，替换唯一匹配的一处文本，保留 UTF-8 BOM 与其余行的 CRLF/LF（默认上限 16 MiB），返回 `OK: replacement applied`。
- **`shell`**：执行命令并返回 `$ <command>`、标准输出、`[stderr]` 与 `exit_code: <code>, duration: <ms>ms`。通过 `action` 参数支持 6 种操作：
  - `exec`（默认）：前台等待 30 秒，超时后转入后台终端并返回 `Terminal ID: <id>`。
  - `terminal_create` / `terminal_list` / `terminal_read`（`offset` 从 0 开始）/ `terminal_signal`（`SIGINT` / `SIGTERM` / `SIGKILL`）/ `terminal_destroy`：管理后台进程。
  - 传入 `terminals: false`、`allowBackground: false` 或省略 `env.terminals` 时隐藏 `terminal_*` 操作，超时或取消时终止进程组。

---

## `edit` 工具的设计

Pi 的 `edit` 接收嵌套数组 `{ path, edits: [{ oldText, newText }] }`，单次调用针对原文件同时匹配多处。本库的 `edit` 接收 `{ path, old_string, new_string }` 三个顶层字符串，每次调用替换一处唯一匹配的文本，结构更简单，不同模型都不易传错参数。

同一文件需要改多处时，多次调用 `edit` 即可。对同一文件的写入按队列顺序依次执行，每次都基于上一次修改后的内容匹配，不存在多处修改区间重叠的问题。

字面匹配未命中时，会先按 NFKC 规范化，并忽略弯引号、破折号、特殊空格与行尾空白的差异，再匹配一次；命中后只替换匹配到的那一段，同一行的其他内容保持原样。

---

## 子路径导出

| 子路径 | 导出内容 |
| --- | --- |
| `@nia-teams/four-tools` | `createFourTools(env, options?)`、`createReadTool`、`createWriteTool`、`createEditTool`、`createShellTool`、`applyUniqueEdit`、`FileMutationQueue`、`ExecutionEnv` |
| `@nia-teams/four-tools/node` | `createNodeTools(options?)`（返回带 `.env` 与 `.dispose()` 的工具数组）、`createNodeEnv(options?)`（创建 `PosixNodeExecutionEnv`）、`PosixNodeExecutionEnv`、`PosixTerminalManager` |

同组 `write` / `edit` 默认共享一个 `FileMutationQueue`；多组工具实例可通过 `options.mutationQueue` 共享同一队列，串行化对同一文件的写入。

---

## 仓库示例

克隆本仓库后可直接运行完整交互示例：

- **命令行交互（[`examples/local-agent.ts`](./examples/local-agent.ts)）**：
  ```sh
  DEEPSEEK_API_KEY=sk-... npx tsx examples/local-agent.ts
  ```
- **Web 工作台（[`examples/web-agent.ts`](./examples/web-agent.ts)，默认监听 `127.0.0.1:18880`）**：
  ```sh
  DEEPSEEK_API_KEY=sk-... npx tsx examples/web-agent.ts
  ```

---

## 安全边界

工具继承宿主进程的文件系统与命令执行权限。`cwd` 仅作为相对路径解析基准，不提供沙箱隔离；不可信输入的路径限制、人工审批与密钥脱敏需在宿主 `ExecutionEnv` 中实现。

---

## 本地开发

```sh
npm ci
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

## 开源协议

[MIT](./LICENSE)
