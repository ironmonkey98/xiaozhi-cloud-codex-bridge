// One recording session on disk: <data_dir>/sessions/<id>/{meta.json,frames.bin}.
// Frames are appended and fsynced before meta.json is replaced, and meta.json is
// what acknowledgements are based on, so an ACK never runs ahead of the disk.
import { randomBytes } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, renameSync,
  writeFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type { FinishState, RecordingFormat, StopMessage } from './protocol.ts';

export type SessionState = 'receiving' | 'finishing' | FinishState;

export interface FinalizeResult {
  ok: boolean;
  path?: string;
  duration_ms?: number;
  frames_total?: number;
  frames_audio?: number;
  frames_dtx?: number;
  frames_missing?: number;
  missing_ranges?: [number, number][];
  error?: string;
}

export interface SessionMeta {
  version: 1;
  session_id: string;
  device_id: string;
  request_id: string;
  created_at: string;
  format: RecordingFormat;
  max_duration_s: number;
  state: SessionState;
  persisted_seq: number;
  frames_persisted: number;
  last_frame_index: number;
  /** Bytes of frames.bin covered by this meta; anything after it was never acknowledged. */
  frames_bytes: number;
  stop: Omit<StopMessage, 'v' | 'type' | 'session_id'> | null;
  /** Why the session ended without a complete stop, if it did. */
  end_cause: 'stop' | 'stop_grace_expired' | 'idle_timeout' | 'too_long' | null;
  result: (FinalizeResult & { state: FinishState }) | null;
}

export class RecordingSession {
  readonly dir: string;
  meta: SessionMeta;
  private fd: number | null = null;

  private constructor(dir: string, meta: SessionMeta) {
    this.dir = dir;
    this.meta = meta;
  }

  static create(dataDir: string, deviceId: string, requestId: string, format: RecordingFormat,
    maxDurationS: number, now: number): RecordingSession {
    const id = randomBytes(16).toString('hex');
    const dir = join(dataDir, 'sessions', id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const session = new RecordingSession(dir, {
      version: 1, session_id: id, device_id: deviceId, request_id: requestId,
      created_at: new Date(now).toISOString(), format, max_duration_s: maxDurationS,
      state: 'receiving', persisted_seq: -1, frames_persisted: 0, last_frame_index: -1, frames_bytes: 0,
      stop: null, end_cause: null, result: null,
    });
    writeFileSync(join(dir, 'frames.bin'), '', { mode: 0o600 });
    session.save();
    return session;
  }

  /** Loads a session and drops any frame bytes written after the last saved meta. */
  static load(dir: string): RecordingSession {
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as SessionMeta;
    const session = new RecordingSession(dir, meta);
    if (meta.state === 'receiving' || meta.state === 'finishing') {
      const fd = openSync(join(dir, 'frames.bin'), 'r+');
      try {
        ftruncateSync(fd, meta.frames_bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    return session;
  }

  get id(): string {
    return this.meta.session_id;
  }

  /** Appends a packet's frames (already validated as next-in-order) and persists them. */
  append(seq: number, firstFrame: number, frames: Buffer[]): void {
    this.fd ??= openSync(join(this.dir, 'frames.bin'), 'a');
    const records = frames.map((frame, i) => {
      const head = Buffer.alloc(6);
      head.writeUInt32LE(firstFrame + i, 0);
      head.writeUInt16LE(frame.length, 4);
      return Buffer.concat([head, frame]);
    });
    const data = Buffer.concat(records);
    writeSync(this.fd, data);
    fsyncSync(this.fd);
    this.meta.persisted_seq = seq;
    this.meta.frames_persisted += frames.length;
    this.meta.last_frame_index = firstFrame + frames.length - 1;
    this.meta.frames_bytes += data.length;
    this.save();
  }

  /** Replaces meta.json atomically. */
  save(): void {
    const tmp = join(this.dir, 'meta.json.tmp');
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, JSON.stringify(this.meta, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, join(this.dir, 'meta.json'));
  }

  closeFile(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }
}

export function sessionDir(dataDir: string, sessionId: string): string {
  return join(dataDir, 'sessions', sessionId);
}

export function sessionExists(dataDir: string, sessionId: string): boolean {
  return /^[a-f0-9]{32}$/.test(sessionId) && existsSync(join(sessionDir(dataDir, sessionId), 'meta.json'));
}
