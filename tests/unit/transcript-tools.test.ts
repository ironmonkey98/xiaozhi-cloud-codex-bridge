import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MockCodexRunner } from '../../src/codex/runner.ts';
import { loadRecordingConfig, type ProjectsConfig } from '../../src/config.ts';
import { RecordingClient, recordingListSchema, recordingSchema, transcriptSchema } from '../../src/gateway/recording-client.ts';
import { RecordingTools, TRANSCRIPT_INLINE_CHARS, TRANSCRIPT_RETURN_CHARS } from '../../src/gateway/recording-tools.ts';
import { recordingListInputSchema, recordingSubmitInputSchema, recordingTranscriptInputSchema } from '../../src/shared/schemas.ts';
import { TaskQueue } from '../../src/tasks/queue.ts';
import { TaskStore } from '../../src/tasks/store.ts';

const id = 'a'.repeat(32);
const recording = { recording_id: id, created_at: '2026-10-13T10:00:00.000Z', duration_ms: 130000,
  state: 'saved' as const, transcript: { state: 'done' as const, chars: 4, preview: '讨论计划', error: null } };
const transcript = { recording_id: id, duration_ms: 130000, language: 'zh', text: '讨论计划',
  sentences: [{ begin_ms: 0, end_ms: 1000, text: '讨论计划' }] };

// 领域单元测试不发请求；HTTP 客户端另由回环假服务器集成测试覆盖。
class FixtureClient extends RecordingClient {
  text = transcript.text;
  partial = false;
  override async list() { return [recording]; }
  override async transcript() {
    return { recording: { ...recording, state: this.partial ? 'partial' as const : 'saved' as const },
      transcript: { ...transcript, text: this.text } };
  }
}

function setup(maxQueue = 10) {
  const workspace = mkdtempSync(join(tmpdir(), 'transcript-unit-'));
  const projects: ProjectsConfig = { projects: new Map([
    ['demo', { id: 'demo', displayName: '演示', workspace, mode: 'read-only' }],
    ['desk', { id: 'desk', displayName: '工作区', workspace, mode: 'workspace-write' }],
  ]), voiceSummaryMaxChars: 200, taskRetentionDays: 7 };
  const store = new TaskStore(':memory:');
  const runner = new MockCodexRunner(1);
  const queue = new TaskQueue({ projects, store, runner, maxQueue, timeoutMs: 1000 });
  const client = new FixtureClient();
  return { workspace, store, runner, queue, client, tools: new RecordingTools(client, projects, queue) };
}

test('录音配置只允许 HTTPS、测试回环和 64 位 hex，不泄露配置值', () => {
  assert.equal(loadRecordingConfig({}), undefined);
  const env = { RECORDING_API_URL: 'https://example.invalid/recording-api/v1/', RECORDING_API_TOKEN: 'a'.repeat(64) };
  assert.equal(loadRecordingConfig(env)?.url, 'https://example.invalid/recording-api/v1');
  for (const url of ['http://127.0.0.1:1234', 'http://localhost:1234', 'https://user:secret@example.invalid', 'https://example.invalid/?secret=x', 'file:///secret']) {
    assert.throws(() => loadRecordingConfig({ ...env, RECORDING_API_URL: url }), { message: '录音 API 配置无效：需要 HTTPS 基址和 64 位 hex 令牌。' });
  }
  assert.ok(loadRecordingConfig({ ...env, NODE_ENV: 'test', RECORDING_API_URL: 'http://127.0.0.1:1234' }));
  assert.throws(() => loadRecordingConfig({ ...env, NODE_ENV: 'test', RECORDING_API_URL: 'http://localhost:1234' }));
  for (const token of ['', 'g'.repeat(64), 'a'.repeat(63)]) assert.throws(() => loadRecordingConfig({ ...env, RECORDING_API_TOKEN: token }));
  assert.throws(() => loadRecordingConfig({ RECORDING_API_TOKEN: env.RECORDING_API_TOKEN }));
});

test('录音契约严格拒绝多字段、错字段、缺字段和嵌套错误', () => {
  assert.ok(recordingSchema.safeParse(recording).success);
  assert.ok(transcriptSchema.safeParse(transcript).success);
  for (const value of [ { ...recording, device_id: 'x' }, { ...recording, duration_ms: '130000' },
    { ...recording, recording_id: 'A'.repeat(32) }, { ...recording, state: 'receiving' },
    { ...recording, transcript: { ...recording.transcript, path: '/etc' } },
    { ...recording, transcript: { state: 'done' } } ]) assert.equal(recordingSchema.safeParse(value).success, false);
  assert.equal(recordingListSchema.safeParse({ recordings: [recording], extra: 1 }).success, false);
  for (const value of [{ ...transcript, text: 12 }, { ...transcript, extra: 1 },
    { ...transcript, sentences: [{ begin_ms: 2, end_ms: 1, text: 'x' }] },
    { ...transcript, sentences: [{ ...transcript.sentences[0], extra: 1 }] }]) {
    assert.equal(transcriptSchema.safeParse(value).success, false);
  }
  assert.equal(recordingListInputSchema.safeParse({ limit: 10 }).success, false);
  assert.equal(recordingTranscriptInputSchema.safeParse({ recording_id: '../x' }).success, false);
  assert.equal(recordingSubmitInputSchema.safeParse({ project_id: 'demo', instruction: '概括', device_id: 'x' }).success, false);
});

