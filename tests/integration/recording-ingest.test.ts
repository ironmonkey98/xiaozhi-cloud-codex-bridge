import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { RecordingIngest } from '../../src/recording/ingest.ts';
import { type AckMessage, buildAudioPacket } from '../../src/recording/protocol.ts';
import type { FinalizeResult } from '../../src/recording/session.ts';

const DEV = 'passport-01';
const REQ = `devices/${DEV}/recording/request`;
const AUDIO = `devices/${DEV}/recording/audio`;
const FORMAT = { codec: 'opus', sample_rate: 16000, channels: 1, frame_ms: 60, dtx: true };

/** Reads frames.bin back, checks strict ordering and reports gaps like finalize.py would. */
function readFrames(sessionDir: string): { index: number; bytes: number[] }[] {
  const data = readFileSync(join(sessionDir, 'frames.bin'));
  const out: { index: number; bytes: number[] }[] = [];
  for (let at = 0; at < data.length;) {
    const index = data.readUInt32LE(at);
    const len = data.readUInt16LE(at + 4);
    out.push({ index, bytes: [...data.subarray(at + 6, at + 6 + len)] });
    at += 6 + len;
  }
  return out;
}

async function fakeFinalize(sessionDir: string): Promise<FinalizeResult> {
  const frames = readFrames(sessionDir);
  let missing = 0;
  let expect = 0;
  for (const f of frames) {
    assert.ok(f.index >= expect, 'frame indexes must increase');
    missing += f.index - expect;
    expect = f.index + 1;
  }
  return { ok: true, path: `${sessionDir}.ogg`, duration_ms: expect * 60, frames_total: expect,
    frames_missing: missing, missing_ranges: [] };
}

function setup(opts: { finalize?: (dir: string) => Promise<FinalizeResult>; minFreeBytes?: number; dataDir?: string } = {}) {
  let now = 1_000_000;
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'rec-ingest-'));
  const sent: AckMessage[] = [];
  const ingest = new RecordingIngest({
    dataDir, allowedDevices: new Set([DEV]),
    publish: (device, msg) => { assert.equal(device, DEV); sent.push(msg); },
    finalize: (dir) => (opts.finalize ?? fakeFinalize)(dir),
    now: () => now, minFreeBytes: opts.minFreeBytes ?? 0,
    stopGraceMs: 15_000, idleTimeoutMs: 120_000, ackIntervalMs: 1000, ackEveryPackets: 8,
  });
  const json = (msg: object) => Buffer.from(JSON.stringify(msg));
  const api = {
    dataDir, ingest, sent,
    advance: (ms: number) => { now += ms; ingest.tick(); },
    start: (requestId = 'a'.repeat(32), maxDurationS = 3600) => {
      ingest.handleMessage(REQ, json({ v: 1, type: 'start', request_id: requestId, format: FORMAT, max_duration_s: maxDurationS }));
      return sent.at(-1)!;
    },
    /** Sends packet `seq` holding `count` frames starting at `firstFrame`; frame bytes encode the index. */
    audio: (sid: string, seq: number, firstFrame: number, count = 4) => {
      const frames = Array.from({ length: count }, (_, i) => Buffer.from([(firstFrame + i) & 0xff, 0x42]));
      ingest.handleMessage(AUDIO, buildAudioPacket(sid, seq, firstFrame, frames));
    },
    stop: (sid: string, lastSeq: number, frames: number, dropped = 0) => {
      ingest.handleMessage(REQ, json({ v: 1, type: 'stop', session_id: sid, last_seq: lastSeq, frames,
        duration_ms: frames * 60, dropped_frames: dropped, reason: 'user' }));
    },
    lastAck: () => [...sent].reverse().find((m) => m.type === 'chunk_ack') as Extract<AckMessage, { type: 'chunk_ack' }> | undefined,
    finish: async () => {
      await ingest.settle();
      return sent.findLast((m) => m.type === 'finish_ack') as Extract<AckMessage, { type: 'finish_ack' }> | undefined;
    },
    meta: (sid: string) => JSON.parse(readFileSync(join(dataDir, 'sessions', sid, 'meta.json'), 'utf8')),
  };
  return api;
}

