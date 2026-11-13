import type { ExecutionEnv, TerminalStatus } from '../env.js';
import type { FourTool, ToolHooks } from '../types.js';
import { toolContracts } from '../contracts.js';
import { safe, schema } from './shared.js';
export interface ShellToolOptions {
  name?: string;
  allowBackground?: boolean;
  maxOutputBytes?: number;
  hooks?: ToolHooks;
}
const signals = ['SIGINT', 'SIGTERM', 'SIGKILL'] as const;
const wireStatus = (status: TerminalStatus | 'stopped') =>
  status === 'running' || status === 'error' ? status : 'stopped';
export function signalExitCode(
  exitCode: number | null,
  signal: string | null,
): number {
  return signal === 'SIGINT'
    ? 130
    : signal === 'SIGTERM'
      ? 143
      : signal === 'SIGKILL'
        ? 137
        : (exitCode ?? 1);
}
export function createShellTool(
  env: ExecutionEnv,
  options: ShellToolOptions = {},
): FourTool {
  const background =
    (options.allowBackground ?? Boolean(env.terminals)) &&
    Boolean(env.terminals);
  const full = structuredClone(toolContracts.shell);
  const common = {
    command: full.inputSchema.properties.command,
    cwd: full.inputSchema.properties.cwd,
    timeout: full.inputSchema.properties.timeout,
  };
  return safe({
    name: options.name ?? 'shell',
    description: background
      ? full.description
      : 'Execute shell commands in the workspace. Run a one-shot command and wait for output. Timeout or cancellation terminates the process group.',
    concurrency: 'parallel',
    inputSchema: background ? full.inputSchema : schema(common, ['command']),
    async execute(input, ctx = {}) {
      const action = input.action || 'exec';
      if (!background && action !== 'exec')
        return 'Error: background terminals are unavailable';
      const backend = background ? env.terminals : undefined;
      if (action === 'terminal_list') {
        const terminals = await backend!.list();
        if (!terminals.length) return 'No active terminals';
        return terminals
          .map(
            (t) =>
              `${t.status === 'running' ? '[running]' : '[stopped]'} ${t.id} - ${t.name || '(unnamed)'}${t.command ? ` (${t.command})` : ''} [${t.linesBuffered || 0} lines]`,
          )
          .join('\n');
      }
      if (action === 'terminal_read') {
        if (!input.id) return 'Error: id is required for terminal_read';
        const data = await backend!.read({
          id: String(input.id),
          offset: input.offset as number | undefined,
          limit: input.limit as number | undefined,
        });
        const lines =
          data.lines ??
          (data.content.length
            ? data.content.replace(/\n$/, '').split('\n')
            : []);
        let out = lines.length ? lines.join('\n') + '\n' : '';
        out += `---\nstatus: ${wireStatus(data.status)}, total_lines: ${data.totalLines}`;
        const next =
          data.nextOffset ??
          (data.endLine < data.totalLines
            ? Math.max(0, data.endLine)
            : undefined);
        if (next !== undefined) out += `, next_offset: ${next}`;
        return out;
      }
      if (action === 'terminal_signal') {
        if (!input.id || !input.signal)
          return 'Error: id and signal are required for terminal_signal';
        if (!signals.includes(input.signal as (typeof signals)[number]))
          return 'Error: invalid signal';
        await backend!.signal({
          id: String(input.id),
          signal: input.signal as (typeof signals)[number],
        });
        return `Sent ${input.signal}`;
      }
      if (action === 'terminal_destroy') {
        if (!input.id) return 'Error: id is required for terminal_destroy';
        await backend!.destroy({ id: String(input.id) });
        return 'Terminal destroyed';
      }
      if (action !== 'exec' && action !== 'terminal_create')
        return `Unknown action: ${action}`;
      if (!input.command) return `Error: command is required for ${action}`;
      if (typeof input.command !== 'string')
        return 'Error: command must be a string';
      const command = input.command;
      if (
        action === 'terminal_create' &&
        (ctx.subagentId || ctx.metadata?.subagentId)
      )
        return 'Subagents cannot create background terminals. Run foreground shell exec work within this turn or report the blocker to the parent agent.';
      const cwd =
        typeof input.cwd === 'string'
          ? (await env.resolvePath(input.cwd, { mustExist: true })).resolvedPath
          : undefined;
      const environment = await options.hooks?.resolveEnv?.(ctx);
      if (action === 'terminal_create') {
        const info = await backend!.create({
          command,
          cwd,
          env: environment,
          name: input.name as string | undefined,
          notifyOnExit: input.notifyOnExit !== false,
        });
        return `Terminal created\n  ID: ${info.id}\n  Name: ${info.name || '(unnamed)'}\n  Status: ${wireStatus(info.status)}${info.command ? `\n  Command: ${info.command}` : ''}`;
      }
      if (
        input.timeout !== undefined &&
        (typeof input.timeout !== 'number' ||
          !Number.isFinite(input.timeout) ||
          input.timeout < 0)
      )
        return 'Error: timeout must be a finite, non-negative number of seconds';
      // The production contract treats zero as the default foreground wait.
      const seconds = (input.timeout as number | undefined) || 30;
      const timeoutMs = Math.min(Math.trunc(seconds * 1000), 2 ** 31 - 1);
      const started = Date.now();
      const result = backend
        ? await backend.execWithHandoff({
            command,
            cwd,
            env: environment,
            handoffAfterMs: timeoutMs,
            signal: ctx.signal,
            maxOutputBytes: options.maxOutputBytes,
          })
        : await env.exec(command, {
            cwd,
            env: environment,
            timeoutMs,
            signal: ctx.signal,
            maxOutputBytes: options.maxOutputBytes,
          });
      if ('completed' in result && !result.completed) {
        const id = result.terminal.id;
        const reason =
          (result.handoffReason ??
            (ctx.signal?.aborted ? 'abort' : 'timeout')) === 'abort'
            ? 'Foreground turn ended'
            : `Command timed out after ${seconds}s`;
        let out = `${reason} — process still running in background.\nTerminal ID: ${id}\n`;
        if (result.partialOutput)
          out += `\nPartial output so far:\n${result.partialOutput.length > 2000 ? result.partialOutput.substring(0, 2000) + '\n... (truncated)' : result.partialOutput}\n`;
        out += `\nUse terminal_read with id="${id}" to check progress.`;
        out += `\nUse terminal_signal with id="${id}" to send signals (SIGINT/SIGTERM/SIGKILL).`;
        out += `\nUse terminal_destroy with id="${id}" to clean up when done.`;
        return out;
      }
      let out = `$ ${command}${input.cwd ? ` (cwd: ${input.cwd})` : ''}\n---\n`;
      const stdout = result.stdout ?? result.output,
        stderr = result.stderr;
      if (stdout) out += stdout + '\n';
      if (stderr) out += `[stderr] ${stderr}\n`;
      if (result.spillPath) out += `[Full output: ${result.spillPath}]\n`;
      const exitCode = signalExitCode(result.exitCode, result.signal);
      out += `---\nexit_code: ${exitCode}, duration: ${result.durationMs ?? Date.now() - started}ms`;
      const guidance =
        exitCode === 0
          ? await options.hooks?.afterExec?.({
              command,
              cwd,
              exitCode,
              context: ctx,
            })
          : undefined;
      return guidance ? { content: out, guidance } : out;
    },
  });
}