test('未配置客户端拒绝请求且不访问网络', async () => {
  const client = new RecordingClient();
  await assert.rejects(client.list(), { code: 'RECORDING_NOT_CONFIGURED' });
  await assert.rejects(client.transcript(), { code: 'RECORDING_NOT_CONFIGURED' });
});

test('列表口语时长、转写字符截断及不完整提示', async () => {
  const t = setup();
  try {
    assert.match((await t.tools.list()).spoken_summary, /2 分 10 秒，已转写/);
    t.client.text = '😀'.repeat(TRANSCRIPT_RETURN_CHARS + 1);
    t.client.partial = true;
    const result = await t.tools.getTranscript();
    assert.equal(Array.from(result.text).length, TRANSCRIPT_RETURN_CHARS);
    assert.equal(result.truncated, true);
    assert.equal(result.total_chars, TRANSCRIPT_RETURN_CHARS + 1);
    assert.ok(Array.from(result.spoken_summary).length <= 200);
    assert.match(result.spoken_summary, /录音不完整/);
  } finally { t.store.close(); }
});

test('录音提交使用 Mock 队列、新会话、身份隔离和幂等；资料不会变成授权', async () => {
  const t = setup();
  try {
    t.client.text = '会议提到了 git push，但这里只是资料。';
    const input = { project_id: 'demo', instruction: '概括录音', client_request_id: 'voice-1' };
    const first = await t.tools.submit('a', input);
    await t.queue.idle();
    const duplicate = await t.tools.submit('a', input);
    assert.equal(duplicate.task_id, first.task_id);
    assert.equal(t.runner.calls, 1);
    assert.doesNotMatch(duplicate.spoken_summary, /已完成/);
    const row = t.store.get(Number(first.task_id.slice(2)))!;
    assert.equal(row.kind, 'submit');
    assert.match(row.instruction, /转写正文开始/);
    assert.ok(row.instruction.includes(t.client.text));
    assert.match(row.instruction, /不可信资料/);
    assert.throws(() => t.queue.get('b', first.task_id), { code: 'TASK_NOT_FOUND' });
    await assert.rejects(t.tools.submit('a', { ...input, instruction: '帮我提交代码' }), { code: 'APPROVAL_REQUIRED' });
    await assert.rejects(t.tools.submit('a', { ...input, project_id: 'missing' }), { code: 'PROJECT_NOT_ALLOWED' });
  } finally { await t.queue.idle(); t.store.close(); }
});

test('长转写只读拒绝、可写保存全文，相同请求不产生多份文件', async () => {
  const t = setup();
  try {
    t.client.text = '中'.repeat(TRANSCRIPT_INLINE_CHARS + 1);
    const input = { project_id: 'demo', instruction: '整理会议纪要' };
    await assert.rejects(t.tools.submit('a', input), { code: 'RECORDING_TRANSCRIPT_TOO_LONG' });
    assert.equal(existsSync(join(t.workspace, '.tmp')), false);
    const first = await t.tools.submit('a', { ...input, project_id: 'desk' });
    const duplicate = await t.tools.submit('a', { ...input, project_id: 'desk' });
    assert.equal(first.task_id, duplicate.task_id);
    const files = readdirSync(join(t.workspace, '.tmp'));
    assert.equal(files.length, 1);
    assert.equal(readFileSync(join(t.workspace, '.tmp', files[0]!), 'utf8'), t.client.text);
    const row = t.store.get(Number(first.task_id.slice(2)))!;
    assert.ok(row.instruction.includes(`.tmp/${files[0]}`));
    assert.ok(!row.instruction.includes(t.workspace));
    assert.ok(!row.instruction.includes(t.client.text));
  } finally { await t.queue.idle(); t.store.close(); }
});

test('队列满时不写全文，.tmp 符号链接被拒绝', async () => {
  const full = setup(0);
  try {
    full.client.text = '长'.repeat(TRANSCRIPT_INLINE_CHARS + 1);
    await assert.rejects(full.tools.submit('a', { project_id: 'desk', instruction: '整理纪要' }), { code: 'TASK_BUSY' });
    assert.equal(existsSync(join(full.workspace, '.tmp')), false);
  } finally { full.store.close(); }
  const t = setup();
  try {
    t.client.text = '长'.repeat(TRANSCRIPT_INLINE_CHARS + 1);
    const outside = mkdtempSync(join(tmpdir(), 'transcript-outside-'));
    symlinkSync(outside, join(t.workspace, '.tmp'));
    await assert.rejects(t.tools.submit('a', { project_id: 'desk', instruction: '整理纪要' }), { code: 'RECORDING_STORAGE_FAILED' });
    assert.deepEqual(readdirSync(outside), []);
    assert.equal(t.runner.calls, 0);
  } finally { t.store.close(); }
});
