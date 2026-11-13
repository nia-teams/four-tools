import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path/posix';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import type {
  ExecutionEnv,
  Platform,
  FileStat,
  ExecOptions,
  ExecResult,
  TerminalExitEvent,
} from '../core/env.js';
import { readRange } from './read-range.js';
import { startProcess } from './process-runner.js';
import { PosixTerminalManager } from './terminal-manager.js';
export interface NodeEnvOptions {
  id?: string;
  cwd?: string;
  homeDir?: string;
  platform?: string;
  shellPath?: string;
  spillDir?: string;
  terminalDir?: string;
  terminals?: boolean;
  onTerminalExit?: (event: TerminalExitEvent) => void | Promise<void>;
  onTerminalError?: (error: unknown) => void;
}
function missing(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR'].includes(
    (error as NodeJS.ErrnoException).code ?? '',
  );
}
async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}
async function canonical(file: string): Promise<string> {
  try {
    return await fs.realpath(file);
  } catch (error) {
    if (!missing(error)) throw error;
    // A dangling symlink still identifies its future target, not the symlink itself.
    try {
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink())
        return canonical(
          path.resolve(path.dirname(file), await fs.readlink(file)),
        );
    } catch (e) {
      if (!missing(e)) throw e;
    }
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(await canonical(parent), path.basename(file));
  }
}
const variantKey = (value: string) =>
  value
    .normalize('NFC')
    .replace(/\u202F/g, ' ')
    .replace(/\u2019/g, "'");
