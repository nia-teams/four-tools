# Four Tools

[English](./README.md) | 简体中文

过去给 AI Agent 扩展能力，主流做法是不断往上下文里添加专用工具和 MCP 服务：每接入一个系统就增加一批工具，工具定义往往占用上万 Token，不仅挤占上下文窗口、增加参数出错率，遇到预设工具之外的任务仍然无法处理。

大语言模型本身就擅长读写文件和运行命令。只要给 Agent 提供操作系统的四个基础工具——`read`、`write`、`edit`、`shell`（全部工具定义不到 1,000 Token），它就能覆盖绝大多数任务：读文档、改代码、调接口、跑测试；遇到没有现成工具的场景，编写一段脚本执行即可完成扩展。这四个工具不只是写代码专用的工具，而是通用 Agent 在计算机上完成各类任务的基础工具集。

但在实际生产环境（本地开发机、云端沙箱、无界面容器、聊天服务后台）中，现有的四工具实现存在三处限制：
- **与交互式终端 CLI 捆绑**：社区现有实现（如 Pi 的 `coding-agent`）通常把这四个工具与终端 TUI 界面、WASM 图像处理等依赖打包在同一个 CLI 应用里，没有拆分为零依赖的独立 SDK。
- **依赖特定系统的外部命令**：底层拼接 `python3`、`setsid`、`stdbuf -oL`、`sed`、`base64 -w0` 的实现，换到 macOS（BSD 工具链）或精简 Alpine 容器时会因缺少命令或参数报错；同时还会出现原子写入丢失 `0755` 可执行权限、覆盖软链接、macOS 终止进程组时父 shell 继续执行后续命令等问题。
- **缺少无人值守的后台终端管理**：交互式 CLI 假定有人在终端前查看 `tmux`；运行在云端或聊天通道里的 Agent 执行超过 30 秒的构建、测试或长耗时任务时，需要超时后不断连转入后台终端、保留子进程日志句柄持续写入，并在退出时通过事件唤醒 Agent 汇报。

`@nia-teams/four-tools` 将这四个工具拆分为零运行时依赖的独立包，采用两层结构解决上述问题：
- **核心层（`@nia-teams/four-tools`）**：仅依赖 `ExecutionEnv` 接口，不引入 `node:fs`、`node:path` 或 `node:os`。内置 TypeScript 两级唯一文本匹配（保留 UTF-8 BOM 与原有 CRLF/LF 换行符）、按环境与真实路径串行化的 `FileMutationQueue`，以及兼容 `@nia-teams/agent-core` 与 Nia Teams 的工具定义。
- **macOS / Linux 原生系统调用后端（`@nia-teams/four-tools/node`）**：基于 Node.js POSIX 系统调用实现按行分页读取、保留软链接与目标权限位的写入、跨内核进程组信号回收（macOS 先发 `SIGSTOP` 再发 `SIGKILL`），以及后台终端生命周期管理（`exec` 默认 30 秒转后台，支持 `terminal_create / list / read / signal / destroy`）。

```sh
npm install @nia-teams/four-tools
```

AI 编程助手可加载随包分发的 `SKILL.md`：`node_modules/@nia-teams/four-tools/skills/four-tools/SKILL.md`（[`skills/four-tools/SKILL.md`](./skills/four-tools/SKILL.md)）。

---

## 快速开始

运行环境为 Node.js 20+（macOS 或 Linux）。安装依赖并运行 [`examples/quickstart.ts`](./examples/quickstart.ts)：

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

## 工具行为

- **`read`**：按行分页读取文本（`offset` 从 1 开始），默认上限 2,000 行、50 KiB。可通过 `read: { maxLines, maxBytes }` 调整，或传 `read: { truncate: false }` 交由上层运行时裁剪。
- **`write`**：创建缺失的父目录并写入文件，返回 `File written: <path> (<n> chars)`（`n` 为 UTF-16 字符数）。目标为可解析软链接时，保留软链接本身及目标文件原有权限位。
- **`edit`**：先匹配唯一原文子串，未命中时尝试 Unicode 规范化（NFC、弯引号与窄空格）匹配。保留 UTF-8 BOM 与未修改行的 CRLF/LF，默认拒绝超过 16 MiB 的文件，成功返回 `OK: replacement applied`。
- **`shell`**：执行命令并返回包含 `$ <command>`、标准输出、`[stderr]` 与 `exit_code: <code>, duration: <ms>ms` 的文本结果。
- **并发写锁**：`createFourTools` 为同组 `write` / `edit` 共享一个 `FileMutationQueue`；多组实例可传入同一个 `mutationQueue`，按环境 ID 与真实文件路径（`realpath`）串行执行修改。
- **钩子**：`afterRead`、`afterMutate` 与 `afterExec`（退出码为 0 时）可返回 `@nia-teams/ai/protocol` 格式的上下文提示；`resolveEnv` 为单次命令提供环境变量覆盖。

