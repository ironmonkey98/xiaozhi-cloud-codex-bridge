import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { startApi } from '../../src/recording/api.ts';
import { DownloadTokens, readTranscriptStatus, Transcriber } from '../../src/recording/transcribe.ts';
import { freePort } from '../helpers.ts';

const TOKEN = 'f'.repeat(64);

function makeSession(dataDir: string, id: string, state: string, createdAt: string, durationMs = 6000) {
  const dir = join(dataDir, 'sessions', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({
    version: 1, session_id: id, device_id: 'passport-01', request_id: 'a'.repeat(32), created_at: createdAt,
    state, result: state === 'receiving' ? null : { ok: state !== 'failed', duration_ms: durationMs, state },
  }));
  if (state === 'saved' || state === 'partial') {
    mkdirSync(join(dataDir, 'recordings'), { recursive: true });
    writeFileSync(join(dataDir, 'recordings', `${id}.ogg`), Buffer.from('OggS fake audio'));
  }
}

/** A fake Bailian: records the submitted file URL and answers like the real API. */
function fakeBailian(opts: { subtaskFails?: boolean } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let submittedFileUrl = '';
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.endsWith('/api/v1/services/audio/asr/transcription')) {
      submittedFileUrl = JSON.parse(String(init?.body)).input.file_urls[0];
      return json({ output: { task_id: 'task-1', task_status: 'PENDING' } });
    }
    if (url.includes('/api/v1/tasks/task-1')) {
      return json({ output: { task_status: 'SUCCEEDED', results: [opts.subtaskFails
        ? { subtask_status: 'FAILED', code: 'FILE_DOWNLOAD_FAILED' }
        : { subtask_status: 'SUCCEEDED', transcription_url: 'https://result.example/r.json' }] } });
    }
    if (url === 'https://result.example/r.json') {
      return json({ transcripts: [{ text: '今天讨论录音功能。', sentences: [
        { begin_time: 0, end_time: 1500, text: '今天讨论', sentence_id: 1 },
        { begin_time: 1500, end_time: 3000, text: '录音功能。', sentence_id: 2 }] }] });
    }
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls, submitted: () => submittedFileUrl };
}

describe('recording transcription', () => {
  it('transcribes saved recordings oldest first through a short-lived download link', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'rec-asr-'));
    makeSession(dataDir, 'b'.repeat(32), 'saved', '2026-10-13T10:00:00.000Z');
    makeSession(dataDir, 'c'.repeat(32), 'receiving', '2026-10-13T09:00:00.000Z');
    const tokens = new DownloadTokens();
    const bailian = fakeBailian();
    const t = new Transcriber({ dataDir, apiKey: 'sk-test-key-0000000000', publicBaseUrl: 'https://host:8443/recording-dl',
      tokens, fetch: bailian.fetchImpl, pollMs: 1 });
    assert.equal(await t.runOnce(), true);
    const dir = join(dataDir, 'sessions', 'b'.repeat(32));
    assert.equal(readTranscriptStatus(dir).state, 'done');
    const transcript = JSON.parse(readFileSync(join(dir, 'transcript.json'), 'utf8'));
    assert.equal(transcript.text, '今天讨论录音功能。');
    assert.deepEqual(transcript.sentences[1], { begin_ms: 1500, end_ms: 3000, text: '录音功能。' });
    assert.match(bailian.submitted(), /^https:\/\/host:8443\/recording-dl\/[a-f0-9]{48}$/);
    // The link is revoked once the transcription finished.
    assert.equal(tokens.resolve(bailian.submitted().split('/').pop()!), null);
    const submit = bailian.calls[0]!;
    assert.equal((submit.init?.headers as Record<string, string>)['X-DashScope-Async'], 'enable');
    assert.equal(JSON.parse(String(submit.init?.body)).model, 'fun-asr');
    assert.equal(await t.runOnce(), false, 'nothing left: receiving sessions are not transcribed');
  });

  it('records failures, retries later and stops after the attempt limit', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'rec-asr-'));
    makeSession(dataDir, 'd'.repeat(32), 'partial', '2026-10-13T10:00:00.000Z');
    let now = 1_000_000;
    const t = new Transcriber({ dataDir, apiKey: 'sk-test-key-0000000000', publicBaseUrl: 'https://h/recording-dl',
      tokens: new DownloadTokens(), fetch: fakeBailian({ subtaskFails: true }).fetchImpl, pollMs: 1,
      now: () => now, maxAttempts: 2, retryDelayMs: 1000 });
    const dir = join(dataDir, 'sessions', 'd'.repeat(32));
    assert.equal(await t.runOnce(), true);
    const first = readTranscriptStatus(dir);
    assert.equal(first.state, 'failed');
    assert.equal(first.error, 'asr failed: FILE_DOWNLOAD_FAILED');
    assert.equal(await t.runOnce(), false, 'waits for retry_after');
    now += 1000;
    assert.equal(await t.runOnce(), true);
    assert.equal(readTranscriptStatus(dir).attempts, 2);
    now += 10_000;
    assert.equal(await t.runOnce(), false, 'attempt limit reached');
  });

  it('expires download tokens', () => {
    let now = 0;
    const tokens = new DownloadTokens(() => now);
    const token = tokens.issue('e'.repeat(32), 1000);
    assert.equal(tokens.resolve(token), 'e'.repeat(32));
    now = 1000;
    assert.equal(tokens.resolve(token), null);
  });
});

