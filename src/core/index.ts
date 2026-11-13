export * from './env.js';
export * from './types.js';
export * from './mutation-queue.js';
export * from './edit-engine.js';
export * from './tools/read.js';
export * from './tools/write.js';
export * from './tools/edit.js';
export * from './tools/shell.js';
export type { FileToolOptions } from './tools/shared.js';
import type { ExecutionEnv } from './env.js';
import type { FourTool, ToolHooks } from './types.js';
import { FileMutationQueue } from './mutation-queue.js';
import { createReadTool, type ReadToolOptions } from './tools/read.js';
import { createWriteTool } from './tools/write.js';
import { createEditTool } from './tools/edit.js';
import { createShellTool, type ShellToolOptions } from './tools/shell.js';
export interface FourToolsOptions {
  hooks?: ToolHooks;
  mutationQueue?: FileMutationQueue;
  maxReadBytes?: number;
  read?: ReadToolOptions;
  maxEditBytes?: number;
  shell?: ShellToolOptions;
}
export function createFourTools(
  env: ExecutionEnv,
  options: FourToolsOptions = {},
): FourTool[] {
  const queue = options.mutationQueue ?? new FileMutationQueue();
  return [
    createReadTool(env, {
      hooks: options.hooks,
      maxBytes: options.maxReadBytes,
      ...options.read,
    }),
    createWriteTool(env, { queue, hooks: options.hooks }),
    createEditTool(env, {
      queue,
      hooks: options.hooks,
      maxBytes: options.maxEditBytes,
    }),
    createShellTool(env, {
      ...options.shell,
      hooks: options.shell?.hooks ?? options.hooks,
    }),
  ];
}
