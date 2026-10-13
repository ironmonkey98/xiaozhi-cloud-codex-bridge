// Runs cloud/recording-ingest/finalize/finalize.py (contract: docs/RECORDING_PROTOCOL.md section 6).
import { execFile } from 'node:child_process';
import type { FinalizeResult } from './session.ts';

export function makeFinalizer(python: string, script: string, timeoutMs = 10 * 60_000) {
  return (sessionDir: string, outDir: string): Promise<FinalizeResult> =>
    new Promise((resolve) => {
      execFile(python, [script, '--session-dir', sessionDir, '--out-dir', outDir],
        { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          const line = stdout.trim().split('\n').pop() ?? '';
          try {
            const parsed = JSON.parse(line) as FinalizeResult;
            if (typeof parsed.ok === 'boolean') return resolve(parsed);
          } catch { /* fall through */ }
          resolve({ ok: false, error: err ? `finalize exited: ${err.message.split('\n')[0]}` : 'finalize printed no result' });
        });
    });
}
