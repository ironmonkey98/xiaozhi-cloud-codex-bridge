// Transcribes finished recordings with Bailian (DashScope) Fun-ASR file transcription.
// Audio reaches Bailian through a random, short-lived download link served by api.ts.
// State per session: sessions/<id>/transcript-state.json; result: sessions/<id>/transcript.json.
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { SessionMeta } from './session.ts';

export type TranscriptState = 'none' | 'pending' | 'running' | 'done' | 'failed';

export interface TranscriptStatus {
  state: TranscriptState;
  attempts: number;
  chars: number | null;
  error: string | null;
  updated_at: string;
  retry_after: number | null;
}

export interface Transcript {
  recording_id: string;
  duration_ms: number;
  language: string;
  text: string;
  sentences: { begin_ms: number; end_ms: number; text: string }[];
}

/** Random tokens for /recording-dl/<token>; memory only, so a restart revokes them. */
export class DownloadTokens {
  private readonly tokens = new Map<string, { recordingId: string; expires: number }>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  issue(recordingId: string, ttlMs: number): string {
    const token = randomBytes(24).toString('hex');
    this.tokens.set(token, { recordingId, expires: this.now() + ttlMs });
    return token;
  }

  resolve(token: string): string | null {
    const entry = this.tokens.get(token);
    if (!entry) return null;
    if (this.now() >= entry.expires) {
      this.tokens.delete(token);
      return null;
    }
    return entry.recordingId;
  }

  revoke(token: string): void {
    this.tokens.delete(token);
  }
}

const submitSchema = z.object({ output: z.object({ task_id: z.string().min(1) }) });
const taskSchema = z.object({
  output: z.object({
    task_status: z.string(),
    results: z.array(z.object({
      subtask_status: z.string().optional(),
      transcription_url: z.string().optional(),
      code: z.string().optional(),
      message: z.string().optional(),
    })).optional(),
    code: z.string().optional(),
    message: z.string().optional(),
  }),
});
const resultSchema = z.object({
  transcripts: z.array(z.object({
    text: z.string(),
    sentences: z.array(z.object({ begin_time: z.number(), end_time: z.number(), text: z.string() })).optional(),
  })).min(1),
});

export interface TranscriberOptions {
  dataDir: string;
  apiKey: string;
  publicBaseUrl: string; // e.g. https://host:8443/recording-dl
  tokens: DownloadTokens;
  model?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (event: Record<string, unknown>) => void;
  pollMs?: number;
  maxWaitMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
}

