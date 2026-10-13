// AI Passport online recording protocol V1. Spec: docs/RECORDING_PROTOCOL.md.
import { crc32 } from 'node:zlib';
import { z } from 'zod';

export const PACKET_MAGIC = 'APR1';
export const PACKET_HEADER_BYTES = 36;
export const MAX_PACKET_BYTES = 768;
export const MAX_FRAMES_PER_PACKET = 16;
export const MAX_FRAME_BYTES = 1275;
export const FRAME_MS = 60;

const hex32 = z.string().regex(/^[a-f0-9]{32}$/);
export const deviceIdSchema = z.string().regex(/^[a-z0-9_-]{1,32}$/);

export const formatSchema = z.object({
  codec: z.literal('opus'),
  sample_rate: z.literal(16000),
  channels: z.literal(1),
  frame_ms: z.literal(FRAME_MS),
  dtx: z.boolean(),
}).strict();
export type RecordingFormat = z.infer<typeof formatSchema>;

export const startSchema = z.object({
  v: z.literal(1),
  type: z.literal('start'),
  request_id: hex32,
  format: formatSchema,
  max_duration_s: z.number().int().min(1).max(4 * 3600),
}).strict();

export const stopReasonSchema = z.enum(['user', 'max_duration', 'queue_overflow', 'network', 'error']);

export const stopSchema = z.object({
  v: z.literal(1),
  type: z.literal('stop'),
  session_id: hex32,
  last_seq: z.number().int().min(-1).max(0xffffffff),
  frames: z.number().int().min(0),
  duration_ms: z.number().int().min(0),
  dropped_frames: z.number().int().min(0),
  reason: stopReasonSchema,
}).strict();
export type StopMessage = z.infer<typeof stopSchema>;

export const requestSchema = z.discriminatedUnion('type', [startSchema, stopSchema]);
export type RequestMessage = z.infer<typeof requestSchema>;

export type ErrorCode = 'busy' | 'bad_request' | 'no_space' | 'unavailable' | 'unknown_session' | 'too_long';
export type FinishState = 'saved' | 'partial' | 'failed';

export type AckMessage =
  | { v: 1; type: 'start_ack'; request_id: string; session_id: string; max_packet_bytes: number }
  | { v: 1; type: 'chunk_ack'; session_id: string; persisted_seq: number; frames: number }
  | { v: 1; type: 'finish_ack'; session_id: string; state: FinishState; recording_id: string | null;
      duration_ms: number; missing_frames: number }
  | { v: 1; type: 'error'; code: ErrorCode; request_id?: string; session_id?: string };

export interface AudioPacket {
  sessionId: string;
  seq: number;
  firstFrame: number;
  frames: Buffer[];
}

/** Parses and fully validates one binary audio packet; returns an error string when invalid. */
export function parseAudioPacket(data: Buffer): AudioPacket | string {
  if (data.length < PACKET_HEADER_BYTES) return 'short packet';
  if (data.length > MAX_PACKET_BYTES) return 'packet too large';
  if (data.toString('latin1', 0, 4) !== PACKET_MAGIC) return 'bad magic';
  const frameCount = data.readUInt8(28);
  if (frameCount < 1 || frameCount > MAX_FRAMES_PER_PACKET) return 'bad frame count';
  if (data.readUInt8(29) !== 0 || data.readUInt16LE(30) !== 0) return 'reserved bits set';
  const body = data.subarray(PACKET_HEADER_BYTES);
  if (crc32(body) !== data.readUInt32LE(32)) return 'crc mismatch';
  const frames: Buffer[] = [];
  let at = 0;
  for (let i = 0; i < frameCount; i++) {
    if (at + 2 > body.length) return 'truncated frame header';
    const len = body.readUInt16LE(at);
    at += 2;
    if (len > MAX_FRAME_BYTES || at + len > body.length) return 'bad frame length';
    frames.push(body.subarray(at, at + len));
    at += len;
  }
  if (at !== body.length) return 'trailing bytes';
  return {
    sessionId: data.subarray(4, 20).toString('hex'),
    seq: data.readUInt32LE(20),
    firstFrame: data.readUInt32LE(24),
    frames,
  };
}

/** Builds an audio packet (used by the device simulator and tests). */
export function buildAudioPacket(sessionId: string, seq: number, firstFrame: number, frames: Buffer[]): Buffer {
  const body = Buffer.concat(frames.flatMap((f) => {
    const len = Buffer.alloc(2);
    len.writeUInt16LE(f.length);
    return [len, f];
  }));
  const header = Buffer.alloc(PACKET_HEADER_BYTES);
  header.write(PACKET_MAGIC, 0, 'latin1');
  Buffer.from(sessionId, 'hex').copy(header, 4);
  header.writeUInt32LE(seq, 20);
  header.writeUInt32LE(firstFrame, 24);
  header.writeUInt8(frames.length, 28);
  header.writeUInt32LE(crc32(body), 32);
  return Buffer.concat([header, body]);
}

/** Topic helpers. The device ID comes only from the topic, which the broker ACL binds to the account. */
export const recordingTopics = (deviceId: string) => ({
  request: `devices/${deviceId}/recording/request`,
  audio: `devices/${deviceId}/recording/audio`,
  ack: `devices/${deviceId}/recording/ack`,
});

export function parseRecordingTopic(topic: string): { deviceId: string; kind: 'request' | 'audio' } | null {
  const m = /^devices\/([^/]+)\/recording\/(request|audio)$/.exec(topic);
  if (!m || !deviceIdSchema.safeParse(m[1]).success) return null;
  return { deviceId: m[1]!, kind: m[2] as 'request' | 'audio' };
}
