// 环境自检（T01）：只输出状态，不打印任何令牌、接入点 token 或 Codex 凭据。
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { SdkCodexRunner } from '../src/codex/runner.ts';
import { loadDotEnv, loadGatewayConfig, loadProjects, loadRecordingConfig } from '../src/config.ts';
import { redact } from '../src/security/redact.ts';

type Status = 'OK' | 'WARN' | 'FAIL';
const results: { status: Status; item: string; detail: string }[] = [];
const report = (status: Status, item: string, detail: string) => results.push({ status, item, detail: redact(detail) });

function tryRun(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }).trim();
  } catch {
    return null;
  }
}

const envPath = resolve('.env');
loadDotEnv(envPath);

const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
report(major > 22 || (major === 22 && minor >= 18) ? 'OK' : 'FAIL', 'Node.js', `v${process.versions.node}（需要 ≥22.18）`);

if (!existsSync(envPath)) {
  report('FAIL', '.env', '不存在，请执行 cp .env.example .env 并填写');
} else {
  const mode = statSync(envPath).mode & 0o777;
  report(mode & 0o077 ? 'WARN' : 'OK', '.env 权限', `${mode.toString(8)}（建议 chmod 600 .env）`);
}

try {
  const configured = Boolean(loadRecordingConfig());
  report(configured ? 'OK' : 'WARN', '录音 API', configured ? '已配置' : '未配置');
} catch {
  report('FAIL', '录音 API', '未配置');
}

let config: ReturnType<typeof loadGatewayConfig> | null = null;
try {
  config = loadGatewayConfig();
  report('OK', '本机令牌', `LOCAL_BRIDGE_TOKEN 已设置（${config.token.length} 字符）`);
  report('OK', 'Gateway 监听', `${config.host}:${config.port}（仅回环）`);
  report(config.codexMock ? 'WARN' : 'OK', 'Codex 模式', config.codexMock ? 'Mock（CODEX_MOCK=1）' : '真实 SDK');
} catch (err) {
  report('FAIL', 'Gateway 配置', (err as Error).message);
}

if (config) {
  try {
    const projects = loadProjects(config.projectsPath);
    const ids = [...projects.projects.keys()];
    report(ids.length ? 'OK' : 'WARN', '项目白名单', ids.length ? `已允许：${ids.join(', ')}` : '白名单为空');
  } catch (err) {
    report('FAIL', '项目白名单', (err as Error).message);
  }

  try {
    const res = await fetch(`http://127.0.0.1:${config.port}/internal/health`, {
      headers: { authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(3000),
    });
    const body = (await res.json()) as { gateway_status?: string; codex_ready?: boolean };
    report(res.ok ? 'OK' : 'FAIL', 'Gateway 运行', res.ok ? `在线，codex_ready=${body.codex_ready}` : `HTTP ${res.status}`);
  } catch {
    report('WARN', 'Gateway 运行', '未运行（npm run start:daemon 启动）');
  }
}

const systemCodex = tryRun('codex', ['--version']);
report(systemCodex ? 'OK' : 'WARN', 'Codex CLI（PATH）', systemCodex ?? '未在 PATH 中找到（SDK 使用自带二进制，仍可运行）');
report((await new SdkCodexRunner().ready()) ? 'OK' : 'FAIL', 'Codex 登录', '通过 SDK 自带 codex 执行 login status');

const python = tryRun('python3', ['--version']);
report(python ? 'OK' : 'FAIL', 'Python（mcp_pipe）', python ?? '未找到 python3');
const pipePath = resolve('external/mcp-calculator/mcp_pipe.py');
report(existsSync(pipePath) ? 'OK' : 'WARN', 'mcp_pipe.py', existsSync(pipePath) ? '已就绪' : '未安装，执行 npm run setup:pipe');

const endpoint = process.env.XIAOZHI_MCP_ENDPOINT ?? '';
if (!endpoint) {
  report('WARN', '小智接入点', 'XIAOZHI_MCP_ENDPOINT 未设置（真实联调前需要从控制台获取）');
} else {
  try {
    const url = new URL(endpoint);
    report(url.protocol === 'wss:' ? 'OK' : 'FAIL', '小智接入点', `${url.protocol}//${url.host}${url.pathname}（token 已隐藏）`);
  } catch {
    report('FAIL', '小智接入点', 'XIAOZHI_MCP_ENDPOINT 不是合法 URL');
  }
}

for (const r of results) console.log(`[${r.status.padEnd(4)}] ${r.item}：${r.detail}`);
process.exitCode = results.some((r) => r.status === 'FAIL') ? 1 : 0;
