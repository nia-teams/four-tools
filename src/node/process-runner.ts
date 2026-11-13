import { spawn, type ChildProcess } from 'node:child_process';
import { openSync, writeSync, closeSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { join } from 'node:path/posix';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:os';
const signalNumbers: Record<string, number> = constants.signals;
import type { ExecResult, ExecOptions, Platform } from '../core/env.js';
import { signalProcessGroup } from './process-group.js';
export class OutputBuffer {
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  total = 0;
  readonly max: number;
  private readonly headMax: number;
  constructor(max = 50 * 1024) {
    this.max = Math.max(1, Math.trunc(max));
    this.headMax = Math.ceil((this.max * 32) / 50);
  }
  add(chunk: Buffer): void {
    this.total += chunk.length;
    const headTake = Math.min(chunk.length, this.headMax - this.head.length);
    if (headTake)
      this.head = Buffer.concat([this.head, chunk.subarray(0, headTake)]);
    const rest = chunk.subarray(headTake);
    const tailMax = this.max - this.headMax;
    if (rest.length && tailMax)
      this.tail = Buffer.concat([this.tail, rest]).subarray(-tailMax);
  }
  get truncated(): boolean {
    return this.total > this.max;
  }
  get text(): string {
    return (
      this.head.toString('utf8') +
      (this.truncated ? '\n[... output truncated; see spillPath ...]\n' : '') +
      this.tail.toString('utf8')
    );
  }
}
export interface RunningProcess {
  child: ChildProcess;
  output: OutputBuffer;
  logPath: string;
  done: Promise<ExecResult>;
  kill(signal?: NodeJS.Signals): void;
}
export async function startProcess(input: {
  command: string;
  cwd: string;
  shell: string;
  platform: Platform;
  logDir: string;
  logId?: string;
  options?: ExecOptions;
}): Promise<RunningProcess> {
  const options = input.options ?? {};
  options.signal?.throwIfAborted();
  await fs.mkdir(input.logDir, { recursive: true, mode: 0o700 });
  const logPath = join(
    input.logDir,
    `${input.logId ?? `exec-${randomUUID()}`}.log`,
  );
  const fd = openSync(logPath, 'wx', 0o600);
  let child: ChildProcess;
  try {
    child = spawn(input.shell, ['-c', input.command], {
      cwd: input.cwd,
      env: { ...process.env, ...options.env },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    closeSync(fd);
    await fs.unlink(logPath);
    throw error;
  }
  const output = new OutputBuffer(options.maxOutputBytes),
    stdout = new OutputBuffer(options.maxOutputBytes),
    stderr = new OutputBuffer(options.maxOutputBytes);
  let timedOut = false,
    aborted = false,
    exited = false,
    finished = false;
  let exitCode: number | null = null,
    exitSignal: string | null = null;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: NodeJS.Signals = 'SIGKILL') => {
    if (child.pid) signalProcessGroup(child.pid, signal, input.platform);
  };
  let resolve!: (result: ExecResult) => void;
  let reject!: (error: Error) => void;
  const done = new Promise<ExecResult>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const abort = () => {
    aborted = true;
    kill();
  };
  const finish = (error?: Error) => {
    if (finished) return;
    finished = true;
    clearTimeout(drainTimer);
    clearTimeout(timeoutTimer);
    options.signal?.removeEventListener('abort', abort);
    child.stdout?.destroy();
    child.stderr?.destroy();
    closeSync(fd);
    if (error) reject(error);
    else
      resolve({
        output: output.text,
        stdout: stdout.text,
        stderr: stderr.text,
        exitCode,
        signal: exitSignal,
        timedOut,
        aborted,
        truncated: output.truncated,
        ...(output.truncated ? { spillPath: logPath } : {}),
      });
  };
  const armDrain = () => {
    clearTimeout(drainTimer);
    drainTimer = setTimeout(() => finish(), 150);
  };
  const consume = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
    try {
      // Synchronous fd writes apply backpressure before another pipe chunk is accepted.
      for (let at = 0; at < chunk.length;)
        at += writeSync(fd, chunk, at, chunk.length - at);
      output.add(chunk);
      (stream === 'stdout' ? stdout : stderr).add(chunk);
      options.onOutput?.(chunk, stream);
      if (exited) armDrain();
    } catch (error) {
      kill();
      finish(error as Error);
    }
  };
  child.stdout?.on('data', (chunk) => consume(chunk, 'stdout'));
  child.stderr?.on('data', (chunk) => consume(chunk, 'stderr'));
  child.on('error', (error) => finish(error));
  child.on('exit', (code, signal) => {
    exited = true;
    exitCode = signal ? 128 + (signalNumbers[signal] ?? 0) : code;
    exitSignal = signal;
    armDrain();
  });
  child.on('close', () => finish());
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  if (options.timeoutMs !== undefined)
    timeoutTimer = setTimeout(
      () => {
        timedOut = true;
        kill();
      },
      Math.max(0, options.timeoutMs),
    );
  return { child, output, logPath, done, kill };
}

/** Managed groups inherit regular log FDs; descendant output survives shell exit. */
export interface ManagedProcess extends Omit<RunningProcess, 'output'> {
  snapshot(): Promise<OutputBuffer>;
  groupAlive(): boolean;
}
export async function startManagedProcess(input: {
  command: string;
  cwd: string;
  shell: string;
  platform: Platform;
  logDir: string;
  logId: string;
  options?: ExecOptions;
}): Promise<ManagedProcess> {
  await fs.mkdir(input.logDir, { recursive: true, mode: 0o700 });
  const logPath = join(input.logDir, `${input.logId}.log`);
  const fd = openSync(logPath, 'wx', 0o600);
  let child: ChildProcess;
  try {
    child = spawn(input.shell, ['-c', input.command], {
      cwd: input.cwd,
      env: { ...process.env, ...input.options?.env },
      detached: true,
      stdio: ['ignore', fd, fd],
    });
  } catch (error) {
    await fs.unlink(logPath).catch(() => {});
    throw error;
  } finally {
    closeSync(fd);
  }
  const snapshot = async () => {
    const result = new OutputBuffer(input.options?.maxOutputBytes);
    const handle = await fs.open(logPath, 'r');
    try {
      const { size } = await handle.stat();
      const head = Buffer.alloc(
        Math.min(size, Math.ceil((result.max * 32) / 50)),
      );
      const h = await handle.read(head, 0, head.length, 0);
      result.add(head.subarray(0, h.bytesRead));
      const tailSize = Math.min(size - h.bytesRead, result.max - h.bytesRead);
      if (tailSize > 0) {
        const tail = Buffer.alloc(tailSize);
        const t = await handle.read(
          tail,
          0,
          tailSize,
          Math.max(h.bytesRead, size - tailSize),
        );
        result.add(tail.subarray(0, t.bytesRead));
      }
      result.total = size;
      return result;
    } finally {
      await handle.close();
    }
  };
  const groupAlive = () => {
    if (!child.pid) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
      throw error;
    }
  };
  const done = new Promise<ExecResult>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => {
      if (signal) exitCode = 128 + (signalNumbers[signal] ?? 0);
      void snapshot().then(
        (preview) =>
          resolve({
            output: preview.text,
            stdout: preview.text,
            stderr: '',
            exitCode,
            signal,
            timedOut: false,
            aborted: false,
            truncated: preview.truncated,
            ...(preview.truncated ? { spillPath: logPath } : {}),
          }),
        reject,
      );
    });
  });
  const kill = (signal: NodeJS.Signals = 'SIGKILL') => {
    if (child.pid) signalProcessGroup(child.pid, signal, input.platform);
  };
  return { child, logPath, done, kill, snapshot, groupAlive };
}
