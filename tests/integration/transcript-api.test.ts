import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { RecordingClient } from '../../src/gateway/recording-client.ts';
import { createGatewayServer, NAMESPACE_HEADER } from '../../src/gateway/http.ts';
import { MockCodexRunner } from '../../src/codex/runner.ts';
import { loadProjects } from '../../src/config.ts';
import { TaskStore } from '../../src/tasks/store.ts';
import { TaskQueue } from '../../src/tasks/queue.ts';
import { makeFixture, TEST_TOKEN } from '../helpers.ts';

const id = 'a'.repeat(32);
const older = 'b'.repeat(32);
const record = (recording_id = id, state = 'done', created_at = '2026-10-13T12:00:00.000Z') => ({
  recording_id, created_at, duration_ms: 130000, state: 'saved',
  transcript: { state, chars: 4, preview: '讨论计划', error: null },
});
const body = (recording_id = id) => ({ recording_id, duration_ms: 130000, language: 'zh', text: '讨论计划', sentences: [] });
const json = (res: ServerResponse, data: unknown, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data));
};
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

let skip: string | false = false;
const probe = createServer();
try { await listen(probe); }
catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
  skip = 'NOT_RUN：沙箱禁止监听回环端口（EPERM）';
} finally { probe.close(); }

describe('录音调用方 HTTP 契约与 Gateway（本地假服务器）', { skip }, () => {
  let handler: (url: string, res: ServerResponse) => void;
  const requests: string[] = [];
  const fakeToken = 'c'.repeat(64);
  const upstream = createServer((req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.headers.authorization, `Bearer ${fakeToken}`);
    requests.push(req.url!);
    handler(req.url!, res);
  });
  let client: RecordingClient;
  let base = '';
  const fx = makeFixture();
  const projects = loadProjects(fx.projectsPath);
  const store = new TaskStore(':memory:');
  const runner = new MockCodexRunner(5);
  const queue = new TaskQueue({ projects, runner, store, timeoutMs: 1000, maxQueue: 10 });
  let gateway: Server;
  let gatewayBase = '';
  const auth = { authorization: `Bearer ${TEST_TOKEN}`, [NAMESPACE_HEADER]: 'voice' };
  before(async () => {
    base = await listen(upstream);
    client = new RecordingClient({ url: base + '/recording-api/v1', token: fakeToken });
    gateway = createGatewayServer({ token: TEST_TOKEN, projects, runner, queue, recording: client });
    gatewayBase = await listen(gateway);
  });
  after(async () => { await queue.idle(); upstream.closeAllConnections(); upstream.close(); gateway?.close(); store.close(); });

  it('缺省跳过最新未完成转写，按时间选最近已完成项', async () => {
    handler = (url, res) => url.includes('?')
      ? json(res, { recordings: [record(id, 'pending'), record(older, 'done', '2026-10-13T11:00:00.000Z')] })
      : json(res, body(older));
    const result = await client.transcript();
    assert.equal(result.recording.recording_id, older);
    assert.ok(requests.includes('/recording-api/v1/recordings?limit=50'));
    assert.ok(requests.includes(`/recording-api/v1/recordings/${older}/transcript`));
  });

  it('处理 401/404/409，拒绝错误响应中的未知字段', async () => {
    for (const [status, data, code] of [
      [401, { error: 'unauthorized' }, 'RECORDING_AUTH_FAILED'],
      [404, { error: 'not_found' }, 'RECORDING_NOT_FOUND'],
      [409, { error: 'transcript_not_ready', state: 'pending' }, 'RECORDING_NOT_READY'],
      [409, { error: 'transcript_failed', state: 'failed' }, 'RECORDING_TRANSCRIPT_FAILED'],
      [409, { error: 'transcript_failed', state: 'pending' }, 'RECORDING_API_INVALID_RESPONSE'],
      [401, { error: 'unauthorized', secret: 'must-not-leak' }, 'RECORDING_API_INVALID_RESPONSE'],
    ] as const) {
      handler = (url, res) => url.endsWith('/transcript') ? json(res, data, status) : json(res, record());
      await assert.rejects(client.transcript(id), { code });
    }
  });

  it('保存失败、尚未转写、转写失败、不完整录音与空列表', async () => {
    for (const [data, code] of [
      [{ ...record(), state: 'failed' }, 'RECORDING_FAILED'],
      [record(id, 'pending'), 'RECORDING_NOT_READY'],
      [record(id, 'failed'), 'RECORDING_TRANSCRIPT_FAILED'],
    ] as const) {
      handler = (_url, res) => json(res, data);
      await assert.rejects(client.transcript(id), { code });
    }
    handler = (_url, res) => json(res, { recordings: [] });
    await assert.rejects(client.transcript(), { code: 'RECORDING_NOT_FOUND' });
    handler = (url, res) => json(res, url.endsWith('/transcript') ? body() : { ...record(), state: 'partial' });
    assert.equal((await client.transcript(id)).recording.state, 'partial');
  });

  it('拒绝成功 JSON 中多字段、错字段及录音身份不匹配', async () => {
    for (const data of [{ recordings: [], extra: 1 }, { recordings: [{ ...record(), duration_ms: 'bad' }] }]) {
      handler = (_url, res) => json(res, data);
      await assert.rejects(client.list(), { code: 'RECORDING_API_INVALID_RESPONSE' });
    }
    handler = (url, res) => json(res, url.endsWith('/transcript') ? body(older) : record());
    await assert.rejects(client.transcript(id), { code: 'RECORDING_API_INVALID_RESPONSE' });
  });

  it('超时覆盖响应体，限制字节数，禁止重定向和非法 JSON', async () => {
    const fast = new RecordingClient({ url: base, token: fakeToken }, { timeoutMs: 30 });
    handler = (_url, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); };
    await assert.rejects(fast.list(), { code: 'RECORDING_API_TIMEOUT' });
    const small = new RecordingClient({ url: base, token: fakeToken }, { maxBytes: 50 });
    handler = (_url, res) => json(res, { recordings: [], padding: 'x'.repeat(100) });
    await assert.rejects(small.list(), { code: 'RECORDING_RESPONSE_TOO_LARGE' });
    handler = (_url, res) => { res.writeHead(302, { location: base + '/target' }); res.end(); };
    const count = requests.length;
    await assert.rejects(client.list(), { code: 'RECORDING_API_UNAVAILABLE' });
    assert.equal(requests.length, count + 1);
    handler = (_url, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{bad'); };
    await assert.rejects(client.list(), { code: 'RECORDING_API_INVALID_RESPONSE' });
  });

  it('Gateway 校验参数和身份，提交到 Mock Codex 后可查任务', async () => {
    handler = (url, res) => json(res, url.endsWith('/transcript') ? body() : record());
    const call = (input: unknown, headers = auth) => fetch(gatewayBase + '/internal/recordings/submit', {
      method: 'POST', headers, body: JSON.stringify(input),
    });
    const input = { project_id: 'demo', instruction: '概括录音', recording_id: id };
    assert.equal((await call(input, { ...auth, authorization: '' })).status, 401);
    assert.equal((await call({ ...input, device_id: 'x' })).status, 400);
    const submitted = await call(input);
    assert.equal(submitted.status, 202);
    const result = await submitted.json();
    assert.match(result.spoken_summary, /已开始/);
    await queue.idle();
    assert.equal(queue.get('voice', result.task_id).status, 'succeeded');
    assert.equal(runner.calls, 1);
  });
});
