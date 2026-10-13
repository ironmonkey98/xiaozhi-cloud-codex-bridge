// Recording ingest: device sessions, ordered persistence, cumulative ACKs and finalization.
// Transport-agnostic: main.ts wires it to MQTT; tests drive it directly.
import { mkdirSync, readdirSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AckMessage, type ErrorCode, type FinishState, type StopMessage, FRAME_MS, MAX_PACKET_BYTES,
  parseAudioPacket, parseRecordingTopic, requestSchema,
} from './protocol.ts';
import { type FinalizeResult, RecordingSession, sessionDir, sessionExists } from './session.ts';

export interface IngestOptions {
  dataDir: string;
  allowedDevices: ReadonlySet<string>;
  publish: (deviceId: string, message: AckMessage) => void;
  finalize: (sessionDir: string, outDir: string) => Promise<FinalizeResult>;
  now?: () => number;
  log?: (event: Record<string, unknown>) => void;
  /** Refuse new sessions below this much free disk space. */
  minFreeBytes?: number;
  /** After stop, how long to wait for retransmitted packets. */
  stopGraceMs?: number;
  /** A session with no packets and no stop for this long is closed as partial. */
  idleTimeoutMs?: number;
  ackIntervalMs?: number;
  ackEveryPackets?: number;
}

interface Active {
  session: RecordingSession;
  lastPacketAt: number;
  lastAckAt: number;
  packetsSinceAck: number;
  stopDeadline: number | null;
  finalizing: boolean;
}

export class RecordingIngest {
  private readonly opts: Required<Omit<IngestOptions, 'log'>> & Pick<IngestOptions, 'log'>;
  private readonly active = new Map<string, Active>(); // by device ID
  private readonly pending = new Set<Promise<void>>();

  constructor(options: IngestOptions) {
    this.opts = {
      now: Date.now,
      minFreeBytes: 200 * 1024 * 1024,
      stopGraceMs: 15_000,
      idleTimeoutMs: 120_000,
      ackIntervalMs: 1000,
      ackEveryPackets: 8,
      ...options,
    };
    // statfs needs an existing directory; a missing one must not read as "disk full".
    mkdirSync(join(this.opts.dataDir, 'sessions'), { recursive: true, mode: 0o700 });
    mkdirSync(this.recordingsDir, { recursive: true, mode: 0o700 });
  }

  get recordingsDir(): string {
    return join(this.opts.dataDir, 'recordings');
  }

  /** Resumes sessions left open by a restart: receiving ones keep accepting, finishing ones are finalized. */
  recover(): void {
    let ids: string[] = [];
    try {
      ids = readdirSync(join(this.opts.dataDir, 'sessions'));
    } catch {
      return;
    }
    const now = this.opts.now();
    for (const id of ids) {
      if (!sessionExists(this.opts.dataDir, id)) continue;
      const session = RecordingSession.load(sessionDir(this.opts.dataDir, id));
      const { state, device_id: deviceId } = session.meta;
      if (state !== 'receiving' && state !== 'finishing') continue;
      if (this.active.has(deviceId)) {
        // Only one session per device; the older one cannot continue.
        this.track(this.finish({ session, lastPacketAt: now, lastAckAt: now, packetsSinceAck: 0,
          stopDeadline: null, finalizing: false }, 'idle_timeout'));
        continue;
      }
      const entry: Active = { session, lastPacketAt: now, lastAckAt: now, packetsSinceAck: 0,
        stopDeadline: session.meta.stop ? now + this.opts.stopGraceMs : null, finalizing: false };
      this.active.set(deviceId, entry);
      this.log({ event: 'session_recovered', session_id: id, device: deviceId, state });
      if (state === 'finishing') this.track(this.finish(entry, session.meta.end_cause ?? 'stop'));
    }
  }

  handleMessage(topic: string, payload: Buffer): void {
    const parsed = parseRecordingTopic(topic);
    if (!parsed || !this.opts.allowedDevices.has(parsed.deviceId)) {
      this.log({ event: 'message_rejected', reason: 'topic' });
      return;
    }
    if (parsed.kind === 'audio') this.onAudio(parsed.deviceId, payload);
    else this.onRequest(parsed.deviceId, payload);
  }

