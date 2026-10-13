// Simulated AI Passport recorder: sends real Opus frames from a fixture over MQTT
// with the device-side rules of docs/RECORDING_PROTOCOL.md (bounded window, ACK,
// Go-Back-N retransmission), then stops and waits for finish_ack.
//
// node scripts/recording-sim.ts --url mqtt://127.0.0.1:1883 --device passport-01 \
//   --fixture fixture.bin [--username u --password p] [--drop-rate 0.05] [--realtime]
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { connect } from 'mqtt';
import {
  type AckMessage, buildAudioPacket, FRAME_MS, MAX_FRAMES_PER_PACKET, MAX_PACKET_BYTES, PACKET_HEADER_BYTES,
  recordingTopics,
} from '../src/recording/protocol.ts';

export interface SimOptions {
  url: string;
  device: string;
  frames: { index: number; data: Buffer }[];
  username?: string;
  password?: string;
  dropRate?: number;
  realtime?: boolean;
  /** Bytes of unacknowledged packets the device may hold (its RAM queue). */
  windowBytes?: number;
  retransmitMs?: number;
  timeoutMs?: number;
  log?: (event: Record<string, unknown>) => void;
}

export interface SimResult {
  start: AckMessage | null;
  finish: AckMessage | null;
  packets: number;
  sends: number;
  dropped_by_sim: number;
}

/** Reads a frames.bin-style fixture: u32 frame_index | u16 len | bytes. */
export function readFixture(path: string): { index: number; data: Buffer }[] {
  const buf = readFileSync(path);
  const frames: { index: number; data: Buffer }[] = [];
  for (let at = 0; at < buf.length;) {
    const len = buf.readUInt16LE(at + 4);
    frames.push({ index: buf.readUInt32LE(at), data: buf.subarray(at + 6, at + 6 + len) });
    at += 6 + len;
  }
  return frames;
}

/** Groups consecutive frames into packets within the byte and frame-count limits. */
export function packetize(frames: { index: number; data: Buffer }[]): { firstFrame: number; frames: Buffer[] }[] {
  const packets: { firstFrame: number; frames: Buffer[] }[] = [];
  let cur: { firstFrame: number; frames: Buffer[] } | null = null;
  let size = 0;
  let next = -1;
  for (const f of frames) {
    const add = 2 + f.data.length;
    if (!cur || f.index !== next || cur.frames.length >= MAX_FRAMES_PER_PACKET ||
      PACKET_HEADER_BYTES + size + add > MAX_PACKET_BYTES) {
      cur = { firstFrame: f.index, frames: [] };
      packets.push(cur);
      size = 0;
    }
    cur.frames.push(f.data);
    size += add;
    next = f.index + 1;
  }
  return packets;
}

