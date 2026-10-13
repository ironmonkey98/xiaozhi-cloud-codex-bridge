// End to end on this machine: local Mosquitto + real src/recording/main.ts + simulated device
// sending real Opus frames + real finalize.py, checked with ffprobe/ffmpeg.
// Skips when mosquitto or the finalize venv is missing. Run: npm run test:recording
import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { readFixture, runSimulation } from '../../scripts/recording-sim.ts';
import { freePort } from '../helpers.ts';

const root = resolve(import.meta.dirname, '..', '..');
const finalizeDir = join(root, 'cloud/recording-ingest/finalize');
const python = join(finalizeDir, '.venv/bin/python');
const which = (cmd: string) => { try { return execFileSync('which', [cmd]).toString().trim(); } catch { return ''; } };
const mosquittoBin = existsSync('/opt/homebrew/sbin/mosquitto') ? '/opt/homebrew/sbin/mosquitto' : which('mosquitto');
const skip = !mosquittoBin ? 'mosquitto not installed' : !existsSync(python) ? 'finalize venv missing' : false;

describe('recording over MQTT', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-e2e-'));
  let broker: ChildProcess;
  let ingest: ChildProcess;
  let url = '';
  const ingestLog: string[] = [];

  before(async () => {
    const port = await freePort();
    url = `mqtt://127.0.0.1:${port}`;
    writeFileSync(join(dir, 'mosquitto.conf'), `listener ${port} 127.0.0.1\nallow_anonymous true\n`);
    broker = spawn(mosquittoBin, ['-c', join(dir, 'mosquitto.conf')], { stdio: 'ignore' });
    writeFileSync(join(dir, 'recording.json'), JSON.stringify({
      url, username: 'recording-ingest', password: 'x'.repeat(32), devices: ['passport-01'],
      data_dir: join(dir, 'data'), python, finalize_script: join(finalizeDir, 'finalize.py'),
    }));
    await delay(300);
    ingest = spawn(process.execPath, [join(root, 'src/recording/main.ts')], {
      env: { ...process.env, RECORDING_CONFIG: join(dir, 'recording.json') }, stdio: ['ignore', 'pipe', 'inherit'],
    });
    ingest.stdout!.on('data', (d: Buffer) => ingestLog.push(...d.toString().trim().split('\n')));
    for (let i = 0; i < 50 && !ingestLog.some((l) => l.includes('ingest_connected')); i++) await delay(100);
    assert.ok(ingestLog.some((l) => l.includes('ingest_connected')), 'ingest did not connect');
  });

  after(() => {
    ingest?.kill('SIGTERM');
    broker?.kill('SIGTERM');
  });

  const fixture = (seconds: number) => {
    const out = join(dir, `fixture-${seconds}.bin`);
    execFileSync(python, [join(finalizeDir, 'make_fixture.py'), '--seconds', String(seconds), '--out', out]);
    return readFixture(out);
  };

  const probe = (file: string) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json',
    '-show_streams', '-show_format', file]).toString()) as { streams: { codec_name: string; channels: number }[]; format: { duration: string } };

  it('saves a complete, playable Ogg/Opus recording', async () => {
    const frames = fixture(20);
    const result = await runSimulation({ url, device: 'passport-01', frames, username: 'dev', password: 'x'.repeat(32) });
    assert.equal(result.finish?.type, 'finish_ack');
    const finish = result.finish as { state: string; recording_id: string; duration_ms: number; missing_frames: number };
    assert.equal(finish.state, 'saved');
    assert.equal(finish.missing_frames, 0);
    const file = join(dir, 'data/recordings', `${finish.recording_id}.ogg`);
    const info = probe(file);
    assert.equal(info.streams[0]?.codec_name, 'opus');
    assert.equal(info.streams[0]?.channels, 1);
    const expected = (frames.at(-1)!.index + 1) * 60;
    assert.ok(Math.abs(Number(info.format.duration) * 1000 - expected) <= 60, `duration ${info.format.duration}`);
    execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-']); // decodes without error
    assert.equal(existsSync(`${file}.part`), false);
  });

  it('recovers from 10% packet loss by retransmission and still saves the whole recording', async () => {
    const frames = fixture(10);
    const result = await runSimulation({ url, device: 'passport-01', frames, username: 'dev', password: 'x'.repeat(32),
      dropRate: 0.1, retransmitMs: 500 });
    assert.ok(result.dropped_by_sim > 0, 'the simulator dropped packets');
    assert.equal((result.finish as { state: string }).state, 'saved');
    const meta = JSON.parse(readFileSync(join(dir, 'data/sessions', result.start!.type === 'start_ack'
      ? result.start!.session_id : '', 'meta.json'), 'utf8'));
    assert.equal(meta.frames_persisted, frames.length);
  });

  it('keeps device-side gaps on the timeline and reports partial', async () => {
    const frames = fixture(6).filter((f) => f.index < 30 || f.index >= 40); // 10 frames lost on the device
    const result = await runSimulation({ url, device: 'passport-01', frames, username: 'dev', password: 'x'.repeat(32) });
    const finish = result.finish as { state: string; recording_id: string; missing_frames: number };
    assert.equal(finish.state, 'partial');
    assert.equal(finish.missing_frames, 10);
    const info = probe(join(dir, 'data/recordings', `${finish.recording_id}.ogg`));
    const expected = (frames.at(-1)!.index + 1) * 60;
    assert.ok(Math.abs(Number(info.format.duration) * 1000 - expected) <= 60);
  });
});