  /** Periodic work: delayed ACKs, stop grace and idle timeouts. Call about once a second. */
  tick(): void {
    const now = this.opts.now();
    for (const entry of this.active.values()) {
      if (entry.finalizing) continue;
      if (entry.packetsSinceAck > 0 && now - entry.lastAckAt >= this.opts.ackIntervalMs) this.ack(entry);
      if (entry.stopDeadline !== null && now >= entry.stopDeadline) {
        this.track(this.finish(entry, 'stop_grace_expired'));
      } else if (entry.stopDeadline === null && now - entry.lastPacketAt >= this.opts.idleTimeoutMs) {
        this.track(this.finish(entry, 'idle_timeout'));
      }
    }
  }

  /** Resolves when no finalization is running (for tests and shutdown). */
  async settle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  close(): void {
    for (const entry of this.active.values()) entry.session.closeFile();
  }

  private onRequest(deviceId: string, payload: Buffer): void {
    if (payload.length > 512) return this.log({ event: 'request_rejected', reason: 'too large' });
    let message;
    try {
      message = requestSchema.safeParse(JSON.parse(payload.toString('utf8')));
    } catch {
      message = null;
    }
    if (!message?.success) {
      this.log({ event: 'request_rejected', device: deviceId, reason: 'schema' });
      return this.send(deviceId, { v: 1, type: 'error', code: 'bad_request' });
    }
    const msg = message.data;
    if (msg.type === 'start') {
      const current = this.active.get(deviceId);
      if (current) {
        if (current.session.meta.request_id === msg.request_id && !current.finalizing) {
          return this.send(deviceId, this.startAck(current.session));
        }
        return this.error(deviceId, 'busy', { request_id: msg.request_id });
      }
      if (!this.hasFreeSpace()) return this.error(deviceId, 'no_space', { request_id: msg.request_id });
      const now = this.opts.now();
      const session = RecordingSession.create(this.opts.dataDir, deviceId, msg.request_id, msg.format,
        msg.max_duration_s, now);
      this.active.set(deviceId, { session, lastPacketAt: now, lastAckAt: now, packetsSinceAck: 0,
        stopDeadline: null, finalizing: false });
      this.log({ event: 'session_started', session_id: session.id, device: deviceId });
      return this.send(deviceId, this.startAck(session));
    }
    this.onStop(deviceId, msg);
  }

  private onStop(deviceId: string, msg: StopMessage): void {
    const entry = this.active.get(deviceId);
    if (!entry || entry.session.id !== msg.session_id) {
      // A repeated stop after the session ended gets the same answer again.
      if (sessionExists(this.opts.dataDir, msg.session_id)) {
        const done = RecordingSession.load(sessionDir(this.opts.dataDir, msg.session_id));
        if (done.meta.device_id === deviceId && done.meta.result) return this.send(deviceId, finishAck(done));
      }
      return this.error(deviceId, 'unknown_session', { session_id: msg.session_id });
    }
    if (entry.finalizing) return;
    const { v: _v, type: _t, session_id: _s, ...stop } = msg;
    entry.session.meta.stop = stop;
    entry.session.save();
    this.log({ event: 'stop_received', session_id: msg.session_id, last_seq: msg.last_seq,
      persisted_seq: entry.session.meta.persisted_seq, reason: msg.reason });
    if (entry.session.meta.persisted_seq >= msg.last_seq) {
      this.track(this.finish(entry, 'stop'));
    } else {
      entry.stopDeadline = this.opts.now() + this.opts.stopGraceMs;
      this.ack(entry); // tells the device where to resume
    }
  }