---

## 后台终端管理

`createNodeEnv()` 默认开启后台终端：

- **超时转后台**：前台 `shell` 默认等待 30 秒（`timeout: 0` 同为 30 秒）。超时后命令不中断，转为后台终端并返回 `Terminal ID: <id>`。
- **终端操作**：通过 `terminal_create`、`terminal_list`、`terminal_read`（`offset` 从 0 开始）、`terminal_signal`（`SIGINT` / `SIGTERM` / `SIGKILL` 对应退出码 `130` / `143` / `137`）和 `terminal_destroy` 管理后台进程。
- **退出通知与日志保留**：子进程继承日志文件描述符，顶层 shell 退出后仍可继续写入。顶层 shell 退出时触发一次 `onTerminalExit`（主动 `destroy` 不触发）；调用 `env.dispose()` 终止所有受管进程组并清理日志。前台命令超出大小上限的完整输出保存在 `spillPath`。
- **仅前台模式**：传入 `createNodeTools({ cwd, terminals: false })`、`createFourTools(env, { shell: { allowBackground: false, name: 'bash' } })` 或省略 `env.terminals` 时，工具 Schema 隐藏后台终端操作，超时或取消时终止命令进程组。

---

## 本地运行示例

### 1. 命令行交互（`examples/local-agent.ts`）

流式输出回复、推理过程与工具调用，后台终端退出时通过 `host.injectMessage` 唤醒下一轮汇报：

```sh
OPENAI_API_KEY=sk-... OPENAI_BASE_URL=https://api.deepseek.com/v1 \
  MODEL=deepseek-chat npx tsx examples/local-agent.ts
```

按 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY` 顺序选择客户端，`MODEL` 覆盖默认模型。按一次 `Ctrl+C` 取消当前轮次，1.2 秒内连按两次或输入 `/exit` 退出并清理后台终端。

### 2. 浏览器工作台（`examples/web-agent.ts`）

启动本地 HTTP 服务（默认 `127.0.0.1:18880`，支持 `HOST`、`PORT`、`WORKSPACE_DIR`、`WEB_AGENT_TOKEN`），提供对话流、工具卡片、工作区文件预览与后台终端列表：

```sh
OPENAI_API_KEY=sk-... OPENAI_BASE_URL=https://api.deepseek.com/v1 \
  MODEL=deepseek-chat npx tsx examples/web-agent.ts
```

在浏览器打开终端打印的带 Token 链接即可交互；SSE 流通过 `createSnapshotStream` 支持断线重连。该 Token 具备本地命令执行权限，监听非回环地址时请通过受控代理访问。

---

## 自定义执行环境与子路径导出

对接 SSH、容器或远程沙箱时，实现 `ExecutionEnv` 接口并传入 `createFourTools(env)`；无后台进程管理能力时省略 `env.terminals`。

| 子路径 | 导出内容 |
| --- | --- |
| `@nia-teams/four-tools` | `createFourTools`、`createReadTool`、`createWriteTool`、`createEditTool`、`createShellTool`、`applyUniqueEdit`、`FileMutationQueue`、`ExecutionEnv` 与类型定义 |
| `@nia-teams/four-tools/node` | `createNodeEnv`、`createNodeTools`（返回带 `.env` 与 `.dispose()` 的工具数组）、`createNodeFourTools`、`PosixNodeExecutionEnv`、`PosixTerminalManager` |

工具使用宿主进程的文件系统与执行权限；`cwd` 仅作为相对路径基准，路径隔离、审批门禁与密钥脱敏由宿主 `ExecutionEnv` 负责。

---

## 构建与测试

```sh
npm ci --registry=https://registry.npmjs.org
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

## 开源协议

[MIT](./LICENSE)
