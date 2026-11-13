import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type {
  ManagedTerminalBackend,
  TerminalInfo,
  TerminalExitEvent,
  Platform,
  ExecResult,
} from '../core/env.js';
import { startManagedProcess, type ManagedProcess } from './process-runner.js';
import { readRange } from './read-range.js';
export interface TerminalManagerOptions {
  cwd: string;
  platform: Platform;
  terminalDir: string;
  shell: () => Promise<string>;
  onExit?: (event: TerminalExitEvent) => void | Promise<void>;
  onError?: (error: unknown) => void;
}
interface Entry {
  info: TerminalInfo;
  running: ManagedProcess;
  done: Promise<ExecResult>;
  notify: boolean;
  notified: boolean;
  destroyed: boolean;
  completionSignal?: 'SIGINT' | 'SIGTERM' | 'SIGKILL';
}
export class PosixTerminalManager implements ManagedTerminalBackend {
  private readonly entries = new Map<string, Entry>();
  private closed = false;
  constructor(private readonly options: TerminalManagerOptions) {}
  private async start(
    input: {
      command: string;
      cwd?: string;
      name?: string;
      env?: Record<string, string>;
      maxOutputBytes?: number;
    },
    notify: boolean,
    prefix = 'term',
  ): Promise<Entry> {
    if (this.closed) throw new Error('Terminal manager is disposed');
    const id = `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const running = await startManagedProcess({
      command: input.command,
      cwd: input.cwd ?? this.options.cwd,
      shell: await this.options.shell(),
      platform: this.options.platform,
      logDir: this.options.terminalDir,
      logId: id,
      options: { env: input.env, maxOutputBytes: input.maxOutputBytes },
    });
    const info: TerminalInfo = {
      id,
      name: input.name ?? '',
      command: input.command,
      cwd: input.cwd ?? this.options.cwd,
      status: 'running',
      exitCode: null,
      signal: null,
      startedAt: Date.now(),
    };
    const entry: Entry = {
      info,
      running,
      done: running.done,
      notify,
      notified: false,
      destroyed: false,
    };
    entry.done = running.done.then(
      async (result) => {
        if (entry.completionSignal) {
          result.exitCode = { SIGINT: 130, SIGTERM: 143, SIGKILL: 137 }[
            entry.completionSignal
          ];
          result.signal = entry.completionSignal;
        }
        Object.assign(info, {
          status: result.signal ? 'signaled' : 'exited',
          exitCode: result.exitCode,
          signal: result.signal,
          endedAt: Date.now(),
        });
        await this.notify(entry);
        return result;
      },
      (error) => {
        Object.assign(info, { status: 'error', endedAt: Date.now() });
        void this.notify(entry).catch((error) => this.options.onError?.(error));
        throw error;
      },
    );
    // Background spawn errors are observed even if no foreground caller awaits done.
    void entry.done.catch((error) => this.options.onError?.(error));
    this.entries.set(id, entry);
    if (this.closed) {
      await this.destroy({ id });
      throw new Error('Terminal manager is disposed');
    }
    return entry;
  }
  private async notify(entry: Entry): Promise<void> {
    if (
      !entry.notify ||
      entry.notified ||
      entry.destroyed ||
      entry.info.status === 'running'
    )
      return;
    try {
      const preview = await entry.running.snapshot();
      if (entry.destroyed || entry.notified) return;
      entry.notified = true;
      const info = entry.info;
      const event: TerminalExitEvent = {
        ...info,
        status: info.status as TerminalExitEvent['status'],
        durationMs: (info.endedAt ?? Date.now()) - info.startedAt,
        outputPreview: preview.text,
        logPath: entry.running.logPath,
      };
      void Promise.resolve(this.options.onExit?.(event)).catch((error) =>
        this.options.onError?.(error),
      );
    } catch (error) {
      if (!entry.destroyed) this.options.onError?.(error);
    }
  }

  private get(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown terminal: ${id}`);
    return entry;
  }
  async execWithHandoff(
    input: Parameters<ManagedTerminalBackend['execWithHandoff']>[0],
  ): ReturnType<ManagedTerminalBackend['execWithHandoff']> {
    const entry = await this.start(input, false, 'exec');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort!: () => void;
    const handoff = new Promise<'handoff' | 'abort'>((resolve) => {
      timer = setTimeout(
        () => resolve('handoff'),
        Math.max(0, input.handoffAfterMs),
      );
      abort = () => resolve('abort');
      input.signal?.addEventListener('abort', abort, { once: true });
      if (input.signal?.aborted) abort();
    });
    try {
      const winner = await Promise.race([entry.done, handoff]);
      if (typeof winner !== 'string' && !entry.running.groupAlive()) {
        if (!winner.truncated) await fs.unlink(entry.running.logPath);
        this.entries.delete(entry.info.id);
        return {
          completed: true,
          output: winner.output,
          stdout: winner.stdout,
          stderr: winner.stderr,
          exitCode: winner.exitCode,
          signal: winner.signal,
          truncated: winner.truncated,
          spillPath: winner.spillPath,
        };
      }
      if (winner === 'abort' && input.onAbort === 'kill') {
        entry.running.kill();
        const result = await entry.done;
        if (!result.truncated) await fs.unlink(entry.running.logPath);
        this.entries.delete(entry.info.id);
        return {
          completed: true,
          output: result.output,
          exitCode: result.exitCode,
          signal: result.signal,
          truncated: result.truncated,
          spillPath: result.spillPath,
        };
      }
      entry.notify = true;
      await this.notify(entry);
      return {
        completed: false,
        terminal: { ...entry.info },
        partialOutput: (await entry.running.snapshot()).text,
        handoffReason: winner === 'abort' ? 'abort' : 'timeout',
      };
    } catch (error) {
      await fs.unlink(entry.running.logPath).catch(() => {});
      this.entries.delete(entry.info.id);
      throw error;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
    }
  }
  async create(
    input: Parameters<ManagedTerminalBackend['create']>[0],
  ): Promise<TerminalInfo> {
    return { ...(await this.start(input, input.notifyOnExit !== false)).info };
  }
  async list(): Promise<TerminalInfo[]> {
    return [...this.entries.values()].map((entry) => ({ ...entry.info }));
  }
  async read(input: Parameters<ManagedTerminalBackend['read']>[0]) {
    const entry = this.get(input.id);
    const offset = input.offset ?? 0,
      limit = input.limit;
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error(
        'Terminal read offset must be a non-negative safe integer',
      );
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))
      throw new Error(
        'Terminal read limit must be a non-negative safe integer',
      );
    const range = await readRange(entry.running.logPath, {
      offsetLine: offset + 1,
      limitLines: limit === 0 ? 1 : (limit ?? Number.MAX_SAFE_INTEGER),
    });
    const endLine = limit === 0 ? offset : range.endLine;
    return {
      content: limit === 0 ? '' : range.content,
      startLine: range.startLine,
      endLine,
      totalLines: range.totalLines,
      ...(endLine < range.totalLines ? { nextOffset: endLine } : {}),
      status: entry.info.status,
      exitCode: entry.info.exitCode,
    };
  }

  async signal(
    input: Parameters<ManagedTerminalBackend['signal']>[0],
  ): Promise<TerminalInfo> {
    const entry = this.get(input.id);
    if (!['SIGINT', 'SIGTERM', 'SIGKILL'].includes(input.signal))
      throw new Error('Invalid signal');
    if (entry.info.status !== 'running')
      throw new Error('Terminal is not running');
    const previous = entry.completionSignal;
    entry.completionSignal = input.signal;
    try {
      entry.running.kill(input.signal);
    } catch (error) {
      entry.completionSignal = previous;
      throw error;
    }
    return { ...entry.info };
  }
  async destroy(input: { id: string }): Promise<void> {
    const entry = this.get(input.id);
    entry.destroyed = true;
    // Kill the group even if its shell exited while descendants were still running.
    entry.running.kill();
    await entry.done.catch(() => {});
    await fs.unlink(entry.running.logPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
    this.entries.delete(input.id);
  }
  async closeAll(): Promise<void> {
    await this.dispose();
  }
  async dispose(): Promise<void> {
    this.closed = true;
    await Promise.all(
      [...this.entries.keys()].map((id) => this.destroy({ id })),
    );
  }
}
