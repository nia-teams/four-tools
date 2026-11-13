import type { ExecutionEnv } from '../env.js';
import type { FourTool } from '../types.js';
import { toolContracts } from '../contracts.js';
import { aliases, number, safe, text, type FileToolOptions } from './shared.js';
export interface ReadToolOptions extends Omit<FileToolOptions, 'maxBytes'> {
  maxBytes?: number | false;
  maxLines?: number | false;
  /** Delegate output budgeting to the runtime instead of truncating in the tool. */
  truncate?: boolean;
}
export function createReadTool(
  env: ExecutionEnv,
  options: ReadToolOptions = {},
): FourTool {
  return safe({
    name: 'read',
    ...structuredClone(toolContracts.read),
    concurrency: 'parallel',
    async execute(input, ctx = {}) {
      ctx.signal?.throwIfAborted();
      const path = await env.resolvePath(text(aliases(input), 'path'), {
        mustExist: true,
      });
      const maxLines =
        options.truncate === false || options.maxLines === false
          ? Number.MAX_SAFE_INTEGER
          : number(options.maxLines, 2000);
      const maxBytes =
        options.truncate === false || options.maxBytes === false
          ? Number.MAX_SAFE_INTEGER
          : number(options.maxBytes, 50 * 1024);
      const requested = number(input.limit, Number.MAX_SAFE_INTEGER);
      const result = await env.readRange(path.resolvedPath, {
        offsetLine: number(input.offset, 1),
        limitLines: Math.min(requested, maxLines),
        maxBytes,
        signal: ctx.signal,
      });
      if (result.isBinary)
        return 'Error reading file: Binary file cannot be displayed as text';
      const capped =
        result.truncatedByBytes ||
        (requested > maxLines && result.endLine < result.totalLines);
      const content =
        result.content +
        (capped
          ? `\n\n[Showing lines ${result.startLine}-${result.endLine} of ${result.totalLines}. Use offset=${result.endLine + 1} to continue.]`
          : '');
      const guidance = await options.hooks?.afterRead?.({
        path: path.resolvedPath,
        canonicalPath: path.canonicalPath,
        content:
          input.offset === undefined && input.limit === undefined && !capped
            ? result.content
            : undefined,
        context: ctx,
      });
      return guidance ? { content, guidance } : content;
    },
  });
}
