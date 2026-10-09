import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { MockCodexRunner } from '../../src/codex/runner.ts';
import { loadProjects } from '../../src/config.ts';
import { BridgeError } from '../../src/shared/errors.ts';
import { TaskQueue } from '../../src/tasks/queue.ts';
import { TaskStore } from '../../src/tasks/store.ts';
import { makeFixture, waitFor } from '../helpers.ts';

function setup(opts: { delayMs?: number; fail?: boolean; timeoutMs?: number; maxQueue?: number } = {}) {
  const fx = makeFixture();
  const store = new TaskStore(join(fx.dataDir, 'tasks.sqlite'));
  const runner = new MockCodexRunner(opts.delayMs ?? 20, opts.fail ?? false);
  const queue = new TaskQueue({
    store,
    runner,
    projects: loadProjects(fx.projectsPath),
    timeoutMs: opts.timeoutMs ?? 5000,
    maxQueue: opts.maxQueue ?? 10,
  });
  return { fx, store, runner, queue };
}

const NS = 'ns-a';

function errorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof BridgeError) return err.code;
    throw err;
  }
  return 'NO_ERROR';
}

describe('TaskQueue（Mock Codex）', () => {
  it('T05/T06：立即受理，完成后可通过最新任务查询中文摘要', async () => {
    const { queue } = setup();
    const res = queue.submit(NS, { project_id: 'demo', instruction: '概括模块职责' }, 'submit');
    assert.equal(res.accepted, true);
    assert.equal(res.status, 'queued');
    assert.match(res.task_id, /^T-\d+$/);
    assert.notEqual(queue.latest(NS).status, 'succeeded'); // 绝不在完成前报完成
    await queue.idle();
    const latest = queue.latest(NS);
    assert.equal(latest.task_id, res.task_id);
    assert.equal(latest.status, 'succeeded');
    assert.match(latest.spoken_summary, /模拟分析完成/);
  });

  it('只读项目拒绝写入指令，可写工作区受理同一指令', async () => {
    const { queue, runner } = setup();
    assert.equal(errorCode(() => queue.submit(NS, { project_id: 'demo', instruction: '写一个 hello world 程序' }, 'submit')), 'APPROVAL_REQUIRED');
    const res = queue.submit(NS, { project_id: 'desk', instruction: '写一个 hello world 程序' }, 'submit');
    assert.equal(res.accepted, true);
    await queue.idle();
    assert.equal(runner.calls, 1);
  });

  it('幂等：相同 client_request_id 返回同一任务，Codex 只执行一次', async () => {
    const { queue, runner } = setup();
    const a = queue.submit(NS, { project_id: 'demo', instruction: '分析', client_request_id: 'voice-1' }, 'submit');
    const b = queue.submit(NS, { project_id: 'demo', instruction: '分析', client_request_id: 'voice-1' }, 'submit');
    assert.equal(a.task_id, b.task_id);
    assert.equal(b.deduplicated, true);
    await queue.idle();
    assert.equal(runner.calls, 1);
  });

  it('幂等按接入点隔离：不同 namespace 的相同 request_id 互不覆盖', async () => {
    const { queue, runner } = setup();
    const a = queue.submit('ns-a', { project_id: 'demo', instruction: '分析', client_request_id: 'same' }, 'submit');
    const b = queue.submit('ns-b', { project_id: 'demo', instruction: '分析', client_request_id: 'same' }, 'submit');
    assert.notEqual(a.task_id, b.task_id);
    await queue.idle();
    assert.equal(runner.calls, 2);
  });

  it('无 request_id 时，短窗口内同内容重复提交只执行一次', async () => {
    const { queue, runner } = setup();
    const a = queue.submit(NS, { project_id: 'demo', instruction: '分析结构' }, 'submit');
    const b = queue.submit(NS, { project_id: 'demo', instruction: '分析结构' }, 'submit');
    assert.equal(a.task_id, b.task_id);
    await queue.idle();
    assert.equal(runner.calls, 1);
  });

  it('T08：非白名单项目与越权指令被拒绝，且不启动 Codex', async () => {
    const { queue, runner } = setup();
    assert.equal(errorCode(() => queue.submit(NS, { project_id: 'secret', instruction: '分析' }, 'submit')), 'PROJECT_NOT_ALLOWED');
    assert.equal(errorCode(() => queue.submit(NS, { project_id: 'demo', instruction: '帮我删除 src' }, 'submit')), 'APPROVAL_REQUIRED');
    assert.equal(errorCode(() => queue.submit(NS, { project_id: 'demo', instruction: '读 ~/.ssh' }, 'submit')), 'PATH_NOT_ALLOWED');
    await queue.idle();
    assert.equal(runner.calls, 0);
  });

  it('T07：codex_continue 复用本项目线程，submit 开新线程', async () => {
    const { queue, store } = setup();
    queue.submit(NS, { project_id: 'demo', instruction: '第一问' }, 'submit');
    await queue.idle();
    const first = store.getThread(NS, 'demo');
    assert.ok(first);
    const cont = queue.submit(NS, { project_id: 'demo', instruction: '继续分析测试' }, 'continue');
    await queue.idle();
    assert.equal(store.get(Number(cont.task_id.slice(2)))!.thread_id, first);
    assert.match(queue.latest(NS).spoken_summary, /延续上一轮/);
    queue.submit(NS, { project_id: 'demo', instruction: '新问题' }, 'submit');
    await queue.idle();
    assert.notEqual(store.getThread(NS, 'demo'), first);
  });

  it('任务归属：其他接入点查不到、取消不了', async () => {
    const { queue } = setup();
    const res = queue.submit('ns-a', { project_id: 'demo', instruction: '分析' }, 'submit');
    assert.equal(errorCode(() => queue.get('ns-b', res.task_id)), 'TASK_NOT_FOUND');
    assert.equal(errorCode(() => queue.cancel('ns-b', res.task_id)), 'TASK_NOT_FOUND');
    assert.equal(errorCode(() => queue.latest('ns-b')), 'TASK_NOT_FOUND');
    await queue.idle();
  });

  it('取消排队中的任务：直接 canceled 且不执行', async () => {
    const { queue, runner } = setup({ delayMs: 200 });
    queue.submit(NS, { project_id: 'demo', instruction: '第一个' }, 'submit');
    const second = queue.submit(NS, { project_id: 'demo', instruction: '第二个' }, 'submit');
    const res = queue.cancel(NS, second.task_id);
    assert.equal(res.actual_status, 'canceled');
    await queue.idle();
    assert.equal(runner.calls, 1);
    assert.equal(queue.get(NS, second.task_id).status, 'canceled');
  });

  it('取消运行中的任务：cancel_requested → canceled', async () => {
    const { queue } = setup({ delayMs: 2000 });
    const res = queue.submit(NS, { project_id: 'demo', instruction: '长任务' }, 'submit');
    await waitFor(() => (queue.get(NS, res.task_id).status === 'running' ? true : undefined));
    const cancel = queue.cancel(NS, res.task_id);
    assert.equal(cancel.requested, true);
    assert.equal(cancel.actual_status, 'cancel_requested');
    await queue.idle();
    assert.equal(queue.get(NS, res.task_id).status, 'canceled');
    assert.equal(queue.cancel(NS, res.task_id).requested, false);
  });

  it('超时：timed_out', async () => {
    const { queue } = setup({ delayMs: 2000, timeoutMs: 50 });
    const res = queue.submit(NS, { project_id: 'demo', instruction: '会超时' }, 'submit');
    await queue.idle();
    const view = queue.get(NS, res.task_id);
    assert.equal(view.status, 'timed_out');
    assert.equal(view.error_code, 'TIMED_OUT');
  });

  it('Codex 失败：failed + CODEX_FAILED，播报不含内部错误', async () => {
    const { queue } = setup({ fail: true });
    const res = queue.submit(NS, { project_id: 'demo', instruction: '分析' }, 'submit');
    await queue.idle();
    const view = queue.get(NS, res.task_id);
    assert.equal(view.status, 'failed');
    assert.equal(view.error_code, 'CODEX_FAILED');
    assert.ok(!view.spoken_summary.includes('mock codex failure'));
  });

  it('连接超时提供可理解的播报原因，原始错误和凭据不外传', () => {
    const {queue, store} = setup();
    const row = store.insert({namespace: NS, projectId: 'desk', kind: 'submit', instruction: '测试', clientRequestId: null});
    store.transition(row.id, ['queued'], 'failed', {error_code: 'CODEX_FAILED', detailed_result: 'Reconnecting... 2/5 (request timed out) secret=PRIVATE'});
    const view = queue.get(NS, `T-${row.id}`);
    assert.match(view.spoken_summary, /连接 Codex 服务超时/);
    assert.ok(!view.spoken_summary.includes('PRIVATE'));
    store.close();
  });

  it('队列上限：溢出返回 TASK_BUSY', async () => {
    const { queue } = setup({ delayMs: 100, maxQueue: 2 });
    queue.submit(NS, { project_id: 'demo', instruction: '一' }, 'submit');
    queue.submit(NS, { project_id: 'demo', instruction: '二' }, 'submit');
    assert.equal(errorCode(() => queue.submit(NS, { project_id: 'demo', instruction: '三' }, 'submit')), 'TASK_BUSY');
    await queue.idle();
  });

  it('T10：进程重启后历史任务仍可查询，未完成任务标记中断', async () => {
    const { fx, queue } = setup({ delayMs: 2000 });
    const finished = queue.submit(NS, { project_id: 'demo', instruction: '先完成的任务' }, 'submit');
    const running = queue.submit(NS, { project_id: 'demo', instruction: '会被中断' }, 'submit');
    await waitFor(() => (queue.get(NS, running.task_id).status === 'running' ? true : undefined), 8000);

    // 模拟崩溃后重启：新进程打开同一个数据库文件，旧进程未经正常收尾。
    const reopened = new TaskStore(join(fx.dataDir, 'tasks.sqlite'));
    assert.equal(reopened.markUnfinishedInterrupted('中断'), 1);
    assert.equal(reopened.get(Number(finished.task_id.slice(2)))!.status, 'succeeded');
    const row = reopened.get(Number(running.task_id.slice(2)))!;
    assert.equal(row.status, 'failed');
    assert.equal(row.error_code, 'INTERRUPTED');
    reopened.close();

    queue.abortAll();
    await queue.idle();
  });
});
