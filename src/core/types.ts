/** Mirrors the public ai/protocol contract without a runtime or type dependency. */
export type Guidance =
  | string
  | { kind: 'text'; text: string }
  | {
      kind: 'tool_loop_warning';
      warningType: string;
      toolName: string;
      count: number;
      message?: string;
    };
export interface FourToolContext {
  signal?: AbortSignal;
  workspaceId?: string;
  teamId?: string;
  model?: string;
  subagentId?: string;
  metadata?: Record<string, unknown>;
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  aiPostContext?: Guidance[];
}
export type FourToolResult =
  string | { content: string; guidance?: Guidance[] };
/** Hosts using a string-only tool bridge receive guidance via aiPostContext. */
export interface NativeToolContext extends FourToolContext {
  workspaceId: string;
  teamId: string;
  model: string;
}
export interface FourTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  concurrency?: 'parallel' | 'serial' | 'deferred';
  execute(
    input: Record<string, unknown>,
    ctx: NativeToolContext,
  ): Promise<string>;
  execute(
    input: Record<string, unknown>,
    ctx?: FourToolContext,
  ): Promise<FourToolResult>;
}
export interface MutationEvent {
  path: string;
  canonicalPath: string;
  operation: 'write' | 'edit';
  context: FourToolContext;
  charCount?: number;
  content?: string;
}
export interface ToolHooks {
  afterRead?: (event: {
    path: string;
    canonicalPath: string;
    content?: string;
    context: FourToolContext;
  }) => void | Guidance[] | Promise<void | Guidance[]>;
  afterExec?: (event: {
    command: string;
    cwd?: string;
    exitCode: number;
    context: FourToolContext;
  }) => void | Guidance[] | Promise<void | Guidance[]>;
  afterMutate?: (
    event: MutationEvent,
  ) => void | Guidance[] | Promise<void | Guidance[]>;
  resolveEnv?: (
    ctx: FourToolContext,
  ) => Record<string, string> | Promise<Record<string, string>>;
}