export async function runSimulation(o: SimOptions): Promise<SimResult> {
  const log = o.log ?? (() => {});
  const topics = recordingTopics(o.device);
  const client = connect(o.url, { username: o.username, password: o.password, reconnectPeriod: 0, connectTimeout: 5000 });
  const inbox: AckMessage[] = [];
  let wake: (() => void) | null = null;
  client.on('message', (_t, payload) => {
    inbox.push(JSON.parse(payload.toString()) as AckMessage);
    wake?.();
  });
  await new Promise<void>((resolve, reject) => {
    client.once('connect', () => resolve());
    client.once('error', reject);
  });
  await client.subscribeAsync(topics.ack, { qos: 1 });

  const deadline = Date.now() + (o.timeoutMs ?? 60_000);
  const waitFor = async <T extends AckMessage['type']>(type: T, retry?: () => void): Promise<Extract<AckMessage, { type: T }>> => {
    while (Date.now() < deadline) {
      const i = inbox.findIndex((m) => m.type === type || m.type === 'error');
      if (i >= 0) {
        const m = inbox.splice(i, 1)[0]!;
        if (m.type === 'error') throw new Error(`device got error ${m.code}`);
        return m as Extract<AckMessage, { type: T }>;
      }
      await new Promise<void>((r) => { wake = r; setTimeout(r, 1000); });
      retry?.();
    }
    throw new Error(`timeout waiting for ${type}`);
  };

  const result: SimResult = { start: null, finish: null, packets: 0, sends: 0, dropped_by_sim: 0 };
  try {
    const requestId = randomBytes(16).toString('hex');
    const start = JSON.stringify({ v: 1, type: 'start', request_id: requestId, max_duration_s: 7200,
      format: { codec: 'opus', sample_rate: 16000, channels: 1, frame_ms: FRAME_MS, dtx: true } });
    await client.publishAsync(topics.request, start, { qos: 1 });
    const startAck = await waitFor('start_ack', () => void client.publishAsync(topics.request, start, { qos: 1 }));
    result.start = startAck;
    const sid = startAck.session_id;
    log({ event: 'recording', session_id: sid });

    const plan = packetize(o.frames);
    const packets = plan.map((p, seq) => buildAudioPacket(sid, seq, p.firstFrame, p.frames));
    result.packets = packets.length;
    const windowBytes = o.windowBytes ?? 12 * 1024;
    const retransmitMs = o.retransmitMs ?? 3000;
    let acked = -1;
    let nextSeq = 0;
    let lastProgress = Date.now();
    const t0 = Date.now();
    const send = (seq: number) => {
      result.sends++;
      if (Math.random() < (o.dropRate ?? 0)) { result.dropped_by_sim++; return; }
      client.publish(topics.audio, packets[seq]!, { qos: 0 });
    };
    const drainAcks = () => {
      for (let i = inbox.length - 1; i >= 0; i--) {
        const m = inbox[i]!;
        if (m.type === 'chunk_ack' && m.session_id === sid) {
          inbox.splice(i, 1);
          if (m.persisted_seq > acked) { acked = m.persisted_seq; lastProgress = Date.now(); }
        }
      }
    };
    while (acked < packets.length - 1) {
      if (Date.now() > deadline) throw new Error('timeout while sending');
      drainAcks();
      let inFlight = 0;
      for (let s = acked + 1; s < nextSeq; s++) inFlight += packets[s]!.length;
      if (nextSeq < packets.length && inFlight + packets[nextSeq]!.length <= windowBytes) {
        if (o.realtime) {
          // A packet can leave only after its last frame was captured.
          const p = plan[nextSeq]!;
          const due = t0 + (p.firstFrame + p.frames.length) * FRAME_MS;
          if (Date.now() < due) { await new Promise((r) => setTimeout(r, Math.min(50, due - Date.now()))); continue; }
        }
        send(nextSeq++);
        continue;
      }
      if (Date.now() - lastProgress >= retransmitMs) {
        log({ event: 'retransmit', from: acked + 1, to: nextSeq - 1 });
        for (let s = acked + 1; s < nextSeq; s++) send(s);
        lastProgress = Date.now();
      }
      await new Promise<void>((r) => { wake = r; setTimeout(r, 50); });
    }
    const frames = o.frames.length;
    const stop = JSON.stringify({ v: 1, type: 'stop', session_id: sid, last_seq: packets.length - 1, frames,
      duration_ms: o.frames.length ? (o.frames.at(-1)!.index + 1) * FRAME_MS : 0, dropped_frames: 0, reason: 'user' });
    await client.publishAsync(topics.request, stop, { qos: 1 });
    result.finish = await waitFor('finish_ack');
    return result;
  } finally {
    await client.endAsync();
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: {
    url: { type: 'string' }, device: { type: 'string' }, fixture: { type: 'string' },
    username: { type: 'string' }, password: { type: 'string' },
    'drop-rate': { type: 'string' }, realtime: { type: 'boolean' },
  } });
  if (!values.url || !values.device || !values.fixture) {
    console.error('usage: --url <mqtt url> --device <id> --fixture <frames file> [--username --password --drop-rate --realtime]');
    process.exit(2);
  }
  const result = await runSimulation({
    url: values.url, device: values.device, frames: readFixture(values.fixture),
    username: values.username ?? process.env.RECORDING_SIM_USERNAME,
    password: values.password ?? process.env.RECORDING_SIM_PASSWORD,
    dropRate: values['drop-rate'] ? Number(values['drop-rate']) : 0, realtime: values.realtime,
    log: (e) => console.log(JSON.stringify(e)),
  });
  console.log(JSON.stringify(result));
}
