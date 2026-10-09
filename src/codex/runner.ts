import { execFile } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { Codex, type ThreadOptions } from '@openai/codex-sdk';
import type { ProjectMode } from '../config.ts';
import { isWithin } from '../security/path.ts';

export interface CodexRunRequest {
  workspace: string;
  mode: ProjectMode;
  /** 本桥接此前创建并持久化的线程；null 表示新开线程。 */
  threadId: string | null;
  input: string;
  signal: AbortSignal;
  /** 线程 ID 一旦可知（thread.started）即回调，便于中途持久化。 */
  onThreadId: (threadId: string) => void;
}

export interface CodexRunResult {
  threadId: string;
  finalResponse: string;
}

export interface CodexRunner {
  run(req: CodexRunRequest): Promise<CodexRunResult>;
  /** Codex 可用性（CLI 存在且已登录），不返回任何账号信息。 */
  ready(): Promise<boolean>;
}

/** 不传给 Codex 子进程的环境变量：本桥接自身的密钥。 */
const SECRET_ENV_KEYS = new Set(['LOCAL_BRIDGE_TOKEN', 'XIAOZHI_MCP_ENDPOINT', 'MCP_ENDPOINT']);

function codexChildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !SECRET_ENV_KEYS.has(key)) env[key] = value;
  }
  return env;
}

function workspaceToolEnv(workspace: string): Record<string, string> {
  const cache = join(workspace, '.cache');
  const temp = join(workspace, '.tmp');
  for (const dir of [cache, temp]) {
    mkdirSync(dir, { recursive: true });
    if (!isWithin(realpathSync(workspace), realpathSync(dir))) throw new Error('项目缓存或临时目录指向工作区外');
  }
  return {
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    XDG_CACHE_HOME: cache,
    XDG_CONFIG_HOME: join(workspace, '.local', 'config'),
    XDG_DATA_HOME: join(workspace, '.local', 'share'),
    NPM_CONFIG_CACHE: join(cache, 'npm'),
    NPM_CONFIG_PREFIX: join(workspace, '.local', 'npm'),
    PIP_CACHE_DIR: join(cache, 'pip'),
    PIP_REQUIRE_VIRTUALENV: 'true',
    UV_CACHE_DIR: join(cache, 'uv'),
    PYTHONPYCACHEPREFIX: join(cache, 'pycache'),
    PLAYWRIGHT_BROWSERS_PATH: join(cache, 'playwright'),
  };
}

/**
 * sandbox 只由项目配置决定：read-only，或仅可写该工作区的 workspace-write。
 * 可写项目允许联网与搜索，依赖与缓存留在工作区；只读项目保持无网络。
 * 不跳过 Git 检查，不提供 danger-full-access。
 */
export function threadOptions(workspace: string, mode: ProjectMode): ThreadOptions {
  return {
    workingDirectory: workspace,
    sandboxMode: mode,
    approvalPolicy: 'never',
    networkAccessEnabled: mode === 'workspace-write',
    webSearchMode: mode === 'workspace-write' ? 'live' : 'disabled',
    skipGitRepoCheck: false,
  };
}

/** SDK 内置的 codex 启动脚本（与 SDK 同版本），用于 `login status` 检测。 */
function bundledCodexBin(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('@openai/codex/package.json')), 'bin', 'codex.js');
}

