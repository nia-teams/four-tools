import type { ExecutionEnv } from '../env.js';
import { toolContracts } from '../contracts.js';
import type { FourTool } from '../types.js';
import { applyUniqueEdit } from '../edit-engine.js';
import { defaultMutationQueue } from '../mutation-queue.js';
import { aliases, safe, text, type FileToolOptions } from './shared.js';
export function createEditTool(
  env: ExecutionEnv,
  options: FileToolOptions = {},
): FourTool {
  return safe({
    name: 'edit',
    ...structuredClone(toolContracts.edit),
    concurrency: 'parallel',
    async execute(raw, ctx = {}) {
      ctx.signal?.throwIfAborted();
      const input = aliases(raw),
        displayPath = text(input, 'path'),
        oldString = text(input, 'old_string'),
        newString = text(input, 'new_string');
      const path = await env.resolvePath(displayPath, { mustExist: true });
      return (options.queue ?? defaultMutationQueue).run(
        env.id,
        path.canonicalPath,
        async () => {
          const original = await env.readText(path.resolvedPath, {
            maxBytes: options.maxBytes,
            signal: ctx.signal,
          });
          const result = applyUniqueEdit(original, oldString, newString);
          if (!result.ok) {
            if (result.count)
              return `ERROR: old_string found ${result.count} times, must be unique\n`;
            if (result.reason === 'not_found')
              return 'ERROR: old_string not found in file\n';
            return `ERROR: ${result.reason}`;
          }
          await env.writeText(path.resolvedPath, result.content, {
            signal: ctx.signal,
          });
          const message = 'OK: replacement applied';
          const guidance = await options.hooks?.afterMutate?.({
            path: path.resolvedPath,
            canonicalPath: path.canonicalPath,
            operation: 'edit',
            charCount: [...result.content].length,
            content: result.content,
            context: ctx,
          });
          return guidance ? { content: message, guidance } : message;
        },
        ctx.signal,
      );
    },
  });
}