export class PosixNodeExecutionEnv implements ExecutionEnv {
  readonly id: string;
  readonly platform: Platform;
  readonly cwd: string;
  readonly homeDir: string;
  readonly spillDir: string;
  readonly terminals?: PosixTerminalManager;
  private readonly shellPath?: string;
  constructor(options: NodeEnvOptions = {}) {
    const platform = options.platform ?? process.platform;
    if (platform !== 'linux' && platform !== 'darwin')
      throw new Error(
        `Unsupported platform: ${platform}; expected linux or darwin`,
      );
    this.platform = platform;
    this.id = options.id ?? randomUUID();
    this.cwd = path.resolve(options.cwd ?? process.cwd());
    this.homeDir = options.homeDir ?? os.homedir();
    this.spillDir =
      options.spillDir ?? path.join(os.tmpdir(), `four-tools-${this.id}`);
    this.shellPath = options.shellPath;
    if (options.terminals !== false)
      this.terminals = new PosixTerminalManager({
        cwd: this.cwd,
        platform,
        terminalDir:
          options.terminalDir ?? path.join(this.spillDir, 'terminals'),
        shell: () => this.getShell(),
        onExit: options.onTerminalExit,
        onError: options.onTerminalError,
      });
  }
  async getShell(): Promise<string> {
    if (this.shellPath) {
      await fs.access(this.shellPath, constants.X_OK);
      return this.shellPath;
    }
    for (const shell of [
      '/bin/bash',
      ...(this.platform === 'darwin' ? ['/bin/zsh'] : []),
      '/bin/sh',
    ]) {
      try {
        await fs.access(shell, constants.X_OK);
        return shell;
      } catch {
        /* Probe the next POSIX shell. */
      }
    }
    throw new Error('No executable POSIX shell found');
  }
  async resolvePath(
    inputPath: string,
    options: { cwd?: string; mustExist?: boolean } = {},
  ) {
    const expand = (value: string) =>
      path.resolve(
        options.cwd ?? this.cwd,
        value === '~'
          ? this.homeDir
          : value.startsWith('~/')
            ? path.join(this.homeDir, value.slice(2))
            : value,
      );
    let resolvedPath = expand(inputPath);
    if (inputPath.startsWith('@') && !(await exists(resolvedPath)))
      resolvedPath = expand(inputPath.slice(1));
    if (options.mustExist && !(await exists(resolvedPath))) {
      const names = await fs.readdir(path.dirname(resolvedPath));
      const candidates = names.filter(
        (name) => variantKey(name) === variantKey(path.basename(resolvedPath)),
      );
      if (candidates.length > 1)
        throw new Error(`Ambiguous filename: ${inputPath}`);
      if (!candidates.length) throw new Error(`File not found: ${inputPath}`);
      resolvedPath = path.join(path.dirname(resolvedPath), candidates[0]);
    }
    return { resolvedPath, canonicalPath: await canonical(resolvedPath) };
  }
  async stat(file: string): Promise<FileStat> {
    try {
      const s = await fs.lstat(file);
      return {
        exists: true,
        isDirectory: s.isDirectory(),
        isSymbolicLink: s.isSymbolicLink(),
        size: s.size,
        mode: s.mode,
        mtimeMs: s.mtimeMs,
      };
    } catch (error) {
      if (!missing(error)) throw error;
      return {
        exists: false,
        isDirectory: false,
        isSymbolicLink: false,
        size: 0,
        mode: 0,
        mtimeMs: 0,
      };
    }
  }
  readRange = readRange;
  async readText(
    file: string,
    options: { maxBytes?: number; signal?: AbortSignal } = {},
  ): Promise<string> {
    options.signal?.throwIfAborted();
    const max = options.maxBytes ?? 16 * 1024 * 1024;
    const handle = await fs.open(file, 'r');
    try {
      const parts: Buffer[] = [];
      let size = 0;
      for (;;) {
        options.signal?.throwIfAborted();
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, max - size + 1));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        size += bytesRead;
        if (size > max)
          throw new Error(`File exceeds readText maxBytes (${max})`);
        parts.push(chunk.subarray(0, bytesRead));
      }
      return Buffer.concat(parts, size).toString('utf8');
    } finally {
      await handle.close();
    }
  }
  async writeText(
    file: string,
    content: string,
    options: { signal?: AbortSignal } = {},
  ) {
    options.signal?.throwIfAborted();
    const actualWritePath = await canonical(file);
    await fs.mkdir(path.dirname(actualWritePath), { recursive: true });
    let existingMode: number | undefined;
    try {
      existingMode = (await fs.stat(actualWritePath)).mode & 0o7777;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const tmpPath = path.join(
      path.dirname(actualWritePath),
      `.four-tools-${process.pid}-${randomUUID()}.tmp`,
    );
    const data = Buffer.from(content, 'utf8');
    try {
      const handle = await fs.open(tmpPath, 'wx', 0o666);
      try {
        await handle.writeFile(data, { signal: options.signal });
        if (existingMode !== undefined) await handle.chmod(existingMode);
        await handle.datasync();
      } finally {
        await handle.close();
      }
      options.signal?.throwIfAborted();
      try {
        await fs.rename(tmpPath, actualWritePath);
      } catch (error) {
        if (
          !['EXDEV', 'EACCES', 'EPERM'].includes(
            (error as NodeJS.ErrnoException).code ?? '',
          )
        )
          throw error;
        await fs.unlink(tmpPath);
        await fs.writeFile(actualWritePath, data, {
          signal: options.signal,
          mode: existingMode ?? 0o666,
        });
        if (existingMode !== undefined)
          await fs.chmod(actualWritePath, existingMode);
      }
    } catch (error) {
      await fs.unlink(tmpPath).catch(() => {});
      throw error;
    }
    return { bytesWritten: data.length };
  }
  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const running = await startProcess({
      command,
      cwd: options.cwd ?? this.cwd,
      shell: await this.getShell(),
      platform: this.platform,
      logDir: this.spillDir,
      options: { ...options, timeoutMs: options.timeoutMs ?? 30_000 },
    });
    try {
      const result = await running.done;
      if (!result.truncated) await fs.unlink(running.logPath);
      return result;
    } catch (error) {
      await fs.unlink(running.logPath).catch(() => {});
      throw error;
    }
  }
  async dispose(): Promise<void> {
    await this.terminals?.dispose();
  }
}