export class SdkCodexRunner implements CodexRunner {
  private async createCodex(workspace: string, mode: ProjectMode): Promise<Codex> {
    const localEnv = mode === 'workspace-write' ? workspaceToolEnv(workspace) : {};
    const env = { ...codexChildEnv(), ...localEnv };
    // 空表会与已有 MCP 配置合并，不能单独关闭已注册的服务器。
    // 枚举当前项目实际继承的服务器并逐个关闭，确保只有沙箱内的命令执行能力。
    const { stdout } = await promisify(execFile)(process.execPath, [bundledCodexBin(), 'mcp', 'list', '--json'], {
      cwd: workspace,
      env,
      timeout: 10_000,
    });
    const servers: unknown = JSON.parse(stdout);
    if (!Array.isArray(servers) || servers.some((s: unknown) => !s || typeof (s as { name?: unknown }).name !== 'string')) {
      throw new Error('无法核验继承的 MCP 配置');
    }
    // 注入服务器可能不在 config.toml 中，只有 enabled=false 会成为缺少 transport 的无效配置。
    // 完整的禁用占位配置保证解析有效；disabled 状态下 command 不会被执行。
    const disabledMcp = 'mcp_servers={' + servers
      .map((s: { name: string }) => `${JSON.stringify(s.name)}={command="false",enabled=false}`)
      .join(',') + '}';
    return new Codex({
      env,
      // SDK env 是 CLI 进程环境；set 同时确保沙箱命令拿到工作区缓存设置。
      config: mode === 'workspace-write' ? { shell_environment_policy: { set: localEnv } } : undefined,
      // workspace-write 默认也可写 /tmp 和 $TMPDIR；语音项目只授权自己的目录。
      // 覆盖全局附加根目录和 MCP 工具，避免继承用户配置中的额外权限入口。
      configOverrides: [
        'sandbox_workspace_write.writable_roots=[]',
        'sandbox_workspace_write.exclude_slash_tmp=true',
        'sandbox_workspace_write.exclude_tmpdir_env_var=true',
        disabledMcp,
      ],
    });
  }

  async run(req: CodexRunRequest): Promise<CodexRunResult> {
    const options = threadOptions(req.workspace, req.mode);
    const codex = await this.createCodex(req.workspace, req.mode);
    const thread = req.threadId ? codex.resumeThread(req.threadId, options) : codex.startThread(options);
    const { events } = await thread.runStreamed(req.input, { signal: req.signal });

    let threadId = req.threadId;
    let finalResponse = '';
    for await (const event of events) {
      switch (event.type) {
        case 'thread.started':
          threadId = event.thread_id;
          req.onThreadId(event.thread_id);
          break;
        case 'item.completed':
          if (event.item.type === 'agent_message') finalResponse = event.item.text;
          break;
        case 'turn.failed':
          throw new Error(event.error.message);
        case 'error':
          throw new Error(event.message);
      }
    }
    threadId ??= thread.id;
    if (!threadId) throw new Error('Codex 未返回线程 ID');
    return { threadId, finalResponse };
  }

  async ready(): Promise<boolean> {
    try {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [bundledCodexBin(), 'login', 'status'], {
        env: codexChildEnv(),
        timeout: 10_000,
      });
      return /logged in/i.test(stdout + stderr);
    } catch {
      return false;
    }
  }
}

/** 无账号 / CI 使用的 Mock：可控延迟、可取消、计数调用次数。 */
export class MockCodexRunner implements CodexRunner {
  calls = 0;
  private threadSeq = 0;

  private readonly delayMs: number;
  private readonly fail: boolean;

  constructor(delayMs = Number(process.env.CODEX_MOCK_DELAY_MS ?? 200), fail = false) {
    this.delayMs = delayMs;
    this.fail = fail;
  }

  async run(req: CodexRunRequest): Promise<CodexRunResult> {
    this.calls += 1;
    const threadId = req.threadId ?? `mock-thread-${++this.threadSeq}`;
    if (!req.threadId) req.onThreadId(threadId);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, this.delayMs);
      req.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(req.signal.reason ?? new Error('aborted'));
        },
        { once: true },
      );
    });
    if (this.fail) throw new Error('mock codex failure');
    const resumed = req.threadId ? '（延续上一轮）' : '';
    return {
      threadId,
      finalResponse: `模拟分析完成${resumed}：项目包含入口模块和工具模块。\n详细说明：这是 Mock Codex 的输出。`,
    };
  }

  async ready(): Promise<boolean> {
    return true;
  }
}
