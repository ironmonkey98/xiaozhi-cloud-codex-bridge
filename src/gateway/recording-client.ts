import { z } from 'zod';
import type { RecordingApiConfig } from '../config.ts';
import { BridgeError } from '../shared/errors.ts';
import { recordingIdSchema } from '../shared/schemas.ts';

const milliseconds = z.number().int().nonnegative();
export const recordingSchema = z.object({
  recording_id: recordingIdSchema,
  created_at: z.string().datetime(),
  duration_ms: milliseconds,
  state: z.enum(['saved', 'partial', 'failed']),
  transcript: z.object({
    state: z.enum(['none', 'pending', 'running', 'done', 'failed']),
    chars: z.number().int().nonnegative(),
    preview: z.string().refine((text) => Array.from(text).length <= 80),
    error: z.string().nullable(),
  }).strict(),
}).strict();
export const recordingListSchema = z.object({ recordings: z.array(recordingSchema).max(50) }).strict();
export const transcriptSchema = z.object({
  recording_id: recordingIdSchema,
  duration_ms: milliseconds,
  language: z.string().min(1),
  text: z.string(),
  sentences: z.array(z.object({ begin_ms: milliseconds, end_ms: milliseconds, text: z.string() }).strict()
    .refine((s) => s.end_ms >= s.begin_ms)),
}).strict();
const conflictSchema = z.union([
  z.object({ error: z.literal('transcript_not_ready'), state: z.enum(['none', 'pending', 'running']) }).strict(),
  z.object({ error: z.literal('transcript_failed'), state: z.literal('failed') }).strict(),
]);
export type Recording = z.infer<typeof recordingSchema>;

function invalid(): BridgeError {
  return new BridgeError('RECORDING_API_INVALID_RESPONSE', '录音服务返回的数据格式不正确，请稍后再试。');
}

/** 只读客户端：禁止重定向，整个读取过程共用截止时间，响应按字节限流。 */
export class RecordingClient {
  private readonly config: RecordingApiConfig | undefined;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(config?: RecordingApiConfig, options: { timeoutMs?: number; maxBytes?: number } = {}) {
    this.config = config;
    this.timeoutMs = options.timeoutMs ?? 3000;
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  }

  async list(limit = 10, signal = AbortSignal.timeout(this.timeoutMs)): Promise<Recording[]> {
    return (await this.request(`/recordings?limit=${limit}`, recordingListSchema, signal)).recordings;
  }

  async transcript(recordingId?: string) {
    // 列表、元数据与正文共享预算，确保先于 stdio 的 5 秒超时返回稳定错误码。
    const signal = AbortSignal.timeout(this.timeoutMs);
    let recording: Recording | undefined;
    if (recordingId) {
      if (!recordingIdSchema.safeParse(recordingId).success) throw new BridgeError('INVALID_REQUEST', '录音编号格式不正确。');
      recording = await this.request(`/recordings/${recordingId}`, recordingSchema, signal);
      if (recording.recording_id !== recordingId) throw invalid();
    } else {
      const items = await this.list(50, signal);
      items.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      recording = items.find((r) => r.transcript.state === 'done' && r.state !== 'failed');
      if (!recording) {
        if (!items.length) throw new BridgeError('RECORDING_NOT_FOUND', '还没有找到录音。');
        this.assertReady(items[0]!);
        throw new BridgeError('RECORDING_NOT_READY', '最近五十段录音中没有已完成的转写。');
      }
    }
    this.assertReady(recording);
    let transcript: z.infer<typeof transcriptSchema>;
    try {
      transcript = await this.request(`/recordings/${recording.recording_id}/transcript`, transcriptSchema, signal);
    } catch (err) {
      if (recording.state === 'partial' && err instanceof BridgeError) {
        throw new BridgeError(err.code, `这段录音不完整。${err.spokenText}`);
      }
      throw err;
    }
    if (transcript.recording_id !== recording.recording_id || transcript.duration_ms !== recording.duration_ms) throw invalid();
    return { recording, transcript };
  }

  private assertReady(recording: Recording): void {
    const prefix = recording.state === 'partial' ? '这段录音不完整。' : '';
    if (recording.state === 'failed') throw new BridgeError('RECORDING_FAILED', '这段录音保存失败，没有可用音频。');
    if (recording.transcript.state === 'failed') throw new BridgeError('RECORDING_TRANSCRIPT_FAILED', `${prefix}这段录音转写失败，请稍后再试。`);
    if (recording.transcript.state !== 'done') throw new BridgeError('RECORDING_NOT_READY', `${prefix}这段录音尚未转写完成，请稍后再试。`);
  }

  private async request<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal): Promise<T> {
    if (!this.config) throw new BridgeError('RECORDING_NOT_CONFIGURED', '录音查询尚未配置，请先在电脑上配置录音服务。');
    try {
      const response = await fetch(this.config.url + path, {
        headers: { authorization: `Bearer ${this.config.token}` }, redirect: 'error', signal,
      });
      if (!response.body) throw invalid();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > this.maxBytes) throw new BridgeError('RECORDING_RESPONSE_TOO_LARGE', '录音服务返回内容过大，无法读取。');
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw invalid();
      let json: unknown;
      try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { throw invalid(); }
      if (response.status === 409) {
        const error = conflictSchema.safeParse(json);
        if (!error.success) throw invalid();
        throw error.data.error === 'transcript_failed'
          ? new BridgeError('RECORDING_TRANSCRIPT_FAILED', '这段录音转写失败，请稍后再试。')
          : new BridgeError('RECORDING_NOT_READY', '这段录音尚未转写完成，请稍后再试。');
      }
      const errors = { 400: 'bad_request', 401: 'unauthorized', 404: 'not_found' } as const;
      if (response.status in errors) {
        const expected = errors[response.status as keyof typeof errors];
        if (!z.object({ error: z.literal(expected) }).strict().safeParse(json).success) throw invalid();
        if (response.status === 401) throw new BridgeError('RECORDING_AUTH_FAILED', '录音服务认证失败，请检查电脑上的配置。');
        if (response.status === 404) throw new BridgeError('RECORDING_NOT_FOUND', '没有找到这段录音。');
        throw invalid();
      }
      if (response.status !== 200) throw new BridgeError('RECORDING_API_UNAVAILABLE', '录音服务暂时不可用，请稍后再试。');
      const parsed = schema.safeParse(json);
      if (!parsed.success) throw invalid();
      return parsed.data;
    } catch (err) {
      if (err instanceof BridgeError) throw err;
      if (signal.aborted) throw new BridgeError('RECORDING_API_TIMEOUT', '查询录音超时，请稍后再试。');
      // 不记录上游错误、URL、响应正文或令牌。
      throw new BridgeError('RECORDING_API_UNAVAILABLE', '录音服务暂时不可用，请稍后再试。');
    }
  }
}