describe('recording API', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rec-api-'));
  const tokens = new DownloadTokens();
  makeSession(dataDir, '1'.repeat(32), 'saved', '2026-10-13T10:00:00.000Z', 14520);
  makeSession(dataDir, '2'.repeat(32), 'partial', '2026-10-13T11:00:00.000Z', 3000);
  makeSession(dataDir, '3'.repeat(32), 'receiving', '2026-10-13T12:00:00.000Z');
  makeSession(dataDir, '4'.repeat(32), 'failed', '2026-10-13T09:00:00.000Z');
  const doneDir = join(dataDir, 'sessions', '1'.repeat(32));
  writeFileSync(join(doneDir, 'transcript-state.json'), JSON.stringify({ state: 'done', attempts: 1 }));
  writeFileSync(join(doneDir, 'transcript.json'), JSON.stringify({ recording_id: '1'.repeat(32), duration_ms: 14520,
    language: 'zh', text: '会议要点：上线录音。', sentences: [] }));
  const port = await freePort();
  const server = startApi(port, { dataDir, token: TOKEN, tokens });
  after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  const get = (path: string, token: string | null = TOKEN) =>
    fetch(base + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

  it('requires the bearer token', async () => {
    assert.equal((await get('/recording-api/v1/recordings', null)).status, 401);
    assert.equal((await get('/recording-api/v1/recordings', 'e'.repeat(64))).status, 401);
  });

  it('lists finished recordings newest first with transcript state', async () => {
    const body = await (await get('/recording-api/v1/recordings')).json() as { recordings: Record<string, unknown>[] };
    assert.deepEqual(body.recordings.map((r) => r.recording_id), ['2'.repeat(32), '1'.repeat(32), '4'.repeat(32)]);
    assert.deepEqual(body.recordings[1], { recording_id: '1'.repeat(32), created_at: '2026-10-13T10:00:00.000Z',
      duration_ms: 14520, state: 'saved',
      transcript: { state: 'done', chars: 10, preview: '会议要点：上线录音。', error: null } });
    assert.equal((body.recordings[0]!.transcript as { state: string }).state, 'pending');
    assert.equal((body.recordings[2]!.transcript as { state: string }).state, 'none');
    assert.equal((await get('/recording-api/v1/recordings?limit=0')).status, 400);
  });

  it('returns transcripts, 409 while not ready, 404/400 for unknown or malformed IDs', async () => {
    const t = await (await get(`/recording-api/v1/recordings/${'1'.repeat(32)}/transcript`)).json() as { text: string };
    assert.equal(t.text, '会议要点：上线录音。');
    const pending = await get(`/recording-api/v1/recordings/${'2'.repeat(32)}/transcript`);
    assert.equal(pending.status, 409);
    assert.deepEqual(await pending.json(), { error: 'transcript_not_ready', state: 'pending' });
    assert.equal((await get(`/recording-api/v1/recordings/${'3'.repeat(32)}`)).status, 404, 'still receiving');
    assert.equal((await get(`/recording-api/v1/recordings/${'9'.repeat(32)}`)).status, 404);
    assert.equal((await get('/recording-api/v1/recordings/../etc')).status, 404);
    assert.equal((await get('/recording-api/v1/recordings/XYZ')).status, 400);
  });

  it('serves audio only through a valid download token', async () => {
    const token = tokens.issue('1'.repeat(32), 60_000);
    const res = await fetch(`${base}/recording-dl/${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/ogg');
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'OggS fake audio');
    tokens.revoke(token);
    assert.equal((await fetch(`${base}/recording-dl/${token}`)).status, 404);
    assert.equal((await fetch(`${base}/recording-dl/${'0'.repeat(48)}`)).status, 404);
  });
});
