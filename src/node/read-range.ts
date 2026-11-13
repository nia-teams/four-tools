import * as fs from 'node:fs/promises';
import type { ReadRangeResult } from '../core/env.js';
export async function readRange(
  file: string,
  options: {
    offsetLine?: number;
    limitLines?: number;
    maxBytes?: number;
    signal?: AbortSignal;
  } = {},
): Promise<ReadRangeResult> {
  const startLine = Math.max(1, Math.trunc(options.offsetLine ?? 1));
  const limit = Math.max(1, Math.trunc(options.limitLines ?? 2000));
  const maxBytes = Math.max(1, Math.trunc(options.maxBytes ?? 50 * 1024));
  const handle = await fs.open(file, 'r');
  const pieces: Buffer[] = [];
  let bytes = 0,
    line = 1,
    totalBytes = 0,
    lastByte = -1,
    endLine = startLine - 1,
    truncatedByBytes = false,
    singleLineExceeded = false;
  let selectedLineBytes = 0;
  try {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      options.signal?.throwIfAborted();
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      if (!totalBytes && chunk.subarray(0, bytesRead).includes(0))
        return {
          content: '',
          startLine,
          endLine: startLine - 1,
          totalLines: 0,
          truncatedByBytes: false,
          isBinary: true,
        };
      totalBytes += bytesRead;
      lastByte = chunk[bytesRead - 1];
      let at = 0;
      while (at < bytesRead) {
        const newline = chunk.indexOf(10, at);
        const stop =
          newline >= 0 && newline < bytesRead ? newline + 1 : bytesRead;
        if (line >= startLine && line < startLine + limit) {
          const size = stop - at;
          selectedLineBytes += size;
          const take = Math.min(size, maxBytes - bytes);
          if (take > 0) {
            pieces.push(Buffer.from(chunk.subarray(at, at + take)));
            bytes += take;
            endLine = line;
          }
          if (take < size) truncatedByBytes = true;
          if (selectedLineBytes > maxBytes) singleLineExceeded = true;
        }
        if (stop > at && chunk[stop - 1] === 10) {
          line++;
          selectedLineBytes = 0;
        }
        at = stop;
      }
    }
    // Drop an incomplete UTF-8 sequence at the byte cap instead of emitting replacement text.
    const data = Buffer.concat(pieces, bytes);
    const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
    const content = decoder.decode(data, { stream: truncatedByBytes });
    return {
      content,
      startLine,
      endLine,
      totalLines: totalBytes === 0 ? 0 : line - (lastByte === 10 ? 1 : 0),
      truncatedByBytes,
      ...(singleLineExceeded ? { singleLineExceeded: true } : {}),
    };
  } finally {
    await handle.close();
  }
}
