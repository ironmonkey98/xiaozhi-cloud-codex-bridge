import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { resolveWorkspace } from './security/path.ts';

const projectSchema = z.object({
  project_id: z.string().regex(/^[a-z0-9_-]{1,32}$/, 'project_id 只能包含小写字母、数字、下划线和连字符'),
  display_name: z.string().min(1).max(32),
  workspace: z.string().min(1),
  // danger-full-access 永不允许配置；workspace-write 只能写该工作区本身（见 ADR 0002）。
  mode: z.enum(['read-only', 'workspace-write']),
});

const projectsFileSchema = z.object({
  projects: z.array(projectSchema),
  max_concurrent_tasks: z.literal(1).default(1),
  voice_summary_max_chars: z.number().int().min(20).max(200).default(200),
  task_retention_days: z.number().int().min(1).max(365).default(7),
});

export type ProjectMode = 'read-only' | 'workspace-write';

export interface Project {
  id: string;
  displayName: string;
  /** realpath 规范化后的绝对路径，只在本机使用，绝不对外返回。 */
  workspace: string;
  mode: ProjectMode;
}

export interface ProjectsConfig {
  projects: Map<string, Project>;
  voiceSummaryMaxChars: number;
  taskRetentionDays: number;
}

export interface GatewayConfig {
  recording?: RecordingApiConfig;
  host: string;
  port: number;
  token: string;
  dataDir: string;
  projectsPath: string;
  codexMock: boolean;
  taskTimeoutMs: number;
  maxQueue: number;
}

export interface RecordingApiConfig {
  url: string;
  token: string;
}

export function loadRecordingConfig(env: NodeJS.ProcessEnv = process.env): RecordingApiConfig | undefined {
  const url = env.RECORDING_API_URL || '';
  const token = env.RECORDING_API_TOKEN || '';
  if (!url && !token) return undefined;
  try {
    const parsed = new URL(url);
    const testLoopback = env.NODE_ENV === 'test' && parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1';
    if ((parsed.protocol !== 'https:' && !testLoopback) || parsed.username || parsed.password || parsed.search || parsed.hash
      || !/^[a-fA-F0-9]{64}$/.test(token)) throw new Error();
    return { url: parsed.href.replace(/\/$/, ''), token };
  } catch {
    throw new Error('录音 API 配置无效：需要 HTTPS 基址和 64 位 hex 令牌。');
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/** 读取仓库根目录的 .env（若存在）。已存在的环境变量优先，不被覆盖。 */
export function loadDotEnv(path = resolve('.env')): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

export function defaultDataDir(): string {
  return join(homedir(), '.xiaozhi-codex-bridge');
}

export function readToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = env.LOCAL_BRIDGE_TOKEN ?? '';
  if (token.length < 32 || token.startsWith('REPLACE_')) {
    throw new Error('LOCAL_BRIDGE_TOKEN 未设置或少于 32 个字符，请用 `openssl rand -hex 32` 生成');
  }
  return token;
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const host = env.GATEWAY_HOST ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`GATEWAY_HOST 只能是回环地址，当前为 ${host}`);
  }
  const port = Number(env.GATEWAY_PORT ?? 18765);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('GATEWAY_PORT 非法');

  return {
    recording: loadRecordingConfig(env),
    host,
    port,
    token: readToken(env),
    dataDir: resolve(env.BRIDGE_DATA_DIR || defaultDataDir()),
    projectsPath: resolve(env.PROJECTS_CONFIG || './config/projects.json'),
    codexMock: env.CODEX_MOCK === '1',
    taskTimeoutMs: Number(env.CODEX_TASK_TIMEOUT_MS ?? 600_000),
    maxQueue: Number(env.CODEX_MAX_QUEUE ?? 10),
  };
}

export function loadProjects(path: string): ProjectsConfig {
  if (!existsSync(path)) {
    throw new Error(`项目白名单不存在：${path}（可复制 config/projects.example.json）`);
  }
  const parsed = projectsFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const projects = new Map<string, Project>();
  for (const p of parsed.projects) {
    if (projects.has(p.project_id)) throw new Error(`project_id 重复：${p.project_id}`);
    projects.set(p.project_id, {
      id: p.project_id,
      displayName: p.display_name,
      workspace: resolveWorkspace(p.workspace),
      mode: p.mode,
    });
  }
  return {
    projects,
    voiceSummaryMaxChars: parsed.voice_summary_max_chars,
    taskRetentionDays: parsed.task_retention_days,
  };
}