const sidOf = (msg: AckMessage) => {
  assert.equal(msg.type, 'start_ack');
  return (msg as Extract<AckMessage, { type: 'start_ack' }>).session_id;
};

describe('recording ingest', () => {
  it('stores ordered frames, acknowledges persisted packets and saves a complete session', async () => {
    const t = setup();
    const sid = sidOf(t.start());
    for (let seq = 0; seq < 10; seq++) t.audio(sid, seq, seq * 4);
    assert.equal(t.lastAck()?.persisted_seq, 7, 'ACK after 8 packets');
    t.advance(1000);
    assert.deepEqual(t.lastAck(), { v: 1, type: 'chunk_ack', session_id: sid, persisted_seq: 9, frames: 40 });
    t.stop(sid, 9, 40);
    const done = await t.finish();
    assert.deepEqual(done, { v: 1, type: 'finish_ack', session_id: sid, state: 'saved', recording_id: sid,
      duration_ms: 2400, missing_frames: 0 });
    const frames = readFrames(join(t.dataDir, 'sessions', sid));
    assert.deepEqual(frames.map((f) => f.index), Array.from({ length: 40 }, (_, i) => i));
    assert.equal(t.meta(sid).state, 'saved');
  });

  it('makes start idempotent per request and allows one session per device', () => {
    const t = setup();
    const first = sidOf(t.start('a'.repeat(32)));
    assert.equal(sidOf(t.start('a'.repeat(32))), first);
    assert.deepEqual(t.start('b'.repeat(32)), { v: 1, type: 'error', code: 'busy', request_id: 'b'.repeat(32) });
  });

  it('drops duplicates and packets after a gap, then accepts the retransmission (Go-Back-N)', async () => {
    const t = setup();
    const sid = sidOf(t.start());
    t.audio(sid, 0, 0);
    t.audio(sid, 0, 0); // duplicate
    assert.equal(t.lastAck()?.persisted_seq, 0);
    t.audio(sid, 2, 8); // seq 1 lost
    assert.equal(t.lastAck()?.persisted_seq, 0);
    t.audio(sid, 1, 4);
    t.audio(sid, 2, 8);
    t.stop(sid, 2, 12);
    assert.equal((await t.finish())?.state, 'saved');
    assert.deepEqual(readFrames(join(t.dataDir, 'sessions', sid)).map((f) => f.index),
      Array.from({ length: 12 }, (_, i) => i));
  });

  it('waits for retransmissions after stop, then saves', async () => {
    const t = setup();
    const sid = sidOf(t.start());
    t.audio(sid, 0, 0);
    t.stop(sid, 1, 8);
    assert.equal(t.lastAck()?.persisted_seq, 0, 'stop answers with the resume point');
    t.advance(5000);
    assert.equal(t.sent.some((m) => m.type === 'finish_ack'), false);
    t.audio(sid, 1, 4);
    assert.equal((await t.finish())?.state, 'saved');
  });

  it('closes as partial when the stop grace period runs out with packets missing', async () => {
    const t = setup();
    const sid = sidOf(t.start());
    t.audio(sid, 0, 0);
    t.stop(sid, 3, 16);
    t.advance(15_000);
    const done = await t.finish();
    assert.equal(done?.state, 'partial');
    assert.equal(t.meta(sid).end_cause, 'stop_grace_expired');
  });

  it('reports device-side frame gaps and dropped frames as partial, never saved', async () => {
    const t = setup();
    const sid = sidOf(t.start());
    t.audio(sid, 0, 0);
    t.audio(sid, 1, 10); // frames 4..9 never left the device
    t.stop(sid, 1, 8, 6);
    const done = await t.finish();
    assert.equal(done?.state, 'partial');
    assert.equal(done?.missing_frames, 6);
  });

  it('closes an abandoned session as partial after the idle timeout', async () => {
    const t = setup();
    const sid = sidOf(t.start());
    t.audio(sid, 0, 0);
    t.advance(119_000);
    assert.equal(t.sent.some((m) => m.type === 'finish_ack'), false);
    t.advance(1000);
    assert.equal((await t.finish())?.state, 'partial');
    assert.equal(t.meta(sid).end_cause, 'idle_timeout');
  });

  it('fails a session without audio and answers a repeated stop with the same result', async () => {
    const t = setup();
    const sid = sidOf(t.start());
    t.stop(sid, -1, 0);
    const done = await t.finish();
    assert.deepEqual(done, { v: 1, type: 'finish_ack', session_id: sid, state: 'failed', recording_id: null,
      duration_ms: 0, missing_frames: 0 });
    t.stop(sid, -1, 0);
    assert.deepEqual(t.sent.at(-1), done);
  });

  it('marks the session failed when finalize fails', async () => {
    const t = setup({ finalize: async () => ({ ok: false, error: 'ffprobe failed' }) });
    const sid = sidOf(t.start());
    t.audio(sid, 0, 0);
    t.stop(sid, 0, 4);
    const done = await t.finish();
    assert.equal(done?.state, 'failed');
    assert.equal(done?.recording_id, null);
    assert.equal(t.meta(sid).result.error, 'ffprobe failed');
  });

  it('rejects corrupt packets without moving the ACK, and frame indexes that go back', () => {
    const t = setup();
    const sid = sidOf(t.start());
    t.audio(sid, 0, 0);
    const corrupt = buildAudioPacket(sid, 1, 4, [Buffer.from([1, 2])]);
    corrupt[corrupt.length - 1]! ^= 0xff;
    t.ingest.handleMessage(AUDIO, corrupt);
    t.audio(sid, 1, 2); // overlaps frames already stored
    t.advance(1000);
    assert.equal(t.lastAck()?.persisted_seq, 0);
    assert.equal(t.meta(sid).frames_persisted, 4);
  });

  it('ignores devices outside the allowlist and answers unknown sessions', () => {
    const t = setup();
    t.ingest.handleMessage('devices/other/recording/request', Buffer.from('{}'));
    assert.equal(t.sent.length, 0);
    t.audio('cd'.repeat(16), 0, 0);
    assert.deepEqual(t.sent.at(-1), { v: 1, type: 'error', code: 'unknown_session', session_id: 'cd'.repeat(16) });
  });

  it('refuses to start without disk space and stops a session that runs too long', async () => {
    assert.equal((setup({ minFreeBytes: Number.MAX_SAFE_INTEGER }).start() as { code?: string }).code, 'no_space');
    const t = setup();
    const sid = sidOf(t.start('a'.repeat(32), 1)); // 1 s = 16 frames
    t.audio(sid, 0, 0, 16);
    t.audio(sid, 1, 16, 1);
    assert.deepEqual(t.sent.find((m) => m.type === 'error'), { v: 1, type: 'error', code: 'too_long', session_id: sid });
    assert.equal((await t.finish())?.state, 'partial');
  });

  it('recovers after a restart: drops unacknowledged bytes and continues the session', async () => {
    const t = setup();
    const sid = sidOf(t.start());
    t.audio(sid, 0, 0);
    t.audio(sid, 1, 4);
    t.ingest.close();
    // Crash between the frame write and the meta update: bytes that were never acknowledged.
    appendFileSync(join(t.dataDir, 'sessions', sid, 'frames.bin'), Buffer.from([7, 0, 0, 0, 2, 0, 1, 1]));
    const again = setup({ dataDir: t.dataDir });
    again.ingest.recover();
    again.audio(sid, 1, 4); // duplicate of what was persisted
    assert.equal(again.lastAck()?.persisted_seq, 1);
    again.audio(sid, 2, 8);
    again.stop(sid, 2, 12);
    assert.equal((await again.finish())?.state, 'saved');
    assert.deepEqual(readFrames(join(t.dataDir, 'sessions', sid)).map((f) => f.index),
      Array.from({ length: 12 }, (_, i) => i));
  });
});
