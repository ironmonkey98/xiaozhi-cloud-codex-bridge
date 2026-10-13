import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildAudioPacket, MAX_PACKET_BYTES, PACKET_HEADER_BYTES, parseAudioPacket, parseRecordingTopic, requestSchema,
} from '../../src/recording/protocol.ts';

const SID = 'ab'.repeat(16);
const frames = [Buffer.from([1, 2, 3]), Buffer.alloc(0), Buffer.from([9])];

test('audio packet round-trips with zero-length DTX frames', () => {
  const packet = parseAudioPacket(buildAudioPacket(SID, 7, 120, frames));
  assert.notEqual(typeof packet, 'string');
  if (typeof packet === 'string') return;
  assert.equal(packet.sessionId, SID);
  assert.equal(packet.seq, 7);
  assert.equal(packet.firstFrame, 120);
  assert.deepEqual(packet.frames.map((f) => [...f]), [[1, 2, 3], [], [9]]);
});

test('audio packet rejects corruption, bad framing and oversize data', () => {
  const good = buildAudioPacket(SID, 0, 0, frames);
  const flip = (offset: number) => {
    const b = Buffer.from(good);
    b[offset]! ^= 0xff;
    return b;
  };
  assert.equal(parseAudioPacket(flip(0)), 'bad magic');
  assert.equal(parseAudioPacket(flip(PACKET_HEADER_BYTES + 3)), 'crc mismatch');
  assert.equal(parseAudioPacket(flip(29)), 'reserved bits set');
  assert.equal(parseAudioPacket(good.subarray(0, 20)), 'short packet');
  assert.equal(parseAudioPacket(buildAudioPacket(SID, 0, 0, [Buffer.alloc(MAX_PACKET_BYTES)])), 'packet too large');
  assert.equal(parseAudioPacket(buildAudioPacket(SID, 0, 0, [])), 'bad frame count');
  assert.equal(parseAudioPacket(buildAudioPacket(SID, 0, 0, Array.from({ length: 17 }, () => Buffer.alloc(0)))),
    'bad frame count');
  // A frame count that claims more frames than the body holds.
  const lying = Buffer.from(good);
  lying.writeUInt8(4, 28);
  assert.equal(parseAudioPacket(lying), 'truncated frame header');
});

test('topics carry only a well-formed device ID and known kinds', () => {
  assert.deepEqual(parseRecordingTopic('devices/passport-01/recording/audio'), { deviceId: 'passport-01', kind: 'audio' });
  assert.deepEqual(parseRecordingTopic('devices/passport-01/recording/request'), { deviceId: 'passport-01', kind: 'request' });
  for (const t of ['devices/passport-01/recording/ack', 'devices/../recording/audio', 'devices/A/recording/audio',
    'devices/passport-01/notify/x', 'devices/passport-01/recording/audio/extra']) {
    assert.equal(parseRecordingTopic(t), null, t);
  }
});

test('control messages are strict', () => {
  const start = { v: 1, type: 'start', request_id: 'c'.repeat(32), max_duration_s: 3600,
    format: { codec: 'opus', sample_rate: 16000, channels: 1, frame_ms: 60, dtx: true } };
  assert.equal(requestSchema.safeParse(start).success, true);
  assert.equal(requestSchema.safeParse({ ...start, path: '/etc' }).success, false);
  assert.equal(requestSchema.safeParse({ ...start, format: { ...start.format, sample_rate: 48000 } }).success, false);
  assert.equal(requestSchema.safeParse({ ...start, request_id: 'x' }).success, false);
  const stop = { v: 1, type: 'stop', session_id: SID, last_seq: -1, frames: 0, duration_ms: 0, dropped_frames: 0, reason: 'user' };
  assert.equal(requestSchema.safeParse(stop).success, true);
  assert.equal(requestSchema.safeParse({ ...stop, reason: 'because' }).success, false);
});
