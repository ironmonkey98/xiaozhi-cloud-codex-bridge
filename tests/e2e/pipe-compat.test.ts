// 桥接器兼容性：真实 mcp_pipe.py（固定 commit）+ 本地假接入点 + 编译后的 stdio 适配器 + Mock gateway。
// 前置：npm run build && npm run setup:pipe。运行：npm run test:pipe
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { freePort, makeFixture, TEST_TOKEN, waitFor } from '../helpers.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const PYTHON = join(ROOT, 'external/.venv/bin/python');
const PIPE = join(ROOT, 'external/mcp-calculator/mcp_pipe.py');

describe('mcp_pipe.py ↔ stdio 适配器', { skip: !existsSync(PIPE) && '未安装 mcp_pipe（npm run setup:pipe）' }, () => {
  const procs: ChildProcess[] = [];
  after(() => procs.forEach((p) => p.kill('SIGTERM')));

  it('initialize / tools/list / tools/call；云端断线重连后任务仍可查询', { timeout: 90_000 }, async () => {
    const fx = makeFixture();
    const gatewayPort = await freePort();
    const wsPort = await freePort();
    const baseEnv = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      LOCAL_BRIDGE_TOKEN: TEST_TOKEN,
      GATEWAY_PORT: String(gatewayPort),
      BRIDGE_NAMESPACE: 'pipe',
    };

    let gatewayLog = '';
    const gateway = spawn(process.execPath, [join(ROOT, 'dist/gateway/main.js')], {
      cwd: fx.dir,
      env: { ...baseEnv, CODEX_MOCK: '1', CODEX_MOCK_DELAY_MS: '1500', PROJECTS_CONFIG: fx.projectsPath, BRIDGE_DATA_DIR: fx.dataDir },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    procs.push(gateway);
    gateway.stderr!.on('data', (c) => (gatewayLog += c));
    await waitFor(() => (gatewayLog.includes('gateway listening') ? true : undefined), 10_000);

    const events = new Map<string, any>();
    const endpoint = spawn(PYTHON, [join(import.meta.dirname, 'fake_endpoint.py'), String(wsPort)], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    procs.push(endpoint);
    let buf = '';
    endpoint.stdout!.on('data', (c) => {
      buf += c;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const { tag, payload } = JSON.parse(buf.slice(0, nl));
        events.set(tag, payload);
        buf = buf.slice(nl + 1);
      }
    });
    await waitFor(() => events.get('listening'), 10_000);

    const mcpConfig = join(fx.dir, 'mcp_config.json');
    writeFileSync(
      mcpConfig,
      JSON.stringify({ mcpServers: { 'codex-local': { type: 'stdio', command: process.execPath, args: [join(ROOT, 'dist/mcp/stdio.js')] } } }),
    );
    let pipeLog = '';
    const pipe = spawn(PYTHON, ['-u', PIPE], {
      cwd: fx.dir,
      env: { ...baseEnv, MCP_ENDPOINT: `ws://127.0.0.1:${wsPort}/mcp/?token=SECRET-TOKEN-XYZ`, MCP_CONFIG: mcpConfig },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    procs.push(pipe);
    pipe.stdout!.on('data', (c) => (pipeLog += c));
    pipe.stderr!.on('data', (c) => (pipeLog += c));

    const latest = await waitFor(() => events.get('latest'), 60_000);

    const init = events.get('initialize#1');
    assert.equal(init.serverInfo.name, 'xiaozhi-codex-bridge');
    assert.ok(init.protocolVersion, '协商出协议版本');
    assert.equal(events.get('tools').length, 8);
    assert.equal(events.get('submit').status, 'queued');
    assert.ok(events.get('initialize#2'), 'mcp_pipe 已重连');
    assert.equal(latest.task_id, events.get('submit').task_id);
    assert.equal(latest.status, 'succeeded');
    assert.ok(!pipeLog.includes('SECRET-TOKEN-XYZ'), 'mcp_pipe 原始日志不应包含接入点 token');
    console.log(`[pipe] 协商协议版本 ${init.protocolVersion}；重连后查询到 ${latest.task_id}=${latest.status}`);
  });
});
