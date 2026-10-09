import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { freePort, makeFixture, TEST_TOKEN, waitFor } from '../helpers.ts';

// 合同测试：真实子进程运行编译产物 dist/（与 mcp_pipe.py 启动方式一致）+ Mock Codex 的 gateway。
const ROOT = resolve(import.meta.dirname, '..', '..');

type Payload = Record<string, any>;

describe('MCP stdio 合同（dist/mcp/stdio.js）', () => {
  const fx = makeFixture();
  let port = 0;
  let gateway: ChildProcess;
  let gatewayLog = '';

  const env = (): Record<string, string> => ({
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    LOCAL_BRIDGE_TOKEN: TEST_TOKEN,
    GATEWAY_PORT: String(port),
    BRIDGE_NAMESPACE: 'contract',
    LOG_LEVEL: 'info',
  });

  async function connect(): Promise<{ client: Client; transport: StdioClientTransport }> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(ROOT, 'dist/mcp/stdio.js')],
      env: env(),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'contract-test', version: '0.0.0' });
    await client.connect(transport);
    return { client, transport };
  }

  async function call(client: Client, name: string, args: Payload = {}): Promise<{ isError: boolean; data: Payload }> {
    const res = (await client.callTool({ name, arguments: args })) as Payload;
    const text = res.content[0].text as string;
    return { isError: Boolean(res.isError), data: JSON.parse(text) };
  }

  function startGateway(): void {
    gateway = spawn(process.execPath, [resolve(ROOT, 'dist/gateway/main.js')], {
      cwd: fx.dir,
      env: {
        ...env(),
        CODEX_MOCK: '1',
        CODEX_MOCK_DELAY_MS: '300',
        PROJECTS_CONFIG: fx.projectsPath,
        BRIDGE_DATA_DIR: fx.dataDir,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    gateway.stderr!.on('data', (chunk) => (gatewayLog += chunk));
  }

  before(async () => {
    port = await freePort();
    startGateway();
    await waitFor(() => (gatewayLog.includes('gateway listening') ? true : undefined), 10_000);
  });

  after(() => {
    gateway.kill('SIGTERM');
  });

  it('tools/list 公布 7 个工具，且 schema 中没有 device_id / 路径参数', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      'codex_cancel_task',
      'codex_continue',
      'codex_get_latest_task',
      'codex_get_task',
      'codex_list_projects',
      'codex_ping',
      'codex_submit',
    ]);
    const schemas = JSON.stringify(tools.map((t) => t.inputSchema));
    assert.ok(!/device_id|path|workspace|directory/.test(schemas));
    const submit = tools.find((t) => t.name === 'codex_submit')!;
    assert.deepEqual((submit.inputSchema.required as string[]).sort(), ['instruction', 'project_id']);
    await client.close();
  });

  it('T03/T04：ping 与项目列表', async () => {
    const { client } = await connect();
    const ping = await call(client, 'codex_ping');
    assert.equal(ping.isError, false);
    assert.equal(ping.data.gateway_status, 'online');
    assert.match(ping.data.spoken_summary, /电脑已连接/);
    const list = await call(client, 'codex_list_projects');
    assert.equal(list.data.projects.length, 2);
    assert.match(list.data.spoken_summary, /演示项目、桌面工作区（可写）/);
    await client.close();
  });

  it('T08：输入校验与越权拒绝以 isError 返回中文播报', async () => {
    const { client } = await connect();
    const denied = await call(client, 'codex_submit', { project_id: 'demo', instruction: '帮我删除所有文件' });
    assert.equal(denied.isError, true);
    assert.equal(denied.data.code, 'APPROVAL_REQUIRED');
    const notAllowed = await call(client, 'codex_submit', { project_id: 'nope', instruction: '分析' });
    assert.equal(notAllowed.data.code, 'PROJECT_NOT_ALLOWED');
    const invalid = (await client.callTool({ name: 'codex_submit', arguments: { project_id: 'demo' } })) as Payload;
    assert.equal(invalid.isError, true);
    await client.close();
  });

  it('T06/T07/T10：提交立即返回 → 适配器重启 → 仍可查询结果并续话', async () => {
    let { client, transport } = await connect();
    const started = Date.now();
    const submit = await call(client, 'codex_submit', {
      project_id: 'demo',
      instruction: '概括模块职责',
      client_request_id: 'voice-001',
    });
    assert.ok(Date.now() - started < 2000, '提交须在 2 秒内返回');
    assert.equal(submit.data.status, 'queued');
    const dup = await call(client, 'codex_submit', {
      project_id: 'demo',
      instruction: '概括模块职责',
      client_request_id: 'voice-001',
    });
    assert.equal(dup.data.task_id, submit.data.task_id);

    // 模拟 mcp_pipe 断线重连：杀掉 stdio 适配进程，gateway 中的任务不受影响。
    await transport.close();
    ({ client, transport } = await connect());

    const done = await waitFor(async () => {
      const latest = await call(client, 'codex_get_latest_task');
      return latest.data.status === 'succeeded' ? latest : undefined;
    }, 10_000);
    assert.equal(done.data.task_id, submit.data.task_id);
    assert.match(done.data.spoken_summary, /模拟分析完成/);

    const cont = await call(client, 'codex_continue', { project_id: 'demo', instruction: '继续分析测试模块' });
    const contDone = await waitFor(async () => {
      const r = await call(client, 'codex_get_task', { task_id: cont.data.task_id });
      return r.data.status === 'succeeded' ? r : undefined;
    }, 10_000);
    assert.match(contDone.data.spoken_summary, /延续上一轮/);
    await client.close();
  });

  it('取消运行中任务', async () => {
    const { client } = await connect();
    const submit = await call(client, 'codex_submit', { project_id: 'demo', instruction: '会被取消的任务' });
    await waitFor(async () => {
      const r = await call(client, 'codex_get_task', { task_id: submit.data.task_id });
      return r.data.status === 'running' ? true : undefined;
    });
    const cancel = await call(client, 'codex_cancel_task', { task_id: submit.data.task_id });
    assert.equal(cancel.data.requested, true);
    const final = await waitFor(async () => {
      const r = await call(client, 'codex_get_task', { task_id: submit.data.task_id });
      return r.data.status === 'canceled' ? r : undefined;
    });
    assert.equal(final.data.status, 'canceled');
    await client.close();
  });

  it('T11：gateway 日志中不含令牌与家目录', () => {
    assert.ok(!gatewayLog.includes(TEST_TOKEN));
    if (process.env.HOME) assert.ok(!gatewayLog.includes(process.env.HOME));
  });

  it('gateway 停止时，工具返回 NOT_READY 而不是崩溃', async () => {
    gateway.kill('SIGTERM');
    await new Promise((r) => gateway.once('exit', r));
    const { client } = await connect();
    const ping = await call(client, 'codex_ping');
    assert.equal(ping.isError, true);
    assert.equal(ping.data.code, 'NOT_READY');
    await client.close();
  });
});
