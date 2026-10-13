import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { MockCodexRunner } from '../../src/codex/runner.ts';
import { loadProjects } from '../../src/config.ts';
import { createGatewayServer, NAMESPACE_HEADER } from '../../src/gateway/http.ts';
import { TaskQueue } from '../../src/tasks/queue.ts';
import { TaskStore } from '../../src/tasks/store.ts';
import { NotificationOutbox } from '../../src/notifications/outbox.ts';
import { makeFixture, TEST_TOKEN } from '../helpers.ts';

describe('gateway HTTP', () => {
  const fx = makeFixture();
  const projects = loadProjects(fx.projectsPath);
  const store = new TaskStore(join(fx.dataDir, 'tasks.sqlite'));
  const runner = new MockCodexRunner(10);
  const queue = new TaskQueue({ store, runner, projects, timeoutMs: 5000, maxQueue: 10 });
  const outbox = new NotificationOutbox(':memory:');
  const server = createGatewayServer({ token: TEST_TOKEN, queue, projects, runner, notifications: { namespace: 'ns-a', outbox } });
  let base = '';
  const auth = { authorization: `Bearer ${TEST_TOKEN}`, [NAMESPACE_HEADER]: 'ns-a' };

  before(async () => {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await queue.idle();
    server.close();
    store.close();
    outbox.close();
  });

  it('缺少或错误的 Bearer 令牌返回 401', async () => {
    assert.equal((await fetch(`${base}/internal/health`)).status, 401);
    const wrong = await fetch(`${base}/internal/health`, { headers: { authorization: 'Bearer wrong' } });
    assert.equal(wrong.status, 401);
    assert.deepEqual(Object.keys(await wrong.json()).sort(), ['code', 'ok', 'spoken_summary']);
  });

  it('拒绝带 Origin 的浏览器请求', async () => {
    const res = await fetch(`${base}/internal/health`, { headers: { ...auth, origin: 'http://evil.example' } });
    assert.equal(res.status, 401);
  });

  it('T01/ping：健康检查不泄露账号或路径', async () => {
    const body = await (await fetch(`${base}/internal/health`, { headers: auth })).json();
    assert.deepEqual(body, { ok: true, bridge_version: '0.1.0', gateway_status: 'online', codex_ready: true });
  });

  it('T04：项目列表只含别名，不含物理路径', async () => {
    const text = await (await fetch(`${base}/internal/projects`, { headers: auth })).text();
    assert.deepEqual(JSON.parse(text).projects, [
      { project_id: 'demo', display_name: '演示项目', writable: false },
      { project_id: 'desk', display_name: '桌面工作区', writable: true },
    ]);
    assert.ok(!text.includes(fx.workspace));
    assert.ok(!text.includes('/'));
  });

  it('缺少接入点身份时拒绝业务接口', async () => {
    const res = await fetch(`${base}/internal/projects`, { headers: { authorization: auth.authorization } });
    assert.equal(res.status, 401);
  });

  it('提交、查询最新、取消已结束任务', async () => {
    const submit = await fetch(`${base}/internal/tasks`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: 'demo', instruction: '概括模块', kind: 'submit' }),
    });
    assert.equal(submit.status, 202);
    const { task_id } = await submit.json();
    await queue.idle();
    const latest = await (await fetch(`${base}/internal/tasks/latest`, { headers: auth })).json();
    assert.equal(latest.task_id, task_id);
    assert.equal(latest.status, 'succeeded');
    const cancel = await (await fetch(`${base}/internal/tasks/${task_id}/cancel`, { method: 'POST', headers: auth })).json();
    assert.equal(cancel.requested, false);
  });

  it('非法请求体返回 INVALID_REQUEST', async () => {
    const res = await fetch(`${base}/internal/tasks`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: 'demo', instruction: '', kind: 'submit' }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'INVALID_REQUEST');
  });

  it('通知批次按身份隔离，返回准确终态任务而不误查最新排队任务', async () => {
    const now = Date.now();
    const completed = store.insert({namespace: 'ns-a', projectId: 'desk', kind: 'submit', instruction: '通知测试', clientRequestId: null}, now);
    store.transition(completed.id, ['queued'], 'succeeded', {spoken_summary: '文件已生成'}, now);
    store.insert({namespace: 'ns-a', projectId: 'desk', kind: 'submit', instruction: '较新任务', clientRequestId: null}, now + 1);
    outbox.discover('ns-a', `T-${completed.id}`, now, now);
    const hint = outbox.due(now)[0]!;
    outbox.sent(hint.event_id, now);
    const foreign = await (await fetch(`${base}/internal/notifications/pending`, {headers: {...auth, [NAMESPACE_HEADER]: 'ns-b'}})).json();
    assert.deepEqual(foreign.tasks, []);
    assert.equal(outbox.queryServed().length, 0);
    const body = await (await fetch(`${base}/internal/notifications/pending`, {headers: auth})).json();
    assert.equal(body.batch_id, hint.event_id);
    assert.equal(body.tasks.length, 1);
    assert.equal(body.tasks[0].task_id, `T-${completed.id}`);
    assert.equal(body.tasks[0].status, 'succeeded');
    assert.equal(body.tasks[0].spoken_summary, '文件已生成');
    assert.equal(outbox.queryServed().length, 1);
  });
});
