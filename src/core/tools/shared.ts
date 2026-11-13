import type {
  FourTool,
  FourToolContext,
  FourToolResult,
  NativeToolContext,
  ToolHooks,
} from '../types.js';
import type { FileMutationQueue } from '../mutation-queue.js';
export interface FileToolOptions {
  maxBytes?: number;
  hooks?: ToolHooks;
  queue?: FileMutationQueue;
}
export const schema = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({ type: 'object', additionalProperties: false, properties, required });
export function aliases(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...input,
    path: input.path ?? input.file_path ?? input.filepath,
    old_string:
      input.old_string ?? input.old_str ?? input.oldText ?? input.oldString,
    new_string:
      input.new_string ?? input.new_str ?? input.newText ?? input.newString,
  };
}
export function text(input: Record<string, unknown>, key: string): string {
  if (typeof input[key] !== 'string')
    throw new Error(`${key} must be a string`);
  return input[key];
}
export function number(value: unknown, fallback: number, minimum = 1): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error('Expected a finite number');
  return Math.max(minimum, Math.trunc(value));
}
export type ToolImplementation = Omit<FourTool, 'execute'> & {
  execute(
    input: Record<string, unknown>,
    ctx?: FourToolContext,
  ): Promise<FourToolResult>;
};
export function safe(tool: ToolImplementation): FourTool {
  async function execute(
    input: Record<string, unknown>,
    ctx: NativeToolContext,
  ): Promise<string>;
  async function execute(
    input: Record<string, unknown>,
    ctx?: FourToolContext,
  ): Promise<FourToolResult>;
  async function execute(
    input: Record<string, unknown>,
    ctx: FourToolContext = {},
  ): Promise<FourToolResult> {
    try {
      // Match optional-field cleaning in the native host, while accepting file aliases.
      const clean = Object.fromEntries(
        Object.entries(input).filter(
          ([, value]) => value !== null && value !== undefined,
        ),
      );
      const result = await tool.execute(clean, ctx);
      if (
        typeof result !== 'string' &&
        typeof ctx.workspaceId === 'string' &&
        typeof ctx.teamId === 'string' &&
        typeof ctx.model === 'string'
      ) {
        if (result.guidance?.length)
          ctx.aiPostContext = [
            ...(ctx.aiPostContext ?? []),
            ...result.guidance,
          ];
        return result.content;
      }
      return result;
    } catch (error) {
      const prefix =
        tool.name === 'read'
          ? 'Error reading file:'
          : tool.name === 'write'
            ? 'Error writing file:'
            : 'ERROR:';
      return (
        prefix + ' ' + (error instanceof Error ? error.message : String(error))
      );
    }
  }
  return { ...tool, execute };
}