  private onAudio(deviceId: string, payload: Buffer): void {
    const packet = parseAudioPacket(payload);
    if (typeof packet === 'string') {
      this.log({ event: 'packet_rejected', device: deviceId, reason: packet });
      return;
    }
    const entry = this.active.get(deviceId);
    if (!entry || entry.session.id !== packet.sessionId) {
      return this.error(deviceId, 'unknown_session', { session_id: packet.sessionId });
    }
    if (entry.finalizing) return;
    const meta = entry.session.meta;
    entry.lastPacketAt = this.opts.now();
    if (packet.seq !== meta.persisted_seq + 1) {
      // Duplicate or ahead of a gap (Go-Back-N): drop it and tell the device what we have.
      this.log({ event: packet.seq <= meta.persisted_seq ? 'packet_duplicate' : 'packet_out_of_order',
        session_id: meta.session_id, seq: packet.seq, persisted_seq: meta.persisted_seq });
      return this.ack(entry);
    }
    if (packet.firstFrame <= meta.last_frame_index) {
      this.log({ event: 'packet_rejected', session_id: meta.session_id, seq: packet.seq, reason: 'frame index went back' });
      return;
    }
    const endFrame = packet.firstFrame + packet.frames.length;
    if (endFrame * FRAME_MS > meta.max_duration_s * 1000) {
      this.error(deviceId, 'too_long', { session_id: meta.session_id });
      this.track(this.finish(entry, 'too_long'));
      return;
    }
    entry.session.append(packet.seq, packet.firstFrame, packet.frames);
    entry.packetsSinceAck++;
    const stop = meta.stop;
    if (stop && meta.persisted_seq >= stop.last_seq) {
      this.ack(entry);
      this.track(this.finish(entry, 'stop'));
    } else if (entry.packetsSinceAck >= this.opts.ackEveryPackets ||
      this.opts.now() - entry.lastAckAt >= this.opts.ackIntervalMs) {
      this.ack(entry);
    }
  }

  private async finish(entry: Active, cause: NonNullable<RecordingSession['meta']['end_cause']>): Promise<void> {
    if (entry.finalizing) return;
    entry.finalizing = true;
    const { session } = entry;
    const meta = session.meta;
    session.closeFile();
    meta.state = 'finishing';
    meta.end_cause = cause;
    session.save();

    let result: FinalizeResult;
    if (meta.frames_persisted === 0) {
      result = { ok: false, error: 'no audio' };
    } else {
      try {
        result = await this.opts.finalize(session.dir, this.recordingsDir);
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    const state = finishState(meta, cause, result);
    meta.state = state;
    meta.result = { ...result, state };
    session.save();
    if (this.active.get(meta.device_id) === entry) this.active.delete(meta.device_id);
    this.log({ event: 'session_finished', session_id: meta.session_id, state, cause,
      frames: meta.frames_persisted, missing: result.frames_missing ?? null, error: result.error ?? null });
    this.send(meta.device_id, finishAck(session));
  }

  private ack(entry: Active): void {
    entry.packetsSinceAck = 0;
    entry.lastAckAt = this.opts.now();
    const { session_id, persisted_seq, frames_persisted } = entry.session.meta;
    this.send(entry.session.meta.device_id,
      { v: 1, type: 'chunk_ack', session_id, persisted_seq, frames: frames_persisted });
  }

  private startAck(session: RecordingSession): AckMessage {
    return { v: 1, type: 'start_ack', request_id: session.meta.request_id, session_id: session.id,
      max_packet_bytes: MAX_PACKET_BYTES };
  }

  private error(deviceId: string, code: ErrorCode, ids: { request_id?: string; session_id?: string }): void {
    this.send(deviceId, { v: 1, type: 'error', code, ...ids });
  }

  private send(deviceId: string, message: AckMessage): void {
    try {
      this.opts.publish(deviceId, message);
    } catch {
      this.log({ event: 'publish_failed', device: deviceId, type: message.type });
    }
  }

  private hasFreeSpace(): boolean {
    try {
      const fs = statfsSync(this.opts.dataDir);
      return fs.bavail * fs.bsize >= this.opts.minFreeBytes;
    } catch {
      return false;
    }
  }

  private track(work: Promise<void>): void {
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  }

  private log(event: Record<string, unknown>): void {
    this.opts.log?.(event);
  }
}

/** Protocol section 7. */
function finishState(meta: RecordingSession['meta'], cause: string, result: FinalizeResult): FinishState {
  if (!result.ok) return 'failed';
  const stop = meta.stop;
  const complete = cause === 'stop' && stop !== null && meta.persisted_seq === stop.last_seq &&
    stop.dropped_frames === 0 && stop.frames === meta.frames_persisted && (result.frames_missing ?? 1) === 0;
  return complete ? 'saved' : 'partial';
}

function finishAck(session: RecordingSession): AckMessage {
  const { session_id, result } = session.meta;
  const ok = result?.ok === true;
  return {
    v: 1, type: 'finish_ack', session_id,
    state: result?.state ?? 'failed',
    recording_id: ok ? session_id : null,
    duration_ms: ok ? result.duration_ms ?? 0 : 0,
    missing_frames: result?.frames_missing ?? 0,
  };
}
