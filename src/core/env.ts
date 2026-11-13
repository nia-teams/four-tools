export type Platform = 'linux' | 'darwin';
export type ResolvedPath = { resolvedPath: string; canonicalPath: string };
export type FileStat = {
  exists: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  size: number;
  mode: number;
  mtimeMs: number;
};
export type ReadRangeResult = {
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncatedByBytes: boolean;
  isBinary?: boolean;
  singleLineExceeded?: boolean;
};
export type ExecOptions = {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  onOutput?: (chunk: Uint8Array, stream: 'stdout' | 'stderr') => void;
};
export type ExecResult = {
  output: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  spillPath?: string;
  durationMs?: number;
};
export type TerminalStatus = 'running' | 'exited' | 'signaled' | 'error';
export type TerminalInfo = {
  id: string;
  name: string;
  command: string;
  cwd: string;
  status: TerminalStatus;
  exitCode: number | null;
  signal: string | null;
  startedAt: number;
  endedAt?: number;
  linesBuffered?: number;
};
export type TerminalExitEvent = {
  id: string;
  name: string;
  command: string;
  cwd: string;
  status: Exclude<TerminalStatus, 'running'>;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  outputPreview: string;
  logPath?: string;
};
export interface ManagedTerminalBackend {
  execWithHandoff(input: {
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    handoffAfterMs: number;
    maxOutputBytes?: number;
    signal?: AbortSignal;
    onAbort?: 'handoff' | 'kill';
  }): Promise<
    | {
        completed: true;
        output: string;
        stdout?: string;
        stderr?: string;
        durationMs?: number;
        exitCode: number | null;
        signal: string | null;
        truncated: boolean;
        spillPath?: string;
      }
    | {
        completed: false;
        terminal: TerminalInfo;
        partialOutput: string;
        handoffReason?: 'timeout' | 'abort';
      }
  >;
  create(input: {
    command: string;
    cwd?: string;
    name?: string;
    env?: Record<string, string>;
    notifyOnExit?: boolean;
  }): Promise<TerminalInfo>;
  list(): Promise<TerminalInfo[]>;
  read(input: { id: string; offset?: number; limit?: number }): Promise<{
    content: string;
    lines?: string[];
    nextOffset?: number;
    startLine: number;
    endLine: number;
    totalLines: number;
    status: TerminalStatus;
    exitCode: number | null;
  }>;
  signal(input: {
    id: string;
    signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL';
  }): Promise<TerminalInfo>;
  destroy(input: { id: string }): Promise<void>;
}
export interface ExecutionEnv {
  readonly id: string;
  readonly platform: Platform;
  readonly cwd: string;
  resolvePath(
    inputPath: string,
    options?: { cwd?: string; mustExist?: boolean },
  ): Promise<ResolvedPath>;
  stat(resolvedPath: string): Promise<FileStat>;
  readRange(
    resolvedPath: string,
    options?: {
      offsetLine?: number;
      limitLines?: number;
      maxBytes?: number;
      signal?: AbortSignal;
    },
  ): Promise<ReadRangeResult>;
  readText(
    resolvedPath: string,
    options?: { maxBytes?: number; signal?: AbortSignal },
  ): Promise<string>;
  writeText(
    resolvedPath: string,
    content: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ bytesWritten: number }>;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  terminals?: ManagedTerminalBackend;
}
