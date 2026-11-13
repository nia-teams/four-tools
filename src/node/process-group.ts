import type { Platform } from '../core/env.js';
export function signalProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
  platform: Platform,
): void {
  const send = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH' && code !== 'EPERM') throw error;
      try {
        process.kill(pid, sig);
      } catch (fallback) {
        if ((fallback as NodeJS.ErrnoException).code !== 'ESRCH')
          throw fallback;
      }
    }
  };
  if (signal === 'SIGKILL' && platform === 'darwin') {
    send('SIGSTOP');
    try {
      send('SIGKILL');
    } finally {
      send('SIGCONT');
    }
  } else send(signal);
}
