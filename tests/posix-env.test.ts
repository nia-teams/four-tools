import { test, expect, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { createReadTool } from '../src/index.js';
import { createNodeEnv, signalProcessGroup } from '../src/node/index.js';
import { fixture, delay } from './helpers.js';

test('reject unsupported platform', () => {
  expect(() => createNodeEnv({ platform: 'win32' })).toThrow(
    'Unsupported platform',
  );
});
test('home, literal @, fallback @, Unicode variants, and canonical symlink parents', async () => {
  const f = await fixture();
  try {
    expect((await f.env.resolvePath('~')).resolvedPath).toBe(f.dir);
    expect((await f.env.resolvePath('~/new')).resolvedPath).toBe(f.file('new'));
    await fs.writeFile(f.file('a'), 'a');
    await fs.writeFile(f.file('@literal'), 'b');
    expect(
      (await f.env.resolvePath('@a', { mustExist: true })).resolvedPath,
    ).toBe(f.file('a'));
    expect((await f.env.resolvePath('@literal')).resolvedPath).toBe(
      f.file('@literal'),
    );
    const name = 'cafe\u0301\u202Ftoday’s.txt';
    await fs.writeFile(f.file(name), 'x');
    expect(
      (await f.env.resolvePath("café today's.txt", { mustExist: true }))
        .resolvedPath,
    ).toBe(f.file(name));
    await fs.writeFile(f.file("cafe\u0301 today's.txt"), 'x');
    await expect(
      f.env.resolvePath("café\u202Ftoday's.txt", { mustExist: true }),
    ).rejects.toThrow('Ambiguous');
    await fs.mkdir(f.file('real'));
    await fs.symlink(f.file('real'), f.file('link'));
    expect((await f.env.resolvePath('link/new/deep')).canonicalPath).toBe(
      f.file('real/new/deep'),
    );
  } finally {
    await f.cleanup();
  }
});
test('atomic writes follow symlinks, preserve executable bits under restrictive umask, and respect new-file umask', async () => {
  const f = await fixture();
  const mask = process.umask();
  try {
    await fs.writeFile(f.file('target'), 'old');
    await fs.chmod(f.file('target'), 0o755);
    await fs.symlink('target', f.file('alias'));
    process.umask(0o077);
    await f.env.writeText(f.file('alias'), 'new');
    expect((await fs.lstat(f.file('alias'))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(f.file('target'), 'utf8')).toBe('new');
    expect((await fs.stat(f.file('target'))).mode & 0o777).toBe(0o755);
    await f.env.writeText(f.file('nested/new'), 'new');
    expect((await fs.stat(f.file('nested/new'))).mode & 0o777).toBe(0o600);
    await fs.symlink('future', f.file('dangling'));
    await f.env.writeText(f.file('dangling'), 'future');
    expect((await fs.lstat(f.file('dangling'))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(f.file('future'), 'utf8')).toBe('future');
  } finally {
    process.umask(mask);
    await f.cleanup();
  }
});
test('streaming reads paginate, count all lines, cap huge lines, detect binary and abort', async () => {
  const f = await fixture();
  try {
    const file = f.file('many');
    await fs.writeFile(
      file,
      Array.from({ length: 9000 }, (_, i) => `line ${i + 1}`).join('\n'),
    );
    expect(
      await f.env.readRange(file, { offsetLine: 8998, limitLines: 2 }),
    ).toMatchObject({
      content: 'line 8998\nline 8999\n',
      totalLines: 9000,
      startLine: 8998,
      endLine: 8999,
    });
    expect(
      await createReadTool(f.env).execute({
        file_path: 'many',
        offset: 0.9,
        limit: 1,
      }),
    ).toBe('line 1\n');
    await fs.writeFile(file, 'x'.repeat(3 * 1024 * 1024) + '\nlast\n');
    expect(await f.env.readRange(file, { maxBytes: 100 })).toMatchObject({
      content: 'x'.repeat(100),
      totalLines: 2,
      endLine: 1,
      truncatedByBytes: true,
      singleLineExceeded: true,
    });
    await expect(f.env.readText(file, { maxBytes: 10 })).rejects.toThrow(
      'maxBytes',
    );
    await fs.writeFile(file, Buffer.from([1, 0, 2]));
    expect((await f.env.readRange(file)).isBinary).toBe(true);
    await expect(
      f.env.readRange(file, { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    await fs.writeFile(file, '');
    expect((await f.env.readRange(file)).totalLines).toBe(0);
    await fs.writeFile(file, 'a\nb\n');
    expect((await f.env.readRange(file)).totalLines).toBe(2);
    await fs.writeFile(file, '😀');
    expect((await f.env.readRange(file, { maxBytes: 3 })).content).toBe('');
  } finally {
    await f.cleanup();
  }
});
test('exec separates streams, inherits plus overlays env, spills full output readable through read', async () => {
  const f = await fixture();
  try {
    const result = await f.env.exec(
      'printf "$FOUR_TOOLS_TEST"; printf err >&2',
      { env: { FOUR_TOOLS_TEST: 'hello' } },
    );
    expect(result).toMatchObject({
      stdout: 'hello',
      stderr: 'err',
      exitCode: 0,
      truncated: false,
    });
    expect(process.env.FOUR_TOOLS_TEST).toBeUndefined();
    const spilled = await f.env.exec(
      `${JSON.stringify(process.execPath)} -e 'process.stdout.write("x".repeat(100000))'`,
      { maxOutputBytes: 1000 },
    );
    expect(spilled.truncated).toBe(true);
    expect(spilled.output.length).toBeLessThan(1200);
    expect((await fs.readFile(spilled.spillPath!)).length).toBe(100000);
    expect((await fs.stat(spilled.spillPath!)).mode & 0o777).toBe(0o600);
    expect(
      await createReadTool(f.env, { maxBytes: 100 }).execute({
        path: spilled.spillPath,
      }),
    ).toContain('x'.repeat(100));
  } finally {
    await f.cleanup();
  }
});
test('timeout and abort kill process groups, including child and grandchild', async () => {
  const f = await fixture();
  try {
    const result = await f.env.exec('(sleep 0.2; printf bad > marker) & wait', {
      timeoutMs: 50,
    });
    expect(result).toMatchObject({ timedOut: true, signal: 'SIGKILL' });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 50);
    expect(
      await f.env.exec('sleep 5 & wait', { signal: ctrl.signal }),
    ).toMatchObject({ aborted: true, signal: 'SIGKILL' });
    clearTimeout(timer);
    await delay(300);
    expect((await f.env.stat(f.file('marker'))).exists).toBe(false);
  } finally {
    await f.cleanup();
  }
});
test('grandchildren retaining stdout do not wedge foreground completion', async () => {
  const f = await fixture();
  try {
    const start = Date.now();
    // The short-lived grandchild retains the pipe after its parent shell exits.
    const result = await f.env.exec('sleep 1 & printf done', {
      timeoutMs: 3000,
    });
    expect(result.output).toBe('done');
    expect(Date.now() - start).toBeLessThan(800);
  } finally {
    await f.cleanup();
  }
});
test('kernel-specific hard-kill order and PID fallback', () => {
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  try {
    signalProcessGroup(1234, 'SIGKILL', 'darwin');
    expect(kill.mock.calls).toEqual([
      [-1234, 'SIGSTOP'],
      [-1234, 'SIGKILL'],
      [-1234, 'SIGCONT'],
    ]);
    kill.mockClear();
    kill.mockImplementationOnce(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    signalProcessGroup(1234, 'SIGKILL', 'linux');
    expect(kill.mock.calls).toEqual([
      [-1234, 'SIGKILL'],
      [1234, 'SIGKILL'],
    ]);
  } finally {
    kill.mockRestore();
  }
});

test('cyclic symlinks report ELOOP and multi-hop writes retain links and executable target mode', async () => {
  const f = await fixture();
  try {
    await fs.symlink('loop-b', f.file('loop-a'));
    await fs.symlink('loop-a', f.file('loop-b'));
    await expect(
      f.env.resolvePath('loop-a', { mustExist: true }),
    ).rejects.toMatchObject({ code: 'ELOOP' });
    await expect(
      f.env.writeText(f.file('loop-a'), 'bad'),
    ).rejects.toMatchObject({ code: 'ELOOP' });
    await fs.writeFile(f.file('target'), 'old');
    await fs.chmod(f.file('target'), 0o751);
    await fs.symlink('target', f.file('link-b'));
    await fs.symlink('link-b', f.file('link-a'));
    await f.env.writeText(f.file('link-a'), 'new');
    for (const name of ['link-a', 'link-b'])
      expect((await fs.lstat(f.file(name))).isSymbolicLink()).toBe(true);
    expect((await fs.stat(f.file('target'))).mode & 0o777).toBe(0o751);
    expect(await fs.readFile(f.file('target'), 'utf8')).toBe('new');
  } finally {
    await f.cleanup();
  }
});
test('64 KiB boundaries preserve split UTF-8 characters and split CRLF line numbering', async () => {
  const f = await fixture();
  try {
    const first = 'a'.repeat(65535) + '😀' + 'b'.repeat(65532) + '\r\n';
    const file = f.file('boundary');
    await fs.writeFile(file, first + 'next\r\nlast');
    expect(
      await f.env.readRange(file, { limitLines: 1, maxBytes: 200000 }),
    ).toMatchObject({
      content: first,
      totalLines: 3,
      endLine: 1,
      truncatedByBytes: false,
    });
    expect(
      await f.env.readRange(file, { offsetLine: 2, limitLines: 1 }),
    ).toMatchObject({
      content: 'next\r\n',
      startLine: 2,
      endLine: 2,
      totalLines: 3,
    });
    const capped = await f.env.readRange(file, { maxBytes: 65537 });
    expect(capped.content).toBe('a'.repeat(65535));
    expect(capped.content).not.toContain('\uFFFD');
  } finally {
    await f.cleanup();
  }
});
