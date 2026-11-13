import type { ExecutionEnv } from '../env.js';
import { toolContracts } from '../contracts.js';
import type { FourTool } from '../types.js';
import { defaultMutationQueue } from '../mutation-queue.js';
import { aliases, safe, text, type FileToolOptions } from './shared.js';
export function createWriteTool(
  env: ExecutionEnv,
  options: FileToolOptions = {},
): FourTool {
  return safe({
    name: 'write',
    ...structuredClone(toolContracts.write),
    concurrency: 'parallel',
    async execute(raw, ctx = {}) {
      ctx.signal?.throwIfAborted();
      const input = aliases(raw),
        content = text(input, 'content');
      let displayPath = text(input, 'path');
      const path = await env.resolvePath(displayPath);
      if (displayPath === '~' || displayPath.startsWith('~/'))
        displayPath = path.resolvedPath;
      return (options.queue ?? defaultMutationQueue).run(
        env.id,
        path.canonicalPath,
        async () => {
          await env.writeText(path.resolvedPath, content, {
            signal: ctx.signal,
          });
          const message = `File written: ${displayPath} (${content.length} chars)`;
          const guidance = await options.hooks?.afterMutate?.({
            path: path.resolvedPath,
            canonicalPath: path.canonicalPath,
            operation: 'write',
            charCount: content.length,
            content: content,
            context: ctx,
          });
          return guidance ? { content: message, guidance } : message;
        },
        ctx.signal,
      );
    },
  });
}