export function readTranscriptStatus(sessionDir: string): TranscriptStatus {
  try {
    return JSON.parse(readFileSync(join(sessionDir, 'transcript-state.json'), 'utf8')) as TranscriptStatus;
  } catch {
    return { state: 'none', attempts: 0, chars: null, error: null, updated_at: '', retry_after: null };
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export class Transcriber {
  private readonly o: Required<Omit<TranscriberOptions, 'log'>> & Pick<TranscriberOptions, 'log'>;
  private busy = false;

  constructor(options: TranscriberOptions) {
    this.o = {
      model: 'fun-asr',
      baseUrl: 'https://dashscope.aliyuncs.com',
      fetch: globalThis.fetch,
      now: Date.now,
      pollMs: 5000,
      maxWaitMs: 30 * 60_000,
      maxAttempts: 3,
      retryDelayMs: 60_000,
      ...options,
    };
  }

  /** Transcribes the oldest eligible recording, if any; one at a time. Returns true if it worked on one. */
  async runOnce(): Promise<boolean> {
    if (this.busy) return false;
    const next = this.nextCandidate();
    if (!next) return false;
    this.busy = true;
    try {
      await this.transcribe(next.id, next.meta, next.status);
    } finally {
      this.busy = false;
    }
    return true;
  }

  private nextCandidate(): { id: string; meta: SessionMeta; status: TranscriptStatus } | null {
    let ids: string[];
    try {
      ids = readdirSync(join(this.o.dataDir, 'sessions'));
    } catch {
      return null;
    }
    const now = this.o.now();
    const candidates: { id: string; meta: SessionMeta; status: TranscriptStatus }[] = [];
    for (const id of ids) {
      const dir = join(this.o.dataDir, 'sessions', id);
      let meta: SessionMeta;
      try {
        meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as SessionMeta;
      } catch {
        continue;
      }
      if (meta.state !== 'saved' && meta.state !== 'partial') continue;
      if (!existsSync(join(this.o.dataDir, 'recordings', `${id}.ogg`))) continue;
      const status = readTranscriptStatus(dir);
      // "running" left by a restart is retried like a failure.
      const retryable = (status.state === 'failed' || status.state === 'running') &&
        status.attempts < this.o.maxAttempts && (status.retry_after ?? 0) <= now;
      if (status.state === 'none' || status.state === 'pending' || retryable) candidates.push({ id, meta, status });
    }
    candidates.sort((a, b) => a.meta.created_at.localeCompare(b.meta.created_at));
    return candidates[0] ?? null;
  }

  private setStatus(id: string, status: TranscriptStatus): void {
    writeJsonAtomic(join(this.o.dataDir, 'sessions', id, 'transcript-state.json'), status);
  }

  private async transcribe(id: string, meta: SessionMeta, previous: TranscriptStatus): Promise<void> {
    const attempts = previous.attempts + 1;
    const stamp = () => new Date(this.o.now()).toISOString();
    this.setStatus(id, { state: 'running', attempts, chars: null, error: null, updated_at: stamp(), retry_after: null });
    const token = this.o.tokens.issue(id, this.o.maxWaitMs);
    try {
      const transcript = await this.callBailian(id, meta, `${this.o.publicBaseUrl}/${token}`);
      writeJsonAtomic(join(this.o.dataDir, 'sessions', id, 'transcript.json'), transcript);
      this.setStatus(id, { state: 'done', attempts, chars: transcript.text.length, error: null, updated_at: stamp(),
        retry_after: null });
      this.log({ event: 'transcript_done', recording_id: id, chars: transcript.text.length });
    } catch (err) {
      const error = err instanceof Error ? err.message.slice(0, 160) : 'unknown error';
      this.setStatus(id, { state: 'failed', attempts, chars: null, error, updated_at: stamp(),
        retry_after: this.o.now() + this.o.retryDelayMs * attempts });
      this.log({ event: 'transcript_failed', recording_id: id, attempts, error });
    } finally {
      this.o.tokens.revoke(token);
    }
  }

  private async callBailian(id: string, meta: SessionMeta, fileUrl: string): Promise<Transcript> {
    const headers = { Authorization: `Bearer ${this.o.apiKey}`, 'Content-Type': 'application/json' };
    const submit = await this.o.fetch(`${this.o.baseUrl}/api/v1/services/audio/asr/transcription`, {
      method: 'POST',
      headers: { ...headers, 'X-DashScope-Async': 'enable' },
      body: JSON.stringify({ model: this.o.model, input: { file_urls: [fileUrl] }, parameters: { language_hints: ['zh'] } }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!submit.ok) throw new Error(`submit http ${submit.status}`);
    const taskId = submitSchema.parse(await submit.json()).output.task_id;
    this.log({ event: 'transcript_submitted', recording_id: id });

    const deadline = this.o.now() + this.o.maxWaitMs;
    while (true) {
      await delay(this.o.pollMs);
      const res = await this.o.fetch(`${this.o.baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
        headers: { Authorization: headers.Authorization }, signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`query http ${res.status}`);
      const task = taskSchema.parse(await res.json()).output;
      if (task.task_status === 'SUCCEEDED' || task.task_status === 'FAILED') {
        const sub = task.results?.[0];
        if (task.task_status === 'FAILED' || sub?.subtask_status === 'FAILED' || !sub?.transcription_url) {
          throw new Error(`asr failed: ${sub?.code ?? task.code ?? 'unknown'}`);
        }
        return this.download(id, meta, sub.transcription_url);
      }
      if (this.o.now() > deadline) throw new Error('asr timed out');
    }
  }

  private async download(id: string, meta: SessionMeta, url: string): Promise<Transcript> {
    const res = await this.o.fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`result http ${res.status}`);
    const body = await res.text();
    if (body.length > 8 * 1024 * 1024) throw new Error('result too large');
    const first = resultSchema.parse(JSON.parse(body)).transcripts[0]!;
    return {
      recording_id: id,
      duration_ms: meta.result?.duration_ms ?? 0,
      language: 'zh',
      text: first.text,
      sentences: (first.sentences ?? []).map((s) => ({ begin_ms: s.begin_time, end_ms: s.end_time, text: s.text })),
    };
  }

  private log(event: Record<string, unknown>): void {
    this.o.log?.(event);
  }
}
